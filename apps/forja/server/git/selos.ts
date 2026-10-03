import { posix } from 'node:path';
import type { Selos } from '../../comum/contratos';
import type { ConfigResolvidaDto, SeloArquivo } from '../../comum/dto';
import { git } from './git';

/**
 * Selos determinísticos por caminho (specs/forja/04 §7.1, 01 §9.2, FJ-026).
 *
 * POR QUE selo é fato do app: o relatório do modelo é cruzado com os selos
 * (04 §7.2) e uma contradição é incoerência. O selo, portanto, não pode vir do
 * modelo — é calculado aqui, sobre a lista de arquivos de `git diff` entre o
 * merge-base e o `sha` (três pontos: `<base>...<sha>`, que é o `merge-base(destino,
 * sha)..sha` de 04 §7.1 e coincide com `sha_base..sha` enquanto o destino não foi
 * integrado na branch), com os globs do projeto (`projeto.detectores`, 02 §4.2).
 *
 * Glob: semântica padrão (`dot: true`, caminho relativo à raiz, sem
 * "matchBase"): `*` não cruza `/`, `**` como segmento inteiro casa zero ou mais
 * diretórios, `?`, `[...]` e `{a,b}`. `package.json` casa só o da raiz;
 * para todos, `**` seguido de `/package.json`. Implementado aqui (≈ 40 linhas) para não puxar
 * dependência nova ao workspace só por isso.
 *
 * `altera_ui` é o único selo que soma uma declaração do plano aos globs
 * (`plano.areas ∋ ui`): mudança de interface feita só por texto ou dado também
 * precisa de prints (FJ-026). `dependencias_novas` (04 §7.1) vem do diff
 * semântico dos `package.json` tocados.
 */

export type Detectores = ConfigResolvidaDto['detectores'];

// ---------------------------------------------------------------------------
// Glob → RegExp
// ---------------------------------------------------------------------------

/** Expande `{a,b}` (inclusive aninhado e múltiplo) numa lista de padrões. */
export function expandirChaves(padrao: string): string[] {
  const inicio = padrao.indexOf('{');
  if (inicio < 0) return [padrao];
  let profundidade = 0;
  for (let i = inicio; i < padrao.length; i++) {
    const c = padrao[i];
    if (c === '{') profundidade++;
    else if (c === '}' && --profundidade === 0) {
      const corpo = padrao.slice(inicio + 1, i);
      const opcoes: string[] = [];
      let nivel = 0;
      let atual = '';
      for (const ch of corpo) {
        if (ch === ',' && nivel === 0) {
          opcoes.push(atual);
          atual = '';
          continue;
        }
        if (ch === '{') nivel++;
        if (ch === '}') nivel--;
        atual += ch;
      }
      opcoes.push(atual);
      const antes = padrao.slice(0, inicio);
      const depois = padrao.slice(i + 1);
      return opcoes.flatMap((o) => expandirChaves(`${antes}${o}${depois}`));
    }
  }
  return [padrao];
}

