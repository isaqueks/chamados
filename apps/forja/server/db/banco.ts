import { AsyncLocalStorage } from 'node:async_hooks';
import type { DataSource, EntityManager } from 'typeorm';
import { traduzirErroBanco } from './erros';
import type { Relogio } from './ids';
import type { ResultadoMigracao } from './data-source';
import { Repositorios } from './repositorios';

/**
 * Porta única de acesso ao SQLite da Forja (specs/forja/02 §1, §5).
 *
 * POR QUE toda operação passa por `transacao()`: o driver `better-sqlite3` do
 * TypeORM usa UMA conexão e UM QueryRunner compartilhado. Duas transações
 * assíncronas intercaladas (o runner gravando etapa enquanto o despachante do
 * outbox grava envio) virariam savepoints uma da outra, e o ROLLBACK de uma
 * desfaria a outra. Aqui as transações são SERIALIZADAS por uma fila de
 * promessas: como o processo é o único escritor (F-17), isso torna cada
 * transação serializável de fato — é o que 02 §5 (I-2) assume quando diz que o
 * cruzamento entre tabelas é checado "na mesma transação".
 *
 * Regras de uso:
 * - Dentro de `fn`, use só os repositórios recebidos; uma chamada aninhada a
 *   `transacao()` no mesmo fluxo assíncrono junta-se à transação corrente (não
 *   trava a fila).
 * - NUNCA aguarde rede, git ou processo dentro de `fn`: a fila inteira para.
 * - Erros de constraint saem traduzidos (`ErroRestricao` com o código da
 *   invariante, `erros.ts`).
 */

interface ContextoTransacao {
  repos: Repositorios;
  ativa: boolean;
}

export interface InfoBanco {
  caminho: string;
  relogio: Relogio;
  migracao: ResultadoMigracao;
}

export class BancoForja {
  readonly caminho: string;
  readonly relogio: Relogio;
  /** Resultado das migrations aplicadas na abertura (para o log do boot). */
  readonly migracao: ResultadoMigracao;
  private fila: Promise<unknown> = Promise.resolve();
  private readonly contexto = new AsyncLocalStorage<ContextoTransacao>();

  constructor(
    readonly ds: DataSource,
    info: InfoBanco,
  ) {
    this.caminho = info.caminho;
    this.relogio = info.relogio;
    this.migracao = info.migracao;
  }

  /** Executa `fn` numa transação exclusiva (ver regras no topo do módulo). */
  transacao<T>(fn: (repos: Repositorios, m: EntityManager) => Promise<T>): Promise<T> {
    const corrente = this.contexto.getStore();
    if (corrente?.ativa) {
      return fn(corrente.repos, corrente.repos.m).catch((e: unknown) => {
        throw traduzirErroBanco(e);
      });
    }
    const executar = (): Promise<T> =>
      this.ds.transaction(async (m) => {
        const ctx: ContextoTransacao = { repos: new Repositorios(m, this.relogio), ativa: true };
        try {
          return await this.contexto.run(ctx, () => fn(ctx.repos, m));
        } finally {
          ctx.ativa = false;
        }
      });
    const resultado = this.fila.then(executar, executar);
    this.fila = resultado.catch(() => undefined);
    return resultado.catch((e: unknown) => {
      throw traduzirErroBanco(e);
    });
  }

  /** Atalho para leituras: mesma fila (a conexão é única), sem semântica extra. */
  ler<T>(fn: (repos: Repositorios) => Promise<T>): Promise<T> {
    return this.transacao((repos) => fn(repos));
  }

  /** Espera a fila esvaziar e fecha a conexão (encerramento do servidor, 01 §3.2). */
  async fechar(): Promise<void> {
    await this.fila;
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
