import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import simpleGit from 'simple-git';
import { repoLocalValido, type ResultadoBusca } from '@chamados/shared';
import { ferramentasConfig, type Registrar } from './config';

/**
 * Ferramenta REPO (read-only, specs/05 §3.2/§4.2, RF-13/RF-14). Mantém uma
 * WORKING COPY em cache PERSISTENTE por (tenant, sistema-alvo) fora do ciclo do
 * job: `git clone` na primeira triagem, `git pull --ff-only` nas seguintes. O
 * conteúdo do repo é tratado como NÃO confiável (código do cliente) — nunca é
 * executado; só lido. A credencial git é injetada SÓ na URL do fetch e removida
 * do `.git/config` em seguida (specs/09 §7: segredo nunca persistido em disco) e
 * NUNCA é logada. `repo_buscar`/`repo_ler_arquivo` têm limites de tamanho/
 * resultados e bloqueiam path traversal (inclusive via symlink) para fora do
 * checkout.
 */

export interface ConfigRepo {
  tenantId: string;
  sistemaAlvoId: string;
  repoUrl: string;
  branchPadrao: string;
  /** Credencial git decifrada (ou null). "user:token" ou só "token". Efêmera. */
  credencial: string | null;
}

/** Injeta a credencial na URL http(s) do fetch/push. Nada de log com esta URL. */
export function urlComCredencial(repoUrl: string, credencial: string | null): string {
  if (!credencial) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const idx = credencial.indexOf(':');
      if (idx >= 0) {
        u.username = encodeURIComponent(credencial.slice(0, idx));
        u.password = encodeURIComponent(credencial.slice(idx + 1));
      } else {
        u.username = encodeURIComponent(credencial);
      }
      return u.toString();
    }
  } catch {
    /* URL não parseável (scp-like git@host:path, caminho local) → sem injeção */
  }
  return repoUrl;
}

/**
 * A origem é um repositório LOCAL (D-011: caminho absoluto ou `file://`)? Nesse
 * caso o git clona/faz fetch nativamente e NENHUMA credencial é injetada.
 */
export function origemLocal(repoUrl: string): boolean {
  return repoLocalValido(repoUrl);
}

/**
 * Normaliza uma origem LOCAL para o git (D-011). No Windows um `file://` com
 * contrabarras ou sem a 3ª barra antes da unidade (`file://C:/…`) confunde o git:
 * troca `\` por `/` e garante a forma canônica `file:///C:/…` (autoridade vazia).
 * Caminho simples (`C:\repos\x`, `/srv/x`) o git aceita como está — passa direto.
 */
export function normalizarRepoLocal(repoUrl: string): string {
  let u = repoUrl.trim();
  if (/^file:\/\//i.test(u)) {
    u = u.replace(/\\/g, '/');
    // file://C:/… (unidade logo após as duas barras) → file:///C:/… (3ª barra).
    u = u.replace(/^file:\/\/([a-zA-Z]:)/i, 'file:///$1');
  }
  return u;
}

/** Diretório de checkout no cache persistente (chaveado tenant + sistema). */
export function dirCheckout(cfg: ConfigRepo): string {
  return join(ferramentasConfig.repoCacheDir, cfg.tenantId, cfg.sistemaAlvoId);
}

/**
 * Sincroniza a working copy (clone/pull --ff-only). Lança `git_sync_falhou` em
 * qualquer erro (specs/05 §8: nunca analisar com código velho silenciosamente) —
 * SEM ecoar a URL autenticada. Devolve o diretório do checkout.
 */
