import type { EntityManager, EntitySchema, ObjectLiteral } from 'typeorm';
import { ErroNaoEncontrado } from '../erros';
import type { Relogio } from '../ids';

/**
 * Base dos repositórios (specs/forja/02 §4): funções FINAS por agregado, presas
 * ao `EntityManager` da transação corrente (ver `banco.ts`). Nada de regra de
 * pipeline aqui — transições, gates e ciclos são do domínio (03); o repositório
 * só garante o que é do dado: defaults de 02 §4, numeração (`n`, `versao`,
 * `tentativa`, `ordem`) e as invariantes de 02 §5 que dependem de mais de uma
 * tabela (checadas na MESMA transação que grava).
 */
export abstract class RepositorioBase {
  constructor(
    protected readonly m: EntityManager,
    protected readonly relogio: Relogio,
  ) {}

  protected agora(): string {
    return this.relogio().toISOString();
  }

  /**
   * INSERT de uma linha completa. O cast evita a instanciação de
   * `QueryDeepPartialEntity` sobre os tipos JSON recursivos (TS2589); a forma
   * da linha já foi checada pelo tipo `T` de quem chama.
   */
  protected async inserir<T extends ObjectLiteral>(schema: EntitySchema<T>, linha: T): Promise<T> {
    await this.m.insert(schema, linha as never);
    return linha;
  }

  /** `UPDATE ... WHERE id = ?` com `atualizado_em`; linha inexistente → `ErroNaoEncontrado`. */
  protected async atualizarPorId<T extends ObjectLiteral>(
    schema: EntitySchema<T>,
    id: string,
    patch: Partial<T>,
    comAtualizadoEm = true,
  ): Promise<void> {
    const valores = comAtualizadoEm ? { ...patch, atualizado_em: this.agora() } : { ...patch };
    const r = await this.m
      .createQueryBuilder()
      .update(schema)
      .set(valores as never)
      .where('id = :id', { id })
      .execute();
    if (!r.affected) throw new ErroNaoEncontrado(schema.options.tableName ?? 'linha', id);
  }

  protected async exigirPorId<T extends ObjectLiteral>(
    schema: EntitySchema<T>,
    id: string,
  ): Promise<T> {
    const linha = await this.m.findOne(schema, { where: { id } as never });
    if (!linha) throw new ErroNaoEncontrado(schema.options.tableName ?? 'linha', id);
    return linha;
  }

  protected async obterPorId<T extends ObjectLiteral>(
    schema: EntitySchema<T>,
    id: string,
  ): Promise<T | null> {
    return this.m.findOne(schema, { where: { id } as never });
  }

  /** `MAX(coluna)` com filtro simples (numeração por agregado). */
  protected async maximo(
    tabela: string,
    coluna: string,
    filtro: Record<string, string | number>,
  ): Promise<number> {
    const chaves = Object.keys(filtro);
    const where = chaves.map((c) => `"${c}" = ?`).join(' AND ');
    const linhas = (await this.m.query(
      `SELECT MAX("${coluna}") AS v FROM "${tabela}" WHERE ${where}`,
      chaves.map((c) => filtro[c]),
    )) as { v: number | null }[];
    return linhas[0]?.v ?? 0;
  }
}
