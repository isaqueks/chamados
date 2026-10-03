import { IsNull } from 'typeorm';
import type { TipoSessaoTerminal } from '../../../comum/estados';
import { EtapaSchema } from '../entidades/etapa';
import { SessaoTerminalSchema, type SessaoTerminal } from '../entidades/sessao-terminal';
import { ErroEstado, ErroRestricao } from '../erros';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `sessao_terminal` (specs/forja/02 §4.15, invariante I-2).
 * "Assumir" uma sessão do pipeline é recusado enquanto uma etapa `-p` estiver
 * executando a mesma `session_id` — conferido aqui, na transação que abre o
 * terminal (o lado inverso está em `RepositorioEtapas.criar`).
 */

export interface NovaSessaoTerminal {
  tipo: TipoSessaoTerminal;
  cwd: string;
  /** Obrigatórios em `assumida` (CHECK). */
  execucao_id?: string | null;
  etapa_id?: string | null;
  session_id_claude?: string | null;
  pid?: number | null;
  pgid?: number | null;
}

export class RepositorioSessoesTerminal extends RepositorioBase {
  async abrir(dados: NovaSessaoTerminal): Promise<SessaoTerminal> {
    const sessao = dados.session_id_claude ?? null;
    if (dados.tipo === 'assumida' && sessao) {
      const rodando = await this.m.findOne(EtapaSchema, {
        where: { session_id: sessao, estado: 'executando' },
      });
      if (rodando) {
        throw new ErroRestricao(
          'I-2',
          'etapa.session_id',
          `a sessão ${sessao} está executando na etapa ${rodando.n} — pause antes de assumir`,
        );
      }
    }
    const agora = this.agora();
    const linha: SessaoTerminal = {
      id: novoId(),
      tipo: dados.tipo,
      cwd: dados.cwd,
      execucao_id: dados.execucao_id ?? null,
      etapa_id: dados.etapa_id ?? null,
      session_id_claude: sessao,
      pid: dados.pid ?? null,
      pgid: dados.pgid ?? null,
      aberta_em: agora,
      encerrada_em: null,
      sha_ao_devolver: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(SessaoTerminalSchema, linha);
    return linha;
  }

  obter(id: string): Promise<SessaoTerminal | null> {
    return this.obterPorId(SessaoTerminalSchema, id);
  }

  exigir(id: string): Promise<SessaoTerminal> {
    return this.exigirPorId(SessaoTerminalSchema, id);
  }

  abertas(): Promise<SessaoTerminal[]> {
    return this.m.find(SessaoTerminalSchema, {
      where: { encerrada_em: IsNull() },
      order: { aberta_em: 'ASC' },
    });
  }

  assumidaAbertaDaExecucao(execucaoId: string): Promise<SessaoTerminal | null> {
    return this.m.findOne(SessaoTerminalSchema, {
      where: { execucao_id: execucaoId, tipo: 'assumida', encerrada_em: IsNull() },
    });
  }

  async registrarProcesso(id: string, processo: { pid: number; pgid: number }): Promise<void> {
    await this.atualizarPorId(SessaoTerminalSchema, id, processo);
  }

  /** Fecha o PTY; em "Devolver" grava o commit do app que segue para verificação + revisão. */
  async encerrar(
    id: string,
    opcoes: { sha_ao_devolver?: string | null } = {},
  ): Promise<SessaoTerminal> {
    const s = await this.exigir(id);
    if (s.encerrada_em) throw new ErroEstado(`terminal ${id} já foi encerrado`);
    await this.atualizarPorId(SessaoTerminalSchema, id, {
      encerrada_em: this.agora(),
      sha_ao_devolver: opcoes.sha_ao_devolver ?? null,
    });
    return this.exigir(id);
  }
}
