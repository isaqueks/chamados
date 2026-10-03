import { In, Not, type FindOptionsWhere } from 'typeorm';
import type { ConfigResolvida } from '../../../comum/config-projeto';
import {
  CLASSE_ESTADO_EXECUCAO,
  estadoAtivo,
  estadoLateral,
  type EstadoExecucao,
  type MotivoEstado,
} from '../../../comum/estados';
import { ExecucaoSchema, type Execucao } from '../entidades/execucao';
import { ErroEstado, ErroRestricao } from '../erros';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `execucao` (specs/forja/02 §4.6, invariantes I-1, I-6, I-9).
 *
 * `criar` numera a `tentativa` e confere I-1 na mesma transação (o índice
 * único parcial é a rede de segurança). `mudarEstado` cuida só da
 * contabilidade do dado — `estado_anterior` dos laterais (I-9), `iniciado_em`,
 * `concluido_em` — e recusa sair de estado terminal; QUAL transição é válida é
 * decisão do domínio (03 §2.4), que chama este repositório depois de decidir.
 */

export interface NovaExecucao {
  conexao_id: string;
  chamado_id: string;
  chamado_cache_id: string;
  projeto_id: string;
  lote_id?: string | null;
  numero: number;
  config_snapshot: ConfigResolvida;
  /** Default: `config_snapshot.repo.branch_destino`. */
  branch_destino?: string;
  /** Default `na_fila` (G0). */
  estado?: EstadoExecucao;
}

/** Campos livres para o domínio. `estado`/`estado_anterior` só via `mudarEstado`. */
export type PatchExecucao = Partial<
  Omit<
    Execucao,
    | 'id'
    | 'conexao_id'
    | 'chamado_id'
    | 'tentativa'
    | 'estado'
    | 'estado_anterior'
    | 'criado_em'
    | 'atualizado_em'
  >
>;

export interface FiltroExecucoes {
  projeto_id?: string;
  conexao_id?: string;
  chamado_id?: string;
  lote_id?: string;
  estados?: EstadoExecucao[];
  /** true = não terminais; false = terminais. */
  ativas?: boolean;
}

export interface OpcoesMudarEstado {
  motivo?: MotivoEstado | null;
  /** Texto curto pt-BR do motivo (02 §4.6). */
  motivo_texto?: string | null;
}

const TERMINAIS = (Object.keys(CLASSE_ESTADO_EXECUCAO) as EstadoExecucao[]).filter(
  (e) => !estadoAtivo(e),
);

export class RepositorioExecucoes extends RepositorioBase {
  async criar(dados: NovaExecucao): Promise<Execucao> {
    const ativa = await this.ativaDoChamado(dados.conexao_id, dados.chamado_id);
    if (ativa) {
      throw new ErroRestricao(
        'I-1',
        'execucao.conexao_id, execucao.chamado_id',
        `o chamado #${dados.numero} já tem uma execução ativa (${ativa.id})`,
      );
    }
    const tentativa =
      (await this.maximo('execucao', 'tentativa', {
        conexao_id: dados.conexao_id,
        chamado_id: dados.chamado_id,
      })) + 1;
    const estado = dados.estado ?? 'na_fila';
    const agora = this.agora();
    const linha: Execucao = {
      id: novoId(),
      conexao_id: dados.conexao_id,
      chamado_id: dados.chamado_id,
      chamado_cache_id: dados.chamado_cache_id,
      projeto_id: dados.projeto_id,
      lote_id: dados.lote_id ?? null,
      numero: dados.numero,
      tentativa,
      estado,
      estado_anterior: null,
      motivo_estado: null,
      motivo_texto: null,
      config_snapshot: dados.config_snapshot,
      branch_destino: dados.branch_destino ?? dados.config_snapshot.repo.branch_destino,
      branch: null,
      worktree_dir: null,
      sha_base: null,
      sha_atual: null,
      sha_verificado: null,
      nivel_verificacao: null,
      ciclo_auto: 0,
      ciclo_total: 0,
      session_id_planejador: null,
      session_id_condutor: null,
      aprovacao_vigente_id: null,
      sha_merge: null,
      selos: null,
      evidencia_visual: null,
      evidencia_visual_motivo: null,
      ia_silenciada_pelo_app: false,
      atribuido_pelo_app: false,
      sentinela: null,
      ultima_mensagem_ciente_id: null,
      custo_micro_usd: 0,
      iniciado_em: estado === 'na_fila' ? null : agora,
      concluido_em: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ExecucaoSchema, linha);
    return linha;
  }

  obter(id: string): Promise<Execucao | null> {
    return this.obterPorId(ExecucaoSchema, id);
  }

  exigir(id: string): Promise<Execucao> {
    return this.exigirPorId(ExecucaoSchema, id);
  }

  /** A execução não terminal do chamado, se houver (I-1 garante no máximo uma). */
  ativaDoChamado(conexaoId: string, chamadoId: string): Promise<Execucao | null> {
    return this.m.findOne(ExecucaoSchema, {
      where: { conexao_id: conexaoId, chamado_id: chamadoId, estado: Not(In(TERMINAIS)) },
    });
  }

