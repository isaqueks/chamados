/**
 * Fragmentos de DDL das migrations do SQLite (specs/forja/02 §1).
 *
 * POR QUE helpers: as convenções de 02 §1 (enum = `TEXT` + `CHECK IN`, booleano =
 * `INTEGER` + `CHECK IN (0,1)`, JSON = `TEXT` + `CHECK json_valid`) se repetem em
 * dezenas de colunas; escritas à mão elas divergiriam das constantes de
 * `comum/estados.ts`. Os valores dos enums vêm SEMPRE dessas constantes (a mesma
 * fonte do zod e das entidades), nunca de uma lista literal na migration.
 *
 * Nomes de constraint (`ck_<tabela>_<regra>`) aparecem na mensagem do SQLite
 * ("CHECK constraint failed: ck_…"), e é por eles que `erros.ts` identifica a
 * invariante violada.
 */

import { CLASSE_ESTADO_EXECUCAO, type EstadoExecucao } from '../../comum/estados';

function literal(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

/** `'a', 'b', 'c'` para `IN (...)`. */
export function listaSql(valores: readonly string[]): string {
  if (valores.length === 0) throw new Error('listaSql: lista vazia');
  return valores.map(literal).join(', ');
}

/** Valores de um enum-objeto (`const` de `comum/estados.ts`). */
export function valoresDe(obj: Record<string, string>): string[] {
  return Object.values(obj);
}

/** `CONSTRAINT ck_<tabela>_<coluna> CHECK (<coluna> IN (...))`. NULL passa (SQLite). */
export function checkEnum(tabela: string, coluna: string, valores: readonly string[]): string {
  return `CONSTRAINT "ck_${tabela}_${coluna}" CHECK ("${coluna}" IN (${listaSql(valores)}))`;
}

export function checkBool(tabela: string, coluna: string): string {
  return `CONSTRAINT "ck_${tabela}_${coluna}" CHECK ("${coluna}" IN (0, 1))`;
}

export function checkJson(tabela: string, coluna: string): string {
  return `CONSTRAINT "ck_${tabela}_${coluna}_json" CHECK ("${coluna}" IS NULL OR json_valid("${coluna}"))`;
}

export function checkMinimo(tabela: string, coluna: string, minimo: number): string {
  return `CONSTRAINT "ck_${tabela}_${coluna}_min" CHECK ("${coluna}" IS NULL OR "${coluna}" >= ${minimo})`;
}

function estadosDaClasse(classe: string): EstadoExecucao[] {
  return (Object.keys(CLASSE_ESTADO_EXECUCAO) as EstadoExecucao[]).filter(
    (e) => CLASSE_ESTADO_EXECUCAO[e] === classe,
  );
}

/** `'concluido', 'descartado', 'cancelado'` — "execução ativa" = estado fora desta lista (02 §2.1). */
export const SQL_ESTADOS_TERMINAIS = listaSql(estadosDaClasse('terminal'));

/** Laterais: exigem `estado_anterior` (I-9). */
export const SQL_ESTADOS_LATERAIS = listaSql(estadosDaClasse('lateral'));

/** Filtro de execução ativa para índices parciais (I-1, I-6). */
export const SQL_EXECUCAO_ATIVA = `"estado" NOT IN (${SQL_ESTADOS_TERMINAIS})`;

/** Item de fila de merge ainda ativo (I-5). */
export const SQL_ITEM_FILA_ATIVO = `"estado" NOT IN ('concluido', 'devolvido')`;

/** Item de fila em processamento (I-5: no máximo um por fila). */
export const SQL_ITEM_FILA_PROCESSANDO = `"estado" IN ('integrando', 'verificando', 'publicando')`;

/** Aprovação final/reaprovação vigente (I-3). */
export const SQL_APROVACAO_VIGENTE = `"tipo" IN ('final', 'reaprovacao') AND "decisao" IN ('aprovado', 'aprovado_com_edicao') AND "invalidada_em" IS NULL`;

/** Colunas `criado_em`/`atualizado_em` presentes em quase todas as tabelas (02 §4). */
export const COLUNAS_TEMPO = `"criado_em" TEXT NOT NULL,
  "atualizado_em" TEXT NOT NULL`;
