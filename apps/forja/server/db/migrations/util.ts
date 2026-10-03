import type { QueryRunner } from 'typeorm';

/**
 * Apoio às migrations (specs/forja/02 §1): "ao fim, `PRAGMA foreign_key_check`
 * vazio, senão rollback". Chamada no fim do `up` de cada migration, DENTRO da
 * transação dela: se houver órfão, o erro desfaz a migration inteira. É o que
 * protege as futuras migrations que recriam tabela (o SQLite não altera CHECK),
 * que precisam rodar com `foreign_keys = OFF`.
 */
export async function conferirChavesEstrangeiras(qr: QueryRunner): Promise<void> {
  const violacoes = (await qr.query('PRAGMA foreign_key_check')) as {
    table: string;
    rowid: number | null;
    parent: string;
  }[];
  if (violacoes.length > 0) {
    const resumo = violacoes
      .slice(0, 5)
      .map((v) => `${v.table}#${v.rowid ?? '?'} → ${v.parent}`)
      .join(', ');
    throw new Error(`foreign_key_check: ${violacoes.length} violação(ões): ${resumo}`);
  }
}
