import { IsNull } from 'typeorm';
import type { EstadoEtapa, MotivoFimEtapa, PapelAgente, TipoEtapa } from '../../../comum/estados';
import { EtapaSchema, type Etapa } from '../entidades/etapa';
import { SessaoTerminalSchema } from '../entidades/sessao-terminal';
import { ErroEstado, ErroRestricao } from '../erros';
import { novoId } from '../ids';
import type { ObjetoJson } from '../json';
import { RepositorioBase } from './base';

/**
 * Repositório de `etapa` (specs/forja/02 §4.7, invariante I-2).
 *
 * `criar` numera `n` por execução e confere I-2 entre tabelas: uma sessão do
 * Claude não pode estar executando no `-p` e assumida num terminal ao mesmo
 * tempo (o único parcial de cada tabela cobre o resto). Como o banco tem um
 * só escritor e `BancoForja.transacao` serializa, a checagem e a inserção são
 * atômicas.
 */

export interface NovaEtapa {
  execucao_id: string;
  tipo: TipoEtapa;
  ciclo: number;
  papel?: PapelAgente | null;
  contrato?: string | null;
  /** Gerado ANTES do spawn (F-05). Nulo nas etapas do app. */
  session_id?: string | null;
  retomada?: boolean;
  modelo?: string | null;
  esforco?: string | null;
  prompt_versao?: string | null;
  perfil?: ObjetoJson | null;
  versao_cli?: string | null;
  sha_inicio?: string | null;
}

export type PatchEtapa = Partial<
  Omit<Etapa, 'id' | 'execucao_id' | 'n' | 'tipo' | 'estado' | 'criado_em' | 'atualizado_em'>
>;

/** Fecho de uma etapa: estado final + classificação + telemetria do `result`. */
export type FimEtapa = {
  estado: Exclude<EstadoEtapa, 'executando'>;
  motivo_fim: MotivoFimEtapa;
} & Partial<
  Pick<
    Etapa,
    | 'exit_code'
    | 'sinal'
    | 'custo_micro_usd'
    | 'model_usage'
    | 'subagent_stats'
    | 'permission_denials'
    | 'condutor_editou'
    | 'sha_fim'
    | 'comandos'
    | 'telas'
    | 'transcript_path'
    | 'init'
  >
>;

export class RepositorioEtapas extends RepositorioBase {
  async criar(dados: NovaEtapa): Promise<Etapa> {
    const sessao = dados.session_id ?? null;
    if (sessao) {
      const noTerminal = await this.m.findOne(SessaoTerminalSchema, {
        where: { session_id_claude: sessao, tipo: 'assumida', encerrada_em: IsNull() },
      });
      if (noTerminal) {
        throw new ErroRestricao(
          'I-2',
          'sessao_terminal.session_id_claude',
          `a sessão ${sessao} está assumida no terminal ${noTerminal.id}`,
        );
      }
    }
    const n = (await this.maximo('etapa', 'n', { execucao_id: dados.execucao_id })) + 1;
    const agora = this.agora();
    const linha: Etapa = {
      id: novoId(),
      execucao_id: dados.execucao_id,
      n,
      ciclo: dados.ciclo,
      tipo: dados.tipo,
      papel: dados.papel ?? null,
      estado: 'executando',
      motivo_fim: null,
      contrato: dados.contrato ?? null,
      session_id: sessao,
      retomada: dados.retomada ?? false,
      pid: null,
      pgid: null,
      modelo: dados.modelo ?? null,
      esforco: dados.esforco ?? null,
      prompt_versao: dados.prompt_versao ?? null,
      perfil: dados.perfil ?? null,
      versao_cli: dados.versao_cli ?? null,
      init: null,
      inicio: agora,
      fim: null,
      ultimo_evento_em: null,
      exit_code: null,
      sinal: null,
      custo_micro_usd: null,
      model_usage: null,
      subagent_stats: null,
      permission_denials: null,
      condutor_editou: false,
      sha_inicio: dados.sha_inicio ?? null,
      sha_fim: null,
      comandos: null,
      telas: null,
      transcript_path: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(EtapaSchema, linha);
    return linha;
  }

  obter(id: string): Promise<Etapa | null> {
    return this.obterPorId(EtapaSchema, id);
  }

  exigir(id: string): Promise<Etapa> {
    return this.exigirPorId(EtapaSchema, id);
  }

  listar(execucaoId: string): Promise<Etapa[]> {
    return this.m.find(EtapaSchema, { where: { execucao_id: execucaoId }, order: { n: 'ASC' } });
  }

  /** Última etapa da execução (opcionalmente de um tipo). */
  ultima(execucaoId: string, tipo?: TipoEtapa): Promise<Etapa | null> {
    return this.m.findOne(EtapaSchema, {
      where: { execucao_id: execucaoId, ...(tipo ? { tipo } : {}) },
      order: { n: 'DESC' },
    });
  }

  /** Reconciliação do boot (01 §6.7): etapas que estavam rodando quando o app caiu. */
  executando(): Promise<Etapa[]> {
    return this.m.find(EtapaSchema, { where: { estado: 'executando' }, order: { inicio: 'ASC' } });
  }

  /** Gravado logo após o spawn e ANTES de consumir o stream (02 §4.7). */
  async registrarProcesso(id: string, processo: { pid: number; pgid: number }): Promise<void> {
    await this.atualizarPorId(EtapaSchema, id, processo);
  }

  /** Alimenta o aviso "possivelmente travado" (15 min, sem kill). */
  async registrarAtividade(id: string, em: string = this.agora()): Promise<void> {
    await this.atualizarPorId(EtapaSchema, id, { ultimo_evento_em: em });
  }

  async atualizar(id: string, patch: PatchEtapa): Promise<Etapa> {
    await this.atualizarPorId(EtapaSchema, id, patch);
    return this.exigir(id);
  }

  /** Fecha a etapa (uma vez só). Libera a `session_id` para outro processo (I-2). */
  async finalizar(id: string, fim: FimEtapa): Promise<Etapa> {
    const atual = await this.exigir(id);
    if (atual.estado !== 'executando') {
      throw new ErroEstado(`etapa ${id} já foi finalizada (${atual.estado})`);
    }
    await this.atualizarPorId(EtapaSchema, id, { ...fim, fim: this.agora() });
    return this.exigir(id);
  }
}
