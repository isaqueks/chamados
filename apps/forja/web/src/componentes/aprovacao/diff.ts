import { parseDiff, type DiffType, type HunkData } from 'react-diff-view';
import type { DiffArquivoDto } from '@comum/dto';

/**
 * Preparação do diff de um arquivo para o `react-diff-view` (specs/forja/06
 * §4.3 aba Diff; decisão M4 de 06 §7 tomada nesta entrega: `react-diff-view`,
 * pelo peso, pelo marcador "visto" por arquivo e pelo tema por tokens).
 *
 * O servidor manda o diff unificado de CADA arquivo em `DiffArquivoDto.patch`;
 * ele pode vir só com os hunks (`@@ …`). O parser exige o cabeçalho `diff --git`
 * — sem ele, falha —, então o cabeçalho é reconstruído do caminho e do status.
 * Puro e testado; erro de parse vira `null` (a UI mostra "diff ilegível" em vez
 * de quebrar a tela de aprovação).
 */

const TIPO_POR_STATUS: Record<DiffArquivoDto['status'], DiffType> = {
  A: 'add',
  M: 'modify',
  D: 'delete',
  R: 'rename',
};

export function prepararPatch(arquivo: DiffArquivoDto): string {
  const patch = arquivo.patch.endsWith('\n') ? arquivo.patch : `${arquivo.patch}\n`;
  if (/^diff --git /m.test(patch.slice(0, 200))) return patch;
  const antes = arquivo.caminho_anterior ?? arquivo.caminho;
  const linhas = [`diff --git a/${antes} b/${arquivo.caminho}`];
  if (arquivo.status === 'A') linhas.push('new file mode 100644');
  if (arquivo.status === 'D') linhas.push('deleted file mode 100644');
  if (arquivo.status === 'R') linhas.push(`rename from ${antes}`, `rename to ${arquivo.caminho}`);
  linhas.push(arquivo.status === 'A' ? '--- /dev/null' : `--- a/${antes}`);
  linhas.push(arquivo.status === 'D' ? '+++ /dev/null' : `+++ b/${arquivo.caminho}`);
  return `${linhas.join('\n')}\n${patch}`;
}

export interface ArquivoAnalisado {
  tipo: DiffType;
  hunks: HunkData[];
}

export function analisarArquivo(arquivo: DiffArquivoDto): ArquivoAnalisado | null {
  if (arquivo.binario) return null;
  if (!arquivo.patch.trim()) return { tipo: TIPO_POR_STATUS[arquivo.status], hunks: [] };
  try {
    const [primeiro] = parseDiff(prepararPatch(arquivo));
    if (!primeiro) return null;
    // O status vem do git no servidor; o parser às vezes rebaixa renomeação com conteúdo para "modify".
    return { tipo: TIPO_POR_STATUS[arquivo.status], hunks: primeiro.hunks };
  } catch {
    return null;
  }
}
