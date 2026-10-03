import { In } from 'typeorm';
import type { EstadoOutbox, PassoOutbox } from '../../../comum/estados';
import { OutboxChamadoSchema, type OutboxChamado } from '../entidades/outbox-chamado';
import { ErroEstado, ErroRestricao } from '../erros';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `outbox_chamado` (specs/forja/02 §4.13, invariante I-4;
 * comportamento em 03 §9). Uma rodada é criada inteira de uma vez (ordem =
 * posição na lista) e executada em ordem: `prontos` devolve, por
 * `(execucao_id, rodada)`, só a CABEÇA — o primeiro passo ainda não
 * `enviado`/`pulado` — e só se ela está `pendente` e vencida. Assim um passo
 * `retido` (Gdeploy) ou `bloqueado` (exige humano) segura os seguintes.
 */

export interface NovoPassoOutbox {
  passo: PassoOutbox;
  /** Default `pendente`; `retido` = aguardando "Publicado em produção"; `pulado` = sem a extensão D-036. */
  estado?: Extract<EstadoOutbox, 'pendente' | 'retido' | 'pulado'>;
  corpo?: string | null;
  corpo_hash?: string | null;
  status_alvo?: string | null;
  motivo?: string | null;
}

const RESOLVIDOS: EstadoOutbox[] = ['enviado', 'pulado'];

export class RepositorioOutbox extends RepositorioBase {
  /** Cria a rodada inteira. Rodada já existente para o passo → `ErroRestricao` I-4. */
  async criarRodada(
    execucaoId: string,
    rodada: number,
    passos: NovoPassoOutbox[],
  ): Promise<OutboxChamado[]> {
    const existentes = await this.listar(execucaoId, { rodada });
    const repetido = passos.find((p) => existentes.some((e) => e.passo === p.passo));
    if (repetido) {
      throw new ErroRestricao(
        'I-4',
        'outbox_chamado.execucao_id, outbox_chamado.passo, outbox_chamado.rodada',
        `o passo ${repetido.passo} já existe na rodada ${rodada}`,
      );
    }
    const base = existentes.reduce((max, e) => Math.max(max, e.ordem + 1), 0);
    const agora = this.agora();
    const linhas = passos.map((p, i): OutboxChamado => ({
      id: novoId(),
      execucao_id: execucaoId,
      passo: p.passo,
      estado: p.estado ?? 'pendente',
      rodada,
      ordem: base + i,
      corpo: p.corpo ?? null,
      corpo_hash: p.corpo_hash ?? null,
      status_alvo: p.status_alvo ?? null,
      motivo: p.motivo ?? null,
      tentativas: 0,
      proxima_em: null,
      ultimo_http: null,
      erro: null,
      id_remoto: null,
      enviado_em: null,
      criado_em: agora,
      atualizado_em: agora,
    }));
    for (const l of linhas) await this.inserir(OutboxChamadoSchema, l);
    return linhas;
  }

  obter(id: string): Promise<OutboxChamado | null> {
    return this.obterPorId(OutboxChamadoSchema, id);
  }

  exigir(id: string): Promise<OutboxChamado> {
    return this.exigirPorId(OutboxChamadoSchema, id);
  }

  listar(execucaoId: string, filtro: { rodada?: number } = {}): Promise<OutboxChamado[]> {
    return this.m.find(OutboxChamadoSchema, {
      where: {
        execucao_id: execucaoId,
        ...(filtro.rodada !== undefined ? { rodada: filtro.rodada } : {}),
      },
      order: { rodada: 'ASC', ordem: 'ASC' },
    });
  }

  /** Cabeças pendentes e vencidas de cada rodada (o despachante envia uma por vez). */
  async prontos(agora: string = this.agora()): Promise<OutboxChamado[]> {
    const abertos = await this.m.find(OutboxChamadoSchema, {
      where: { estado: In(['pendente', 'retido', 'enviando', 'bloqueado']) },
      order: { execucao_id: 'ASC', rodada: 'ASC', ordem: 'ASC' },
    });
    const cabecas = new Map<string, OutboxChamado>();
    for (const l of abertos) {
      const chave = `${l.execucao_id}:${l.rodada}`;
      if (!cabecas.has(chave)) cabecas.set(chave, l);
    }
    return [...cabecas.values()].filter(
      (l) => l.estado === 'pendente' && (l.proxima_em === null || l.proxima_em <= agora),
    );
  }

  /** Passos que estavam `enviando` quando o app caiu: exigem a busca anti-duplicação (07 §9). */
  emEnvio(): Promise<OutboxChamado[]> {
    return this.m.find(OutboxChamadoSchema, { where: { estado: 'enviando' } });
  }

  async marcarEnviando(id: string): Promise<void> {
    const l = await this.exigir(id);
    if (l.estado !== 'pendente')
      throw new ErroEstado(`outbox ${id} não está pendente (${l.estado})`);
    await this.atualizarPorId(OutboxChamadoSchema, id, { estado: 'enviando' });
  }

  async marcarEnviado(
    id: string,
    resultado: { id_remoto?: string | null; ultimo_http?: number | null } = {},
  ): Promise<void> {
    await this.atualizarPorId(OutboxChamadoSchema, id, {
      estado: 'enviado',
      id_remoto: resultado.id_remoto ?? null,
      ultimo_http: resultado.ultimo_http ?? null,
      erro: null,
      enviado_em: this.agora(),
    });
  }

  /** Falha retentável: volta a `pendente` com backoff (`proxima_em` calculado pelo despachante). */
  async registrarFalha(
    id: string,
    falha: { erro: string; proxima_em: string; ultimo_http?: number | null },
  ): Promise<void> {
    await this.atualizarPorId(OutboxChamadoSchema, id, {
      estado: 'pendente',
      erro: falha.erro,
      proxima_em: falha.proxima_em,
      ultimo_http: falha.ultimo_http ?? null,
      tentativas: (() => '"tentativas" + 1') as never,
    });
  }

  /** Exige humano (violação nova do validador, `403`, segredo detectado — 03 §9). */
  async bloquear(id: string, erro: string, ultimoHttp: number | null = null): Promise<void> {
    await this.atualizarPorId(OutboxChamadoSchema, id, {
      estado: 'bloqueado',
      erro,
      ultimo_http: ultimoHttp,
    });
  }

  async mudarEstado(id: string, estado: EstadoOutbox, motivo?: string | null): Promise<void> {
    await this.atualizarPorId(OutboxChamadoSchema, id, {
      estado,
      ...(motivo !== undefined ? { motivo } : {}),
    });
  }

  /** "Publicado em produção" (Gdeploy): `retido` → `pendente`. Devolve quantos liberou. */
  async liberarRetidos(execucaoId: string): Promise<number> {
    const r = await this.m.update(
      OutboxChamadoSchema,
      { execucao_id: execucaoId, estado: 'retido' },
      { estado: 'pendente', atualizado_em: this.agora() },
    );
    return r.affected ?? 0;
  }

  /** A rodada terminou (todos `enviado`/`pulado`)? */
  async rodadaConcluida(execucaoId: string, rodada: number): Promise<boolean> {
    const linhas = await this.listar(execucaoId, { rodada });
    return linhas.length > 0 && linhas.every((l) => RESOLVIDOS.includes(l.estado));
  }
}
