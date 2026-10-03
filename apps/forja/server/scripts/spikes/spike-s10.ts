import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { git, resolverSha } from '../../git/git';
import {
  aguardarHealthcheck,
  dimensoesPng,
  lancarChromiumPlaywright,
  portaLivre,
  sondarPortaLivre,
} from '../../verificacao/evidencias';
import {
  criarAreaTemporaria,
  esperar,
  executarSpike,
  processosDoGrupo,
  sinalizarGrupo,
  vereditoDe,
} from './apoio';

/**
 * S10 — prints antes/depois pelo app (specs/forja/08 §2; 03 §5.4; 05 §4.11; FJ-026).
 *
 * Sem o Chamados (o roteiro da tarefa R3 pede só o mecanismo): um repo git
 * temporário com um site estático; `sha_base` numa worktree destacada e a
 * branch do chamado (mudança de CSS) em outra. Para cada lado, o "app" é um
 * servidor HTTP estático num processo DETACHED (líder do próprio grupo) numa
 * porta livre sondada; o Chromium headless desta máquina fotografa 2 rotas; o
 * app é derrubado pelo `pgid` e conferimos grupo vazio e porta livre.
 *
 * Também prova o launcher da R2 (`lancarChromiumPlaywright`) contra a máquina:
 * o Playwright do monorepo procura a revisão de Chromium DELE em
 * `~/.cache/ms-playwright`, que pode não ser a instalada.
 */

const SERVIDOR = `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
const raiz = process.argv[2];
const tipos = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' };
createServer(async (req, res) => {
  const caminho = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^(\\.\\.[/\\\\])+/, '');
  const arquivo = join(raiz, caminho === '/' ? 'index.html' : caminho);
  try {
    const corpo = await readFile(arquivo);
    res.writeHead(200, { 'content-type': tipos[arquivo.slice(arquivo.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(corpo);
  } catch {
    res.writeHead(404);
    res.end('404');
  }
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

const ROTAS = ['/', '/sobre.html'];

function pagina(titulo: string, texto: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="/estilo.css"><title>${titulo}</title></head><body><header>Chamados (spike)</header><main><h1>${titulo}</h1><p>${texto}</p><button>Gerar segunda via</button></main></body></html>`;
}

const CSS_BASE = `body{margin:0;font-family:sans-serif;background:#ffffff;color:#111}header{padding:16px;background:#eeeeee}main{padding:24px}button{padding:8px 16px;background:#dddddd;border:1px solid #999}`;
const CSS_NOVO = `body{margin:0;font-family:sans-serif;background:#0f172a;color:#f8fafc}header{padding:24px;background:#1e3a8a}main{padding:32px}button{padding:12px 24px;background:#22c55e;border:0;border-radius:8px}`;

/** Revisão mais nova instalada de um navegador do Playwright (`<nome>-<rev>`). */
export function revisaoInstalada(
  raizCache: string,
  nome: string,
): { rev: number; dir: string } | null {
  if (!existsSync(raizCache)) return null;
  const achados = readdirSync(raizCache)
    .map((d) => ({ d, m: new RegExp(`^${nome}-(\\d+)$`).exec(d) }))
    .filter((x) => x.m && existsSync(join(raizCache, x.d, 'INSTALLATION_COMPLETE')))
    .map((x) => ({ rev: Number(x.m?.[1]), dir: join(raizCache, x.d) }))
    .sort((a, b) => b.rev - a.rev);
  return achados[0] ?? null;
}

interface Tentativa {
  rotulo: string;
  ok: boolean;
  erro: string | null;
}