export async function sincronizarRepo(cfg: ConfigRepo): Promise<string> {
  const dir = dirCheckout(cfg);
  const local = origemLocal(cfg.repoUrl);
  // Origem LOCAL (D-011): git clona/faz fetch nativamente; NUNCA injeta credencial
  // (nem faz a dança de set-url para removê-la — não há segredo na URL). Remoto:
  // credencial só na URL do fetch, removida do config do cache em seguida.
  const origem = local ? normalizarRepoLocal(cfg.repoUrl) : cfg.repoUrl;
  const authed = local ? origem : urlComCredencial(cfg.repoUrl, cfg.credencial);

  const clonarDoZero = async (): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    // Clona a BRANCH CONFIGURADA (`git_branch_padrao`). Sem `--branch` o git
    // clonava a default do remoto e a IA analisava código da branch ERRADA
    // sempre que a configurada ≠ default (bug corrigido em 2026-07-16 — a base
    // do PR já era a configurada, mas o conteúdo analisado não).
    const opcoes = cfg.branchPadrao ? ['--branch', cfg.branchPadrao, '--single-branch'] : [];
    await simpleGit().clone(authed, dir, opcoes);
    if (!local) {
      await simpleGit(dir)
        .remote(['set-url', 'origin', cfg.repoUrl])
        .catch(() => {});
    }
  };

  try {
    if (existsSync(join(dir, '.git'))) {
      const g = simpleGit(dir);
      // Cache na BRANCH errada (admin trocou `git_branch_padrao`, ou cache
      // anterior ao fix acima preso na default do remoto): o cache é
      // descartável — re-clona na branch certa em vez de tentar checkout
      // (o clone é --single-branch; a outra branch nem está no fetch).
      const branchAtual = (await g.revparse(['--abbrev-ref', 'HEAD']).catch(() => '')).trim();
      if (cfg.branchPadrao && branchAtual !== cfg.branchPadrao) {
        logGitSync(
          `checkout na branch '${branchAtual}' ≠ configurada '${cfg.branchPadrao}' — re-clonando`,
          null,
          cfg,
          authed,
        );
        await fs.rm(dir, { recursive: true, force: true });
        await clonarDoZero();
        return dir;
      }
      await g.remote(['set-url', 'origin', authed]);
      try {
        await g.fetch(['origin']);
        await g.pull(['--ff-only']);
      } catch (e) {
        // O cache é DESCARTÁVEL: pull impossível (URL do sistema-alvo trocada →
        // históricos não relacionados, branch reescrita, cache corrompido) não é
        // fatal — apaga e re-clona do zero (autocura), mantendo a garantia de
        // nunca analisar código velho (specs/05 §8).
        logGitSync('cache de repo invalidado, re-clonando do zero', e, cfg, authed);
        await fs.rm(dir, { recursive: true, force: true });
        await clonarDoZero();
      } finally {
        // Remove a credencial do config do cache (não persistir segredo no disco).
        // Só relevante para origem remota (a local nunca teve credencial na URL).
        if (!local && existsSync(join(dir, '.git'))) {
          await simpleGit(dir)
            .remote(['set-url', 'origin', cfg.repoUrl])
            .catch(() => {});
        }
      }
    } else {
      await clonarDoZero();
    }
    return dir;
  } catch (e) {
    // Loga o motivo SANITIZADO (sem URL autenticada/segredo) e lança o código
    // GENÉRICO — o detalhe fica só no log do worker, nunca no chamado/ExecucaoIA.
    logGitSync('git sync falhou', e, cfg, authed);
    throw new Error('git_sync_falhou');
  }
}

/** Log estruturado do sync com a mensagem do git REDIGIDA (nunca vaza segredo). */
function logGitSync(msg: string, erro: unknown, cfg: ConfigRepo, authed: string): void {
  let detalhe = erro == null ? '' : erro instanceof Error ? erro.message : String(erro);
  if (cfg.credencial) detalhe = detalhe.split(cfg.credencial).join('***');
  detalhe = detalhe.split(authed).join('<origem>');
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      servico: 'worker',
      msg,
      sistemaAlvoId: cfg.sistemaAlvoId,
      detalhe: detalhe.slice(0, 400),
    }),
  );
}

/**
 * Commit atual (HEAD) do checkout sincronizado — usado pelo mapa de conhecimento
 * (D-013) para decidir se o mapa está atualizado. Devolve `null` se indisponível
 * (repo sem commits, erro de git) — o chamador trata como "commit desconhecido".
 */
export async function commitAtual(dir: string): Promise<string | null> {
  try {
    const hash = await simpleGit(dir).revparse(['HEAD']);
    const limpo = hash.trim();
    return limpo.length > 0 ? limpo : null;
  } catch {
    return null;
  }
}

/** Resolve `caminho` DENTRO do checkout (barra traversal lexical `..`/absoluto). */
function resolverDentro(base: string, caminho: string): string {
  const alvo = resolve(base, caminho);
  const rel = relative(base, alvo);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('caminho fora do repositório');
  }
  return alvo;
}

/** Heuristica de binario: presenca de byte NUL (code point 0) no inicio. */
function pareceBinario(conteudo: string): boolean {
  const limite = Math.min(conteudo.length, 8000);
  for (let i = 0; i < limite; i++) {
    if (conteudo.charCodeAt(i) === 0) return true;
  }
  return false;
}

const IGNORAR = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.turbo']);

