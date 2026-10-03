import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Apoio dos testes de `server/git` e `server/verificacao`: repositório git REAL
 * num diretório temporário (specs/forja/01 §4.2 — I/O local controlado). Nunca
 * toca a rede nem um repositório existente. Fora do bundle de produção só por
 * convenção: nada em `server/` importa este arquivo além dos `*.test.ts`.
 */

export interface RepoTemporario {
  raiz: string;
  /** Cópia "do usuário" (branch `main`). */
  repo: string;
  /** Diretório de dados da Forja (`<dados>`). */
  dados: string;
  /** git cru (sem o wrapper do app) — para montar cenários. */
  g(args: string[], cwd?: string): string;
  escrever(caminho: string, conteudo: string, cwd?: string): void;
  commitar(mensagem: string, cwd?: string): string;
  limpar(): void;
}

export function criarRepoTemporario(): RepoTemporario {
  const raiz = mkdtempSync(join(tmpdir(), 'forja-git-'));
  const repo = join(raiz, 'repo');
  const dados = join(raiz, 'dados');
  mkdirSync(repo);
  mkdirSync(dados);
  const g = (args: string[], cwd = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.name', 'Teste Forja']);
  g(['config', 'user.email', 'teste@forja.local']);
  g(['config', 'commit.gpgsign', 'false']);
  const escrever = (caminho: string, conteudo: string, cwd = repo) => {
    mkdirSync(dirname(join(cwd, caminho)), { recursive: true });
    writeFileSync(join(cwd, caminho), conteudo);
  };
  const commitar = (mensagem: string, cwd = repo) => {
    g(['add', '-A'], cwd);
    g(['commit', '-q', '--no-verify', '-m', mensagem], cwd);
    return g(['rev-parse', 'HEAD'], cwd);
  };
  escrever('README.md', '# projeto\n');
  escrever('src/app.ts', linhas(30));
  commitar('inicial');
  return {
    raiz,
    repo,
    dados,
    g,
    escrever,
    commitar,
    limpar: () => rmSync(raiz, { recursive: true, force: true }),
  };
}

/** `linha 1\nlinha 2\n…` — arquivo longo para diffs com contexto distante. */
export function linhas(n: number, troca: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => troca[i + 1] ?? `linha ${i + 1}`).join('\n') + '\n';
}