export async function executar(): Promise<number> {
  return executarSpike('s10', 'Prints antes/depois pelo app (FJ-026)', async (r) => {
    const area = await criarAreaTemporaria('s10');
    const grupos: number[] = [];
    try {
      const raiz = area.raiz;
      const repo = join(raiz, 'site');
      await mkdir(repo, { recursive: true });
      await git(['init', '--quiet', '--initial-branch', 'main'], { cwd: repo });
      await git(['config', 'user.email', 'spike@forja.local'], { cwd: repo });
      await git(['config', 'user.name', 'Spike Forja'], { cwd: repo });
      await writeFile(join(repo, 'index.html'), pagina('Início', 'Lista de boletos do cliente.'));
      await writeFile(join(repo, 'sobre.html'), pagina('Sobre', 'Página institucional.'));
      await writeFile(join(repo, 'estilo.css'), CSS_BASE);
      await git(['add', '.'], { cwd: repo });
      await git(['commit', '--quiet', '-m', 'base'], { cwd: repo });
      const shaBase = (await resolverSha(repo, 'HEAD')) as string;
      await git(['checkout', '--quiet', '-b', 'forja/chamado-1-css'], { cwd: repo });
      await writeFile(join(repo, 'estilo.css'), CSS_NOVO);
      await git(['commit', '--quiet', '-am', 'forja: passo 1/1'], { cwd: repo });
      const dirAntes = join(raiz, 'dados', 'worktrees', '_integracao', 'base-spike');
      await mkdir(join(raiz, 'dados', 'worktrees', '_integracao'), { recursive: true });
      await git(['worktree', 'add', '--quiet', '--detach', dirAntes, shaBase], { cwd: repo });
      const servidor = join(raiz, 'servidor.mjs');
      await writeFile(servidor, SERVIDOR);
      const evid = join(raiz, 'dados', 'execucoes', 'exec-1', 'evidencias');
      await mkdir(evid, { recursive: true });

      // --- Lançamento do Chromium ---------------------------------------
      const tentativas: Tentativa[] = [];
      const tentar = async (rotulo: string, f: () => Promise<{ fechar: () => Promise<void> }>) => {
        try {
          const nav = await f();
          await nav.fechar();
          tentativas.push({ rotulo, ok: true, erro: null });
        } catch (e) {
          tentativas.push({
            rotulo,
            ok: false,
            erro: (e instanceof Error ? e.message : String(e)).split('\n')[0]?.slice(0, 240) ?? '',
          });
        }
      };
      await tentar('r2:lancarChromiumPlaywright', lancarChromiumPlaywright);
      const { chromium } = await import('playwright');
      const cache = join(homedir(), '.cache', 'ms-playwright');
      const shell = revisaoInstalada(cache, 'chromium_headless_shell');
      const exe = shell
        ? join(shell.dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
        : undefined;
      const lancar = (sandbox: boolean) => async () => {
        const b = await chromium.launch({
          headless: true,
          chromiumSandbox: sandbox,
          executablePath: exe,
        });
        return { fechar: () => b.close() };
      };
      await tentar(`executablePath rev ${shell?.rev ?? '?'} + sandbox`, lancar(true));
      await tentar(`executablePath rev ${shell?.rev ?? '?'} sem sandbox`, lancar(false));
      r.anexar('chromium_tentativas', tentativas);
      r.anexar('chromium_executavel', exe ?? null);
      r.anexar('playwright_revisao_esperada', chromiumEsperado());
      const r2 = tentativas[0];
      r.criterio(
        'S10.r2',
        '`lancarChromiumPlaywright` (R2) lança o Chromium desta máquina',
        vereditoDe(Boolean(r2?.ok)),
        r2?.ok
          ? 'lançou'
          : `não lançou: ${r2?.erro ?? '?'} (Playwright espera a revisão ${chromiumEsperado() ?? '?'}; instalada: ${shell?.rev ?? 'nenhuma'})`,
      );
      const comSandbox = tentativas[1];
      r.criterio(
        'S10.sandbox',
        'registro: o sandbox do Chromium sobe com apparmor_restrict_unprivileged_userns = 1?',
        'PASSOU',
        `apparmor_restrict_unprivileged_userns=${lerSysctl()}; com sandbox: ${comSandbox?.ok ? 'SOBE' : `não sobe (${comSandbox?.erro ?? '?'})`}; sem sandbox: ${tentativas[2]?.ok ? 'sobe' : `não sobe (${tentativas[2]?.erro ?? '?'})`}`,
      );
      const usarSandbox = Boolean(comSandbox?.ok);
      if (!comSandbox?.ok && !tentativas[2]?.ok) {
        r.criterio(
          'S10.a',
          'dois PNGs por rota, diferentes entre si',
          'FALHOU',
          'nenhum Chromium lançou',
        );
        return;
      }

      // --- Captura antes/depois ------------------------------------------
      const navegador = await chromium.launch({
        headless: true,
        chromiumSandbox: usarSandbox,
        executablePath: exe,
      });
      const lados: { momento: 'antes' | 'depois'; dir: string }[] = [
        { momento: 'antes', dir: dirAntes },
        { momento: 'depois', dir: repo },
      ];
      const pngs: Record<string, Buffer> = {};
      const derrubadas: {
        momento: string;
        pgid: number;
        grupoVazio: boolean;
        portaLivre: boolean;
        ms: number;
      }[] = [];
      for (const lado of lados) {
        const porta = await sondarPortaLivre();
        const app = spawn(process.execPath, [servidor, lado.dir], {
          env: { PATH: process.env.PATH ?? '', PORT: String(porta) },
          detached: true,
          stdio: 'ignore',
        });
        const pgid = app.pid as number;
        grupos.push(pgid);
        const base = `http://localhost:${porta}`;
        const saude = await aguardarHealthcheck({
          baseUrl: base,
          healthcheck: { caminho: '/', status: 200, timeout_s: 20 },
        });
        if (!saude.ok) throw new Error(`app ${lado.momento} não subiu: ${saude.motivo}`);
        const ctx = await navegador.newContext({
          viewport: { width: 1280, height: 800 },
          reducedMotion: 'reduce',
        });
        for (const rota of ROTAS) {
          const page = await ctx.newPage();
          await page.goto(base + rota, { waitUntil: 'load' });
          const arq = join(evid, `${lado.momento}${rota.replace(/\W+/g, '_')}.png`);
          await page.screenshot({
            path: arq,
            fullPage: true,
            animations: 'disabled',
            caret: 'hide',
          });
          pngs[`${lado.momento}${rota}`] = readFileSync(arq);
          await page.close();
        }
        await ctx.close();
        const t0 = Date.now();
        sinalizarGrupo(pgid, 'SIGTERM');
        while (processosDoGrupo(pgid).length > 0 && Date.now() - t0 < 10_000) await esperar(100);
        derrubadas.push({
          momento: lado.momento,
          pgid,
          grupoVazio: processosDoGrupo(pgid).length === 0,
          portaLivre: await portaLivre(porta),
          ms: Date.now() - t0,
        });
      }
      await navegador.close();
      const hash = (b: Buffer | undefined) =>
        b ? createHash('sha256').update(b).digest('hex').slice(0, 16) : null;
      const porRota = ROTAS.map((rota) => {
        const a = pngs[`antes${rota}`];
        const d = pngs[`depois${rota}`];
        return {
          rota,
          antes: hash(a),
          depois: hash(d),
          dim_antes: a ? dimensoesPng(a) : null,
          dim_depois: d ? dimensoesPng(d) : null,
          diferentes: Boolean(a && d && !a.equals(d)),
        };
      });
      r.anexar('pngs', porRota);
      r.anexar('derrubadas', derrubadas);
      r.criterio(
        'S10.a',
        'dois PNGs válidos por rota (sha_base × branch com CSS), diferentes entre si',
        vereditoDe(porRota.every((x) => x.diferentes && x.dim_antes && x.dim_depois)),
        porRota
          .map(
            (x) =>
              `${x.rota}: ${x.antes}≠${x.depois} ${x.dim_antes?.largura ?? '?'}×${x.dim_antes?.altura ?? '?'}`,
          )
          .join('; '),
      );
      r.criterio(
        'S10.b',
        'app derrubado pelo pgid sem órfãos (grupo vazio, porta livre de novo)',
        vereditoDe(derrubadas.every((d) => d.grupoVazio && d.portaLivre)),
        derrubadas
          .map(
            (d) =>
              `${d.momento}: grupo ${d.grupoVazio ? 'vazio' : 'COM PROCESSOS'}, porta ${d.portaLivre ? 'livre' : 'OCUPADA'} em ${d.ms} ms`,
          )
          .join('; '),
      );
      r.criterio(
        'S10.c',
        'storageState fora da worktree e dos logs; Chamados real com `app_subir` + login',
        'PENDENTE',
        'esta rodada usa um app estático sem login (roteiro R3); o login por storageState e o `npm run dev -w web` do clone ficam para o M4',
      );
    } finally {
      for (const g of grupos) sinalizarGrupo(g, 'SIGKILL');
      await area.limpar();
    }
  });
}

function lerSysctl(): string {
  try {
    return readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
  } catch {
    return '?';
  }
}

/** Revisão de Chromium que o Playwright do monorepo espera (`browsers.json`). */
function chromiumEsperado(): string | null {
  try {
    const caminho = join(process.cwd(), 'node_modules', 'playwright-core', 'browsers.json');
    const alt = join(process.cwd(), '..', '..', 'node_modules', 'playwright-core', 'browsers.json');
    const arq = existsSync(caminho) ? caminho : alt;
    const b = JSON.parse(readFileSync(arq, 'utf8')) as {
      browsers: { name: string; revision: string }[];
    };
    return b.browsers.find((x) => x.name === 'chromium')?.revision ?? null;
  } catch {
    return null;
  }
}