function segmentoParaRegex(seg: string): string {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const fim = seg.indexOf(']', i + 2);
      if (fim < 0) re += '\\[';
      else {
        let classe = seg.slice(i + 1, fim).replace(/\\/g, '\\\\');
        if (classe.startsWith('!')) classe = `^${classe.slice(1)}`;
        re += `[${classe}]`;
        i = fim;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return re;
}

function padraoUnicoParaRegex(padrao: string): string {
  const segs = padrao.replace(/^\.\//, '').replace(/^\/+/, '').split('/');
  let re = '';
  segs.forEach((seg, i) => {
    const ultimo = i === segs.length - 1;
    if (seg === '**') {
      if (i > 0 && segs[i - 1] === '**') return;
      if (i === 0) re += ultimo ? '.*' : '(?:.*/)?';
      else re += ultimo ? '(?:/.*)?' : '(?:/.*)?/';
      return;
    }
    if (i > 0 && segs[i - 1] !== '**') re += '/';
    re += segmentoParaRegex(seg);
  });
  return re;
}

export function globParaRegex(padrao: string): RegExp {
  const alternativas = expandirChaves(padrao).map(padraoUnicoParaRegex);
  return new RegExp(`^(?:${alternativas.join('|')})$`);
}

/** Algum glob casa o caminho (relativo à raiz, `/` como separador)? */
export function casaAlgum(caminho: string, globs: readonly string[]): boolean {
  const c = caminho.replace(/^\.\//, '');
  return globs.some((g) => globParaRegex(g).test(c));
}

// ---------------------------------------------------------------------------
// Cálculo puro
// ---------------------------------------------------------------------------

export interface ResultadoSelos {
  selos: Selos;
  /** Selos de cada arquivo (tela "Testar detectores" e marcação no diff, 06). */
  por_arquivo: { caminho: string; selos: SeloArquivo[] }[];
}

/**
 * Selos de 04 §7.1 sobre a lista de arquivos alterados. `areasPlano` =
 * `plano.areas` da versão oficial (para `altera_ui`).
 */
export function calcularSelos(
  arquivos: readonly string[],
  detectores: Detectores,
  areasPlano: readonly string[] = [],
): ResultadoSelos {
  const por_arquivo = arquivos.map((caminho) => {
    const selos: SeloArquivo[] = [];
    if (casaAlgum(caminho, detectores.banco)) selos.push('banco');
    if (casaAlgum(caminho, detectores.regra_negocio)) selos.push('regra_negocio');
    if (casaAlgum(caminho, detectores.sensivel)) selos.push('sensivel');
    if (casaAlgum(caminho, detectores.frontend)) selos.push('frontend');
    return { caminho, selos };
  });
  const tem = (s: SeloArquivo) => por_arquivo.some((a) => a.selos.includes(s));
  const docs = detectores.docs_exigidas;
  return {
    selos: {
      altera_banco: tem('banco'),
      altera_regra_negocio: tem('regra_negocio'),
      altera_ui: tem('frontend') || areasPlano.includes('ui'),
      sensivel: por_arquivo.filter((a) => a.selos.includes('sensivel')).map((a) => a.caminho),
      docs_exigidas_ok:
        docs.length === 0 ? null : docs.every((g) => arquivos.some((a) => casaAlgum(a, [g]))),
    },
    por_arquivo,
  };
}

const CAMPOS_DEPENDENCIAS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function nomesDependencias(json: string | null): Set<string> {
  const nomes = new Set<string>();
  if (!json) return nomes;
  let pkg: unknown;
  try {
    pkg = JSON.parse(json);
  } catch {
    return nomes;
  }
  if (typeof pkg !== 'object' || pkg === null) return nomes;
  for (const campo of CAMPOS_DEPENDENCIAS) {
    const deps = (pkg as Record<string, unknown>)[campo];
    if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) nomes.add(n);
  }
  return nomes;
}

/** Pacotes presentes em `depois` e ausentes em `antes` (diff semântico de `package.json`). */
export function diffDependencias(antes: string | null, depois: string | null): string[] {
  const a = nomesDependencias(antes);
  return [...nomesDependencias(depois)].filter((n) => !a.has(n)).sort();
}

// ---------------------------------------------------------------------------
// Sobre o git
// ---------------------------------------------------------------------------

/** `git diff --name-only --no-renames -z <base>...<sha>` (renomeação conta os dois caminhos). */
export async function arquivosAlterados(dir: string, base: string, sha: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--no-renames', '-z', `${base}...${sha}`, '--'], {
    cwd: dir,
  });
  return r.stdout.split('\0').filter(Boolean);
}

async function conteudoEm(dir: string, rev: string, caminho: string): Promise<string | null> {
  const r = await git(['show', `${rev}:${caminho}`], { cwd: dir, aceitar: [0, 128] });
  return r.codigo === 0 ? r.stdout : null;
}

/** Pacotes novos em qualquer `package.json` tocado entre o merge-base e `sha`. */
export async function dependenciasNovas(
  dir: string,
  base: string,
  sha: string,
  arquivos: readonly string[],
): Promise<string[]> {
  const mb = (await git(['merge-base', base, sha], { cwd: dir })).stdout.trim();
  const novas = new Set<string>();
  for (const caminho of arquivos.filter((a) => posix.basename(a) === 'package.json')) {
    const antes = await conteudoEm(dir, mb, caminho);
    const depois = await conteudoEm(dir, sha, caminho);
    for (const n of diffDependencias(antes, depois)) novas.add(n);
  }
  return [...novas].sort();
}

export interface SelosDoDiff extends ResultadoSelos {
  arquivos: string[];
  dependencias_novas: string[];
}

/** Selos completos de uma faixa `<base>...<sha>` (04 §7.1). */
export async function selosDoDiff(entrada: {
  dir: string;
  base: string;
  sha: string;
  detectores: Detectores;
  areasPlano?: readonly string[];
}): Promise<SelosDoDiff> {
  const arquivos = await arquivosAlterados(entrada.dir, entrada.base, entrada.sha);
  const calculo = calcularSelos(arquivos, entrada.detectores, entrada.areasPlano);
  const dependencias_novas = await dependenciasNovas(
    entrada.dir,
    entrada.base,
    entrada.sha,
    arquivos,
  );
  return { ...calculo, arquivos, dependencias_novas };
}
