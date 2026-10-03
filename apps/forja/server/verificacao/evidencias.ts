import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import type { EvidenciaVisual, ResultadoTela } from '../../comum/estados';
import { dimensoesPng } from './navegador';
import { calcularEvidenciaVisual } from './niveis';

export * from './navegador';

/**
 * Evidência visual pelo AGENTE, coleta pelo APP (FJ-026; FJ-030 §3).
 *
 * Desde FJ-030 quem sobe o app e fotografa é o condutor T1 (bloco B7, com o
 * utilitário `scripts/forja-print.mjs`): ele sabe subir o projeto (README,
 * `package.json`, `.env` de dev) melhor que qualquer configuração. O app só
 * COLETA e VALIDA o que ficou em `<exec>/evidencias/`:
 *
 * - `telas.json` = `[{ id, descricao, rota, antes, depois, motivo_sem_antes? }]`
 *   (ou `{ telas, motivo_geral }` quando o agente não conseguiu fotografar);
 * - cada PNG: arquivo regular dentro de `evidencias/` (nada de `..`, caminho
 *   absoluto ou symlink — o agente roda em bypass), assinatura PNG, tamanho
 *   > 0 e dimensões plausíveis;
 * - os `antes/*` têm de ter `mtime` ANTERIOR ao primeiro checkpoint da
 *   execução: é a prova de que foram tirados no `sha_base`, antes de qualquer
 *   edição. Senão a tela fica `antes_suspeito` (não conta como par);
 * - `evidencia_visual` (`completa|parcial|sem_evidencia_visual|nao_se_aplica`)
 *   sai daqui; o relatório e o G2 (FJ-026) seguem iguais.
 *
 * FJ-031: o B7 vai em TODO T1, condicional. Quem não alterou UI escreve
 * `{ "nao_se_aplica": true }` → `nao_se_aplica`; se mesmo assim o diff tocar
 * arquivo de interface (selo `altera_ui`), vira `sem_evidencia_visual` com o
 * motivo "o agente declarou não alterar UI, mas o diff toca <arquivos>".
 *
 * O print continua sendo declaração do agente, por isso a validação cruzada
 * (relatório × telas) e o "aprovar sem prints" do G2 permanecem.
 */

export const ARQUIVO_TELAS = 'telas.json';
export const DIR_EVIDENCIAS = 'evidencias';
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSAO = 20_000;
const MAX_TELAS = 20;
/** Prefixo do `motivo` quando o agente declarou `motivo_geral` e não há "depois". */
export const PREFIXO_MOTIVO_GERAL = 'o agente não conseguiu fotografar: ';

/**
 * Recupera o `motivo_geral` do agente a partir de `execucao.evidencia_visual_motivo`
 * (a aba Evidências o mostra à parte; não há coluna própria — FJ-030 §3).
 * `null` quando o motivo não veio do `telas.json`.
 */
export function motivoGeralDoMotivo(motivo: string | null | undefined): string | null {
  if (!motivo?.startsWith(PREFIXO_MOTIVO_GERAL)) return null;
  return motivo.slice(PREFIXO_MOTIVO_GERAL.length).trim() || null;
}

const EntradaTelaSchema = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/, 'id de tela: letras, dígitos, _ ou -'),
  descricao: z.string().max(300).default(''),
  rota: z.string().max(300).default(''),
  antes: z.string().max(300).nullable().optional(),
  depois: z.string().max(300).nullable().optional(),
  motivo_sem_antes: z.string().max(500).optional(),
});

const TelasJsonSchema = z.union([
  z.array(EntradaTelaSchema),
  z.object({
    telas: z.array(EntradaTelaSchema).default([]),
    motivo_geral: z.string().max(1000).optional(),
    /** FJ-031: "minha implementação não altera UI" (B7 condicional). */
    nao_se_aplica: z.boolean().optional(),
  }),
]);

/** Prefixo do `motivo` quando o agente declarou `nao_se_aplica` e o diff toca UI (FJ-031). */
export const PREFIXO_NAO_SE_APLICA_CONTESTADO = 'o agente declarou não alterar UI, mas ';

/** O que o app sabe da UI da mudança, para contestar um `nao_se_aplica` (FJ-031). */
export interface UiDaMudanca {
  /** Selo `altera_ui` (arquivo de frontend no diff ou `areas` ∋ `ui` no plano). */
  ligado: boolean;
  /** Arquivos do diff que casam o detector de frontend. */
  arquivos: readonly string[];
}

function motivoNaoSeAplicaContestado(arquivos: readonly string[]): string {
  if (arquivos.length === 0) {
    return `${PREFIXO_NAO_SE_APLICA_CONTESTADO}a mudança foi marcada como de interface (altera_ui)`;
  }
  const mostrados = arquivos.slice(0, 5).join(', ');
  const resto = arquivos.length > 5 ? ` e mais ${arquivos.length - 5}` : '';
  return `${PREFIXO_NAO_SE_APLICA_CONTESTADO}o diff toca ${mostrados}${resto}`;
}