export interface HandlesRepo {
  repo_buscar(consulta: string): Promise<ResultadoBusca[]>;
  repo_ler_arquivo(caminho: string): Promise<string>;
  /** Lista caminhos (relativos, `/`-separados) do checkout; diretórios com `/` final. */
  repo_arvore(subdir?: string): Promise<string[]>;
}

/**
 * Constrói os handles read-only sobre o checkout. `obterDir()` devolve o
 * diretório sincronizado (ou null se o repo não está configurado) — assim os
 * handles falham com erro claro quando não há repositório.
 */
export function criarHandlesRepo(obterDir: () => string | null, registrar: Registrar): HandlesRepo {
  const { maxArquivoBytes, maxResultadosBusca, maxArquivosVarridos } = ferramentasConfig.repo;

  return {
    async repo_buscar(consulta) {
      registrar('repo_buscar', { consulta });
      const dir = obterDir();
      if (!dir) throw new Error('repositório não configurado para este sistema-alvo');
      const termo = consulta.trim().toLowerCase();
      if (!termo) return [];

      const resultados: ResultadoBusca[] = [];
      let varridos = 0;

      const walk = async (atual: string): Promise<void> => {
        if (resultados.length >= maxResultadosBusca || varridos >= maxArquivosVarridos) return;
        const entradas = await fs.readdir(atual, { withFileTypes: true }).catch(() => []);
        for (const e of entradas) {
          if (resultados.length >= maxResultadosBusca || varridos >= maxArquivosVarridos) return;
          if (IGNORAR.has(e.name)) continue;
          const full = join(atual, e.name);
          if (e.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!e.isFile()) continue;
          varridos++;
          const st = await fs.stat(full).catch(() => null);
          if (!st || st.size > maxArquivoBytes) continue;
          const conteudo = await fs.readFile(full, 'utf8').catch(() => null);
          if (conteudo === null || pareceBinario(conteudo)) continue;
          const linhas = conteudo.split('\n');
          for (let i = 0; i < linhas.length; i++) {
            if (linhas[i]!.toLowerCase().includes(termo)) {
              resultados.push({
                caminho: relative(dir, full).split(sep).join('/'),
                linha: i + 1,
                trecho: linhas[i]!.slice(0, 300).trim(),
              });
              if (resultados.length >= maxResultadosBusca) return;
            }
          }
        }
      };

      await walk(dir);
      return resultados;
    },

    async repo_ler_arquivo(caminho) {
      registrar('repo_ler_arquivo', { caminho });
      const dir = obterDir();
      if (!dir) throw new Error('repositório não configurado para este sistema-alvo');
      const alvoLexico = resolverDentro(dir, caminho);

      // Defesa a symlink: o caminho REAL precisa continuar dentro do checkout.
      let real: string;
      try {
        real = await fs.realpath(alvoLexico);
      } catch {
        throw new Error(`arquivo não encontrado: ${caminho}`);
      }
      const baseReal = await fs.realpath(dir);
      if (real !== baseReal && !real.startsWith(baseReal + sep)) {
        throw new Error('caminho fora do repositório (symlink bloqueado)');
      }

      const st = await fs.stat(real);
      if (!st.isFile()) throw new Error('o caminho não é um arquivo');
      if (st.size > maxArquivoBytes) {
        throw new Error(`arquivo excede o limite de ${maxArquivoBytes} bytes`);
      }
      return fs.readFile(real, 'utf8');
    },

    async repo_arvore(subdir) {
      registrar('repo_arvore', { subdir: subdir ?? null });
      const dir = obterDir();
      if (!dir) throw new Error('repositório não configurado para este sistema-alvo');
      const base = subdir ? resolverDentro(dir, subdir) : dir;

      const caminhos: string[] = [];
      const rel = (full: string): string => relative(dir, full).split(sep).join('/');

      const walk = async (atual: string): Promise<void> => {
        if (caminhos.length >= maxArquivosVarridos) return;
        const entradas = await fs.readdir(atual, { withFileTypes: true }).catch(() => []);
        // Ordena para saída determinística (estrutura estável entre chamadas).
        entradas.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entradas) {
          if (caminhos.length >= maxArquivosVarridos) return;
          if (IGNORAR.has(e.name)) continue;
          const full = join(atual, e.name);
          if (e.isDirectory()) {
            caminhos.push(rel(full) + '/');
            await walk(full);
          } else if (e.isFile()) {
            caminhos.push(rel(full));
          }
        }
      };

      await walk(base);
      return caminhos;
    },
  };
}
