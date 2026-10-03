import type { EntitySchemaColumnOptions } from 'typeorm';
import type { z } from 'zod';
import { transformadorJson } from '../json';

/**
 * Tipos de coluna das entidades da Forja (specs/forja/02 §1), no mesmo estilo
 * de `packages/db/src/entities/*.ts` (EntitySchema, sem decorators).
 *
 * POR QUE só estes tipos: o SQLite tem poucas afinidades e 02 §1 fixa as
 * convenções — PK `TEXT` UUID v7, timestamps `TEXT` ISO, booleanos `INTEGER`
 * 0/1 (o tipo `boolean` do TypeORM converte true/false ↔ 1/0 no driver
 * sqlite), enums `TEXT`, custo `INTEGER` em micro-USD, JSON `TEXT` validado por
 * zod no transformer. Nenhuma coluna tem `default` nem `createDate`: quem grava
 * os valores (inclusive `criado_em`) é o repositório, e o DDL é da migration
 * escrita à mão (`synchronize: false` sempre).
 */

type Coluna = EntitySchemaColumnOptions;

export const pk = (): Coluna => ({ type: 'text', primary: true });
export const texto = (nullable = false): Coluna => ({ type: 'text', nullable });
export const inteiro = (nullable = false): Coluna => ({ type: 'integer', nullable });
export const real = (nullable = false): Coluna => ({ type: 'real', nullable });
export const booleano = (nullable = false): Coluna => ({ type: 'boolean', nullable });
export const json = (schema: z.ZodType, coluna: string, nullable = false): Coluna => ({
  type: 'text',
  nullable,
  transformer: transformadorJson(schema, coluna),
});

/** `criado_em` + `atualizado_em` (02 §4: presentes em todas as tabelas salvo indicação). */
export const tempo = (): Record<'criado_em' | 'atualizado_em', Coluna> => ({
  criado_em: texto(),
  atualizado_em: texto(),
});

export interface ComTempo {
  criado_em: string;
  atualizado_em: string;
}