export interface ImagemColetada {
  /** Relativo ao diretório da execução (`evidencias/antes/UI1.png`). */
  caminho: string;
  sha256: string;
  tamanho: number;
  largura: number;
  altura: number;
  mtime: string;
}

export interface TelaColetada {
  tela_id: string;
  descricao: string;
  rota: string;
  antes: ImagemColetada | null;
  depois: ImagemColetada | null;
  motivo_sem_antes: string | null;
  /** `antes` com `mtime` depois do primeiro checkpoint: não prova o estado do `sha_base`. */
  antes_suspeito: boolean;
  /** `ok`, `tela_nova` (sem antes, com motivo) ou `nao_encontrada` (ausente/inválido/suspeito). */
  resultado_antes: ResultadoTela;
  resultado_depois: ResultadoTela;
  problemas: string[];
}

export interface ResultadoColeta {
  /** `telas.json` existe. */
  existe: boolean;
  motivo_geral: string | null;
  telas: TelaColetada[];
  /** O agente declarou `nao_se_aplica: true` (não alterou UI, FJ-031). */
  nao_se_aplica: boolean;
  evidencia_visual: EvidenciaVisual;
  motivo: string | null;
  /** Problemas do arquivo como um todo (JSON inválido, telas recusadas). */
  problemas: string[];
}

/** Caminho declarado → absoluto dentro de `<exec>/evidencias/`, ou `null` se escapa. */
export function caminhoContido(dirEvidencias: string, declarado: string): string | null {
  if (!declarado || isAbsolute(declarado) || declarado.includes('\\')) return null;
  const abs = normalize(join(dirEvidencias, declarado));
  const rel = relative(dirEvidencias, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    return null;
  }
  return abs;
}

async function validarImagem(
  dirExec: string,
  declarado: string,
): Promise<{ imagem: ImagemColetada } | { problema: string }> {
  const dirEv = join(dirExec, DIR_EVIDENCIAS);
  const abs = caminhoContido(dirEv, declarado);
  if (!abs) return { problema: `${declarado}: caminho fora de evidencias/` };
  const info = await lstat(abs).catch(() => null);
  if (!info) return { problema: `${declarado}: arquivo não existe` };
  if (!info.isFile()) return { problema: `${declarado}: não é arquivo regular` };
  if (info.size === 0) return { problema: `${declarado}: arquivo vazio` };
  if (info.size > MAX_PNG_BYTES) return { problema: `${declarado}: maior que 20 MB` };
  const buf = await readFile(abs);
  const dims = dimensoesPng(buf);
  if (!dims) return { problema: `${declarado}: não é PNG` };
  if (
    dims.largura < 1 ||
    dims.altura < 1 ||
    dims.largura > MAX_DIMENSAO ||
    dims.altura > MAX_DIMENSAO
  ) {
    return { problema: `${declarado}: dimensões inválidas (${dims.largura}×${dims.altura})` };
  }
  return {
    imagem: {
      caminho: relative(dirExec, abs),
      sha256: createHash('sha256').update(buf).digest('hex'),
      tamanho: info.size,
      largura: dims.largura,
      altura: dims.altura,
      mtime: info.mtime.toISOString(),
    },
  };
}

function semEvidencia(motivo: string, extra: Partial<ResultadoColeta> = {}): ResultadoColeta {
  return {
    existe: false,
    motivo_geral: null,
    telas: [],
    problemas: [],
    nao_se_aplica: false,
    ...extra,
    evidencia_visual: 'sem_evidencia_visual',
    motivo,
  };
}

/**
 * Lê e valida `<dirExec>/evidencias/telas.json`. Nunca lança por conteúdo do
 * agente: tudo vira `problemas`/`evidencia_visual`. `primeiroCheckpointEm` =
 * hora do primeiro commit da execução (`null` = ainda nenhum: nada a provar).
 * `ui` = o que o app sabe da UI da mudança (contesta um `nao_se_aplica`).
 */
