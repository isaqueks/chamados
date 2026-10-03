import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ConfigResolvida } from '../../comum/config-projeto';

/**
 * Valores sensíveis dos `arquivos_locais` copiados para a worktree (05 §8.1,
 * §8.2): `.env`, `config.local.*`… O app os conhece para REDIGIR (eventos,
 * relatório) e para o detector do outbox BLOQUEAR uma nota/mensagem que os cite.
 *
 * Lê linhas `CHAVE=valor` (com `export`, aspas e comentário opcionais). Valores
 * curtos (< 6) ficam de fora: redigir "true" ou "3000" quebraria o texto todo.
 */
export function valoresDeEnv(texto: string): string[] {
  const out = new Set<string>();
  for (const linha of texto.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*(.*)$/.exec(linha);
    if (!m) continue;
    let v = (m[1] ?? '').trim();
    const aspas = /^(['"])(.*)\1\s*(?:#.*)?$/.exec(v);
    if (aspas) v = aspas[2] ?? '';
    else
      v = v
        .replace(/\s+#.*$/, '')
        .replace(/[,;]$/, '')
        .replace(/^["']|["']$/g, '');
    if (v.length >= 6) out.add(v);
  }
  return [...out];
}

export async function valoresDeArquivosLocais(
  config: Pick<ConfigResolvida, 'arquivos_locais'>,
  worktree: string,
): Promise<string[]> {
  const out = new Set<string>();
  for (const a of config.arquivos_locais) {
    const caminho = isAbsolute(a.destino) ? a.destino : join(worktree, a.destino);
    try {
      for (const v of valoresDeEnv(await readFile(caminho, 'utf8'))) out.add(v);
    } catch {
      // Arquivo ausente/binário: nada a registrar.
    }
  }
  return [...out];
}
