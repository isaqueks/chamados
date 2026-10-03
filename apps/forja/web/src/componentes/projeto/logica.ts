import type { AvancadoProjetoDto, ConfigProjetoDto, SistemaCasadoDto } from '@comum/dto';
import { AvancadoProjetoSchema, ConfigProjetoSchema, nomeDaPasta } from '@comum/config-projeto';
import { caminhoLegivel, mensagemLegivel, problemaLegivel } from '../apoio/zod-legivel';

/**
 * Lógica pura do Projeto simplificado (FJ-030 §1 e §5): só nome, pasta,
 * branch, sistemas-alvo e o "Avançado" em texto. Tudo o mais é autodetectado
 * pelo servidor (`projeto_detectar`) e mostrado somente leitura. Validação
 * pelos MESMOS schemas do servidor (`comum/config-projeto.ts`).
 */

export { nomeDaPasta };

/** Erro da pasta do repositório antes de perguntar ao servidor, ou `null`. */
export function problemaPasta(caminho: string): string | null {
  const t = caminho.trim();
  if (!t) return 'informe a pasta do repositório';
  if (!t.startsWith('/')) return 'use o caminho completo (ex.: /home/voce/dev/erp-acme)';
  return null;
}

// ---------------------------------------------------------------------------
// Sistemas-alvo (nota §1: ausente = casamento automático por nome)
// ---------------------------------------------------------------------------

/** O que vai em `config.sistemas`: o id, ou o nome quando o Chamados não expõe id. */
export function chaveSistema(s: SistemaCasadoDto): string {
  return s.sistema_alvo_id ?? s.sistema_nome;
}

/** O casamento automático: sugeridos pelo nome e livres (não mapeados a outro projeto). */
function automaticos(casamento: readonly SistemaCasadoDto[]): string[] {
  return casamento.filter((s) => s.sugerido && !s.outro_projeto).map(chaveSistema);
}

/** Chaves efetivamente ligadas: a lista explícita, ou o casamento automático. */
export function sistemasEfetivos(
  explicitos: readonly string[] | undefined,
  casamento: readonly SistemaCasadoDto[],
): string[] {
  return explicitos ? [...explicitos] : automaticos(casamento);
}

/**
 * Liga/desliga um sistema. Se o resultado for exatamente o casamento
 * automático, volta a `undefined` — o projeto continua "automático" e
 * acompanha sistemas novos que casarem pelo nome.
 */
