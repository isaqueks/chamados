import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import simpleGit from 'simple-git';
import type { FerramentasEscrita } from '@chamados/shared';
import { ferramentasConfig, type Registrar } from './config';

/**
 * Ferramentas de ESCRITA da tentativa de resolução automática (specs/05 §6). SÓ
 * são montadas quando o GATE do pipeline autorizou. Escrevem numa WORKING COPY
 * DESCARTÁVEL — um clone local do cache persistente (`git clone <cache> <temp>`)
 * num diretório temporário — NUNCA no cache nem em produção. A cópia descartável
 * é destruída ao fim do job (specs/09 §4.4: filesystem de execução efêmero).
 *
 * Guardrails das escritas (specs/09 §4): bloqueiam path traversal (lexical e via
 * symlink), bloqueiam qualquer caminho dentro de `.git`, e impõem limites de
 * tamanho por arquivo, bytes totais e quantidade de arquivos tocados. O provider
 * jamais abre branch/PR — isso é responsabilidade do worker (menor privilégio).
 */

export interface CopiaDescartavel {
  /** Diretório da working copy descartável (clone do cache). */
  dir: string;
  /** Remove a cópia descartável do disco (idempotente). */
  destruir(): Promise<void>;
}

/**
 * Cria a working copy descartável clonando o checkout do cache para um diretório
 * temporário. `git clone` local (não toca a rede) preserva o histórico e a branch
 * default do cache — de onde a branch de resolução será criada (specs/05 §6).
 */
export async function criarCopiaDescartavel(cacheCheckoutDir: string): Promise<CopiaDescartavel> {
  const dir = join(tmpdir(), `chamados-resolucao-${randomBytes(6).toString('hex')}`);
  await simpleGit().clone(cacheCheckoutDir, dir, ['--local']);
  return {
    dir,
    async destruir() {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Resolve `caminho` DENTRO da working copy, barrando traversal e `.git`. */
function resolverEscrita(base: string, caminho: string): string {
  const alvo = resolve(base, caminho);
  const rel = relative(base, alvo);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('caminho fora da working copy');
  }
  const primeiro = rel.split(sep)[0];
  if (primeiro === '.git') {
    throw new Error('escrita em .git é proibida');
  }
  return alvo;
}

/**
 * Estado de limites acumulado ENTRE chamadas de escrita (um por tentativa): conta
 * arquivos distintos tocados e bytes totais para não estourar os tetos do §6.
 */
interface EstadoLimites {
  arquivos: Set<string>;
  bytesTotais: number;
}

/**
 * Constrói os handles de escrita sobre a working copy descartável. `obterDir()`
 * devolve o diretório (ou null se a resolução não foi preparada) — os handles
 * falham com erro claro se chamados sem cópia preparada.
 */
export function criarHandlesEscrita(
  obterDir: () => string | null,
  registrar: Registrar,
): FerramentasEscrita {
  const { maxArquivos, maxArquivoBytes, maxBytesTotal } = ferramentasConfig.resolucao;
  const estado: EstadoLimites = { arquivos: new Set(), bytesTotais: 0 };

  async function escrever(caminho: string, conteudo: string, exigirNovo: boolean): Promise<void> {
    const dir = obterDir();
    if (!dir) throw new Error('resolução não preparada (working copy descartável ausente)');
    const alvo = resolverEscrita(dir, caminho);

    // Defesa a symlink: um pai já existente não pode escapar da working copy.
    const paiExistente = await primeiroPaiExistente(alvo);
    const paiReal = await fs.realpath(paiExistente).catch(() => paiExistente);
    const baseReal = await fs.realpath(dir);
    if (paiReal !== baseReal && !paiReal.startsWith(baseReal + sep)) {
      throw new Error('caminho fora da working copy (symlink bloqueado)');
    }

    const jaExiste = existsSync(alvo);
    if (exigirNovo && jaExiste) {
      throw new Error(`arquivo já existe: ${caminho}`);
    }

    const bytes = Buffer.byteLength(conteudo, 'utf8');
    if (bytes > maxArquivoBytes) {
      throw new Error(`arquivo excede o limite de ${maxArquivoBytes} bytes`);
    }
    // Limites acumulados (só conta o arquivo uma vez).
    const jaContado = estado.arquivos.has(alvo);
    if (!jaContado && estado.arquivos.size >= maxArquivos) {
      throw new Error(`limite de ${maxArquivos} arquivos alterados excedido`);
    }
    if (estado.bytesTotais + bytes > maxBytesTotal) {
      throw new Error(`limite total de ${maxBytesTotal} bytes escritos excedido`);
    }

    await fs.mkdir(dirname(alvo), { recursive: true });
    await fs.writeFile(alvo, conteudo, 'utf8');
    estado.arquivos.add(alvo);
    estado.bytesTotais += bytes;
  }

  return {
    async repo_escrever_arquivo(caminho, conteudo) {
      registrar('repo_escrever_arquivo', { caminho });
      await escrever(caminho, conteudo, false);
    },
    async repo_criar_arquivo(caminho, conteudo) {
      registrar('repo_criar_arquivo', { caminho });
      await escrever(caminho, conteudo, true);
    },
  };
}

/** Sobe na hierarquia até achar um diretório existente (para a checagem de symlink). */
async function primeiroPaiExistente(caminho: string): Promise<string> {
  let atual = dirname(caminho);
  // Evita loop infinito: para quando chegar na raiz.
  for (let i = 0; i < 64; i++) {
    if (existsSync(atual)) return atual;
    const pai = dirname(atual);
    if (pai === atual) return atual;
    atual = pai;
  }
  return atual;
}

/**
 * Lista os caminhos (relativos, com `/`) efetivamente modificados na working copy
 * segundo o git — a fonte da verdade do que será commitado. Ignora `.git`.
 */
export async function arquivosModificados(dir: string): Promise<string[]> {
  const status = await simpleGit(dir).status();
  const paths = new Set<string>();
  for (const f of status.files) {
    const p = f.path.replace(/\\/g, '/');
    if (p && !p.startsWith('.git/')) paths.add(p);
  }
  return Array.from(paths).sort();
}