  /** Todas as tentativas de um chamado, da mais recente para a mais antiga. */
  tentativas(conexaoId: string, chamadoId: string): Promise<Execucao[]> {
    return this.m.find(ExecucaoSchema, {
      where: { conexao_id: conexaoId, chamado_id: chamadoId },
      order: { tentativa: 'DESC' },
    });
  }

  private where(filtro: FiltroExecucoes): FindOptionsWhere<Execucao> {
    const where: FindOptionsWhere<Execucao> = {};
    if (filtro.projeto_id) where.projeto_id = filtro.projeto_id;
    if (filtro.conexao_id) where.conexao_id = filtro.conexao_id;
    if (filtro.chamado_id) where.chamado_id = filtro.chamado_id;
    if (filtro.lote_id) where.lote_id = filtro.lote_id;
    let estados = filtro.estados;
    if (filtro.ativas !== undefined) {
      const daClasse = (e: EstadoExecucao) => estadoAtivo(e) === filtro.ativas;
      estados = (estados ?? (Object.keys(CLASSE_ESTADO_EXECUCAO) as EstadoExecucao[])).filter(
        daClasse,
      );
    }
    if (estados) where.estado = In(estados);
    return where;
  }

  listar(filtro: FiltroExecucoes = {}): Promise<Execucao[]> {
    return this.m.find(ExecucaoSchema, { where: this.where(filtro), order: { id: 'DESC' } });
  }

  /** Para semáforos de concorrência e contadores da sidebar. */
  contar(filtro: FiltroExecucoes = {}): Promise<number> {
    return this.m.count(ExecucaoSchema, { where: this.where(filtro) });
  }

  /**
   * Grava a transição já decidida pelo domínio. Entrar em lateral guarda o
   * estado de origem em `estado_anterior` (lateral → lateral preserva o
   * original); sair de lateral limpa. Estado terminal não muda nunca: nova
   * tentativa é outra `execucao` (02 §2.1).
   */
  async mudarEstado(
    id: string,
    novo: EstadoExecucao,
    opcoes: OpcoesMudarEstado = {},
  ): Promise<{ anterior: Execucao; atual: Execucao }> {
    const anterior = await this.exigir(id);
    if (!estadoAtivo(anterior.estado)) {
      throw new ErroEstado(`execução ${id} está em estado terminal (${anterior.estado})`);
    }
    const agora = this.agora();
    const estado_anterior = estadoLateral(novo)
      ? estadoLateral(anterior.estado)
        ? anterior.estado_anterior
        : anterior.estado
      : null;
    await this.atualizarPorId(ExecucaoSchema, id, {
      estado: novo,
      estado_anterior,
      motivo_estado: opcoes.motivo ?? null,
      motivo_texto: opcoes.motivo_texto ?? null,
      ...(anterior.iniciado_em === null && novo !== 'na_fila' ? { iniciado_em: agora } : {}),
      ...(!estadoAtivo(novo) ? { concluido_em: agora } : {}),
    });
    return { anterior, atual: await this.exigir(id) };
  }

  async atualizar(id: string, patch: PatchExecucao): Promise<Execucao> {
    await this.atualizarPorId(ExecucaoSchema, id, patch);
    return this.exigir(id);
  }

  /** Soma o custo de uma etapa (micro-USD inteiro, sem float — 02 §1). */
  async somarCusto(id: string, deltaMicroUsd: number): Promise<void> {
    if (!Number.isSafeInteger(deltaMicroUsd) || deltaMicroUsd < 0) {
      throw new RangeError(`custo inválido: ${deltaMicroUsd}`);
    }
    await this.atualizarPorId(ExecucaoSchema, id, {
      custo_micro_usd: (() => `"custo_micro_usd" + ${deltaMicroUsd}`) as never,
    });
  }

  /** Novo ciclo de retrabalho: `ciclo_total` sempre; `ciclo_auto` só se automático (limites 2/5). */
  async incrementarCiclos(id: string, opcoes: { automatico: boolean }): Promise<Execucao> {
    await this.atualizarPorId(ExecucaoSchema, id, {
      ciclo_total: (() => '"ciclo_total" + 1') as never,
      ...(opcoes.automatico ? { ciclo_auto: (() => '"ciclo_auto" + 1') as never } : {}),
    });
    return this.exigir(id);
  }

  /**
   * "Apagar histórico" (02 §1, §9): ação explícita, só de execução terminal;
   * o CASCADE leva etapas, eventos, artefatos, comentários, aprovações, itens
   * de fila, outbox e terminais. Arquivos em disco são de quem chama.
   */
  async apagarHistorico(id: string): Promise<void> {
    const e = await this.exigir(id);
    if (estadoAtivo(e.estado)) {
      throw new ErroEstado(`execução ${id} ainda está ativa (${e.estado})`);
    }
    await this.m.update(ExecucaoSchema, { id }, { aprovacao_vigente_id: null });
    await this.m.delete(ExecucaoSchema, { id });
  }
}