export function alternarSistema(
  explicitos: readonly string[] | undefined,
  casamento: readonly SistemaCasadoDto[],
  chave: string,
  ligado: boolean,
): string[] | undefined {
  const atual = new Set(sistemasEfetivos(explicitos, casamento));
  if (ligado) atual.add(chave);
  else atual.delete(chave);
  const auto = automaticos(casamento);
  if (auto.length === atual.size && auto.every((x) => atual.has(x))) return undefined;
  // Ordem estável: a do casamento, depois chaves que só existem na config.
  const ordem = casamento.map(chaveSistema);
  const pos = (x: string) => {
    const i = ordem.indexOf(x);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...atual].sort((a, b) => pos(a) - pos(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// "Avançado" em texto (nota §5: editor JSON validado pelo zod)
// ---------------------------------------------------------------------------

export function textoDoAvancado(avancado: AvancadoProjetoDto | undefined): string {
  if (!avancado || Object.keys(avancado).length === 0) return '{}';
  return JSON.stringify(avancado, null, 2);
}

/** Linha e coluna (1-based) de um deslocamento no texto. */
function linhaColuna(texto: string, posicao: number): { linha: number; coluna: number } {
  const antes = texto.slice(0, posicao).split('\n');
  return { linha: antes.length, coluna: (antes[antes.length - 1]?.length ?? 0) + 1 };
}

/** Mensagem do `JSON.parse` com linha:coluna, quando o motor informa a posição. */
export function erroDeJson(texto: string, erro: unknown): string {
  const msg = erro instanceof Error ? erro.message : String(erro);
  const dica = 'confira vírgulas, aspas e chaves.';
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  if (lc) return `JSON inválido na linha ${lc[1]}, coluna ${lc[2]}: ${dica}`;
  const pos = /position (\d+)/i.exec(msg);
  if (pos) {
    const { linha, coluna } = linhaColuna(texto, Number(pos[1]));
    return `JSON inválido na linha ${linha}, coluna ${coluna}: ${dica}`;
  }
  return `JSON inválido: ${dica}`;
}

export type ResultadoAvancado =
  { ok: true; valor: AvancadoProjetoDto | undefined } | { ok: false; erros: string[] };

/**
 * Texto do editor → `avancado` validado. Vazio ou `{}` = sem sobrescritas
 * (`undefined`: o projeto fica 100% automático).
 */
export function analisarAvancado(texto: string): ResultadoAvancado {
  const t = texto.trim();
  if (!t) return { ok: true, valor: undefined };
  let bruto: unknown;
  try {
    bruto = JSON.parse(t);
  } catch (e) {
    return { ok: false, erros: [erroDeJson(t, e)] };
  }
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return { ok: false, erros: ['o Avançado precisa ser um objeto JSON { … }'] };
  }
  const r = AvancadoProjetoSchema.safeParse(bruto);
  if (!r.success) return { ok: false, erros: r.error.issues.map(problemaLegivel) };
  return { ok: true, valor: Object.keys(r.data).length === 0 ? undefined : r.data };
}

// ---------------------------------------------------------------------------
// Formulário → config v2
// ---------------------------------------------------------------------------

export interface FormProjeto {
  nome: string;
  repo_dir: string;
  /** Vazio = autodetectada. */
  branch_destino: string;
  sistemas: string[] | undefined;
  avancado_texto: string;
}

export function formularioDeConfig(c: ConfigProjetoDto | null): FormProjeto {
  return {
    nome: c?.nome ?? '',
    repo_dir: c?.repo_dir ?? '',
    branch_destino: c?.branch_destino ?? '',
    sistemas: c?.sistemas ? [...c.sistemas] : undefined,
    avancado_texto: textoDoAvancado(c?.avancado),
  };
}

const BRANCH_INVALIDA = /(^[-/.])|(\.\.)|([\s~^:?*[\\])|(\/$)|(\.lock$)|(@\{)/;

type CampoBasico = 'nome' | 'repo_dir' | 'branch_destino';

export type ResultadoConfig =
  | { ok: true; config: ConfigProjetoDto }
  | { ok: false; erros: Partial<Record<CampoBasico, string>>; avancado: string[] };

/** Valida o formulário e monta a config v2 pelo `ConfigProjetoSchema` (o servidor valida de novo). */
export function montarConfig(form: FormProjeto): ResultadoConfig {
  const erros: Partial<Record<CampoBasico, string>> = {};
  const pasta = problemaPasta(form.repo_dir);
  if (pasta) erros.repo_dir = pasta;
  const branch = form.branch_destino.trim();
  if (branch && BRANCH_INVALIDA.test(branch)) erros.branch_destino = 'nome de branch inválido';
  const av = analisarAvancado(form.avancado_texto);
  if (pasta || !av.ok) {
    return { ok: false, erros, avancado: av.ok ? [] : av.erros };
  }
  const r = ConfigProjetoSchema.safeParse({
    nome: form.nome.trim() || undefined,
    repo_dir: form.repo_dir,
    ...(branch ? { branch_destino: branch } : {}),
    ...(form.sistemas ? { sistemas: form.sistemas } : {}),
    ...(av.valor ? { avancado: av.valor } : {}),
  });
  if (!r.success) {
    for (const i of r.error.issues) {
      const campo = caminhoLegivel(i.path) as CampoBasico;
      if (campo === 'nome' || campo === 'repo_dir' || campo === 'branch_destino') {
        erros[campo] ??= mensagemLegivel(i);
      }
    }
  }
  if (!r.success || Object.keys(erros).length > 0) return { ok: false, erros, avancado: [] };
  return { ok: true, config: r.data };
}