export async function coletarEvidencias(
  dirExec: string,
  primeiroCheckpointEm: Date | null,
  ui: UiDaMudanca | null = null,
): Promise<ResultadoColeta> {
  const arquivo = join(dirExec, DIR_EVIDENCIAS, ARQUIVO_TELAS);
  const info = await lstat(arquivo).catch(() => null);
  if (!info) {
    return semEvidencia('o agente não registrou evidências (evidencias/telas.json ausente)');
  }
  if (!info.isFile()) {
    return semEvidencia('evidencias/telas.json não é arquivo regular', { existe: true });
  }
  let bruto: unknown;
  try {
    bruto = JSON.parse(await readFile(arquivo, 'utf8'));
  } catch (e) {
    return semEvidencia(`evidencias/telas.json inválido: ${(e as Error).message.slice(0, 200)}`, {
      existe: true,
    });
  }
  const lido = TelasJsonSchema.safeParse(bruto);
  if (!lido.success) {
    const problemas = lido.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || 'telas.json'}: ${i.message}`);
    return semEvidencia(`evidencias/telas.json fora do formato: ${problemas.join('; ')}`, {
      existe: true,
      problemas,
    });
  }
  const entradas = Array.isArray(lido.data) ? lido.data : lido.data.telas;
  const motivoGeral = Array.isArray(lido.data) ? null : (lido.data.motivo_geral?.trim() ?? null);
  // FJ-031: "não alterei UI" só vale sem telas registradas (com telas, valem as telas).
  if (!Array.isArray(lido.data) && lido.data.nao_se_aplica === true && entradas.length === 0) {
    const base = { existe: true, motivo_geral: motivoGeral, telas: [], problemas: [] };
    if (ui?.ligado) {
      return {
        ...base,
        nao_se_aplica: true,
        evidencia_visual: 'sem_evidencia_visual',
        motivo: motivoNaoSeAplicaContestado(ui.arquivos),
      };
    }
    return { ...base, nao_se_aplica: true, evidencia_visual: 'nao_se_aplica', motivo: null };
  }
  const problemasGerais: string[] = [];
  if (entradas.length > MAX_TELAS) {
    problemasGerais.push(`${entradas.length} telas: só as ${MAX_TELAS} primeiras contam`);
  }

  const telas: TelaColetada[] = [];
  const ids = new Set<string>();
  for (const t of entradas.slice(0, MAX_TELAS)) {
    if (ids.has(t.id)) {
      problemasGerais.push(`tela ${t.id} repetida: vale a primeira`);
      continue;
    }
    ids.add(t.id);
    const problemas: string[] = [];
    let antes: ImagemColetada | null = null;
    let depois: ImagemColetada | null = null;
    if (t.antes) {
      const v = await validarImagem(dirExec, t.antes);
      if ('imagem' in v) antes = v.imagem;
      else problemas.push(`antes: ${v.problema}`);
    }
    if (t.depois) {
      const v = await validarImagem(dirExec, t.depois);
      if ('imagem' in v) depois = v.imagem;
      else problemas.push(`depois: ${v.problema}`);
    }
    const antesSuspeito =
      antes !== null &&
      primeiroCheckpointEm !== null &&
      Date.parse(antes.mtime) >= primeiroCheckpointEm.getTime();
    if (antesSuspeito) {
      problemas.push('antes tirado depois do primeiro checkpoint (não prova o estado do sha_base)');
    }
    const motivoSemAntes = t.motivo_sem_antes?.trim() || null;
    const resultadoAntes: ResultadoTela =
      antes && !antesSuspeito
        ? 'ok'
        : !t.antes && !antes && motivoSemAntes
          ? 'tela_nova'
          : 'nao_encontrada';
    if (!t.antes && !motivoSemAntes) problemas.push('sem antes e sem motivo_sem_antes');
    if (!t.depois) problemas.push('sem depois');
    telas.push({
      tela_id: t.id,
      descricao: t.descricao,
      rota: t.rota,
      antes,
      depois,
      motivo_sem_antes: motivoSemAntes,
      antes_suspeito: antesSuspeito,
      resultado_antes: resultadoAntes,
      resultado_depois: depois ? 'ok' : 'nao_encontrada',
      problemas,
    });
  }

  const base = {
    existe: true,
    motivo_geral: motivoGeral,
    telas,
    problemas: problemasGerais,
    nao_se_aplica: false,
  };
  const algumDepois = telas.some((t) => t.depois !== null);
  if (motivoGeral && !algumDepois) {
    return {
      ...base,
      evidencia_visual: 'sem_evidencia_visual',
      motivo: `${PREFIXO_MOTIVO_GERAL}${motivoGeral}`,
    };
  }
  if (telas.length === 0) {
    return {
      ...base,
      evidencia_visual: 'sem_evidencia_visual',
      motivo: 'nenhuma tela registrada em telas.json',
    };
  }
  const calculo = calcularEvidenciaVisual({
    alteraUi: true,
    pares: telas.map((t) => ({
      tela_id: t.tela_id,
      antes: t.resultado_antes,
      depois: t.resultado_depois,
    })),
  });
  if (calculo.evidencia_visual === 'completa') {
    return { ...base, evidencia_visual: 'completa', motivo: null };
  }
  const detalhes = telas
    .filter((t) => t.problemas.length > 0)
    .map((t) => `${t.tela_id}: ${t.problemas.join(', ')}`);
  return {
    ...base,
    evidencia_visual: algumDepois ? 'parcial' : 'sem_evidencia_visual',
    motivo: [motivoGeral, detalhes.join('; ')].filter(Boolean).join(' — ') || calculo.motivo,
  };
}
