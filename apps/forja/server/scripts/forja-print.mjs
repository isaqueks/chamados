#!/usr/bin/env node
// forja-print — print de uma tela para as evidências visuais (specs/forja FJ-030 §3).
//
// Quem fotografa é o AGENTE (bloco B7 do condutor T1): ele sobe o app do jeito
// que achar melhor e chama este utilitário para cada tela, antes e depois da
// mudança. Usa o Playwright/Chromium DA FORJA, então o repositório-alvo não
// precisa ter Playwright. É conveniência: o agente pode usar Playwright direto.
//
//   node forja-print.mjs <url> <saida.png> [--viewport 1366x768]
//        [--espera <ms>|<seletor>] [--storage <state.json>] [--full]
//
// Sai com código 0 e imprime o caminho e as dimensões; em falha, código ≠ 0 e
// uma linha "forja-print: <motivo>" no stderr (2 = uso, 3 = navegador, 4 =
// navegação, 5 = captura).
//
// .mjs puro (sem tsx): roda com o `node` do PATH do agente, de qualquer cwd.

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USO =
  'uso: node forja-print.mjs <url> <saida.png> [--viewport 1366x768] [--espera <ms>|<seletor>] [--storage <state.json>] [--full]';

function falhar(codigo, motivo) {
  process.stderr.write(`forja-print: ${motivo}\n`);
  process.exit(codigo);
}

/** Argumentos → opções. Lança Error com mensagem legível. */
export function lerArgumentos(argv) {
  const pos = [];
  const o = { viewport: { largura: 1366, altura: 768 }, espera: null, storage: null, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valor = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} exige um valor`);
      return v;
    };
    if (a === '--viewport') {
      const m = /^(\d{2,5})x(\d{2,5})$/.exec(valor());
      if (!m) throw new Error('--viewport no formato LARGURAxALTURA (ex.: 1366x768)');
      o.viewport = { largura: Number(m[1]), altura: Number(m[2]) };
    } else if (a === '--espera') {
      const v = valor();
      o.espera = /^\d+$/.test(v) ? { ms: Math.min(Number(v), 60_000) } : { seletor: v };
    } else if (a === '--storage') {
      o.storage = valor();
    } else if (a === '--full') {
      o.full = true;
    } else if (a === '-h' || a === '--help') {
      throw new Error(USO);
    } else if (a.startsWith('--')) {
      throw new Error(`opção desconhecida: ${a}`);
    } else {
      pos.push(a);
    }
  }
  if (pos.length !== 2) throw new Error(USO);
  const [url, saida] = pos;
  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    throw new Error(`URL inválida: ${url}`);
  }
  if (alvo.protocol !== 'http:' && alvo.protocol !== 'https:') {
    throw new Error(`só http(s): ${url}`);
  }
  if (!saida.endsWith('.png')) throw new Error('a saída tem de terminar em .png');
  if (o.storage && !existsSync(o.storage)) throw new Error(`--storage inexistente: ${o.storage}`);
  return { url: alvo.toString(), saida: isAbsolute(saida) ? saida : resolve(saida), ...o };
}

/** `chrome-headless-shell` mais novo do cache do Playwright (mesma regra do servidor). */
function headlessShell() {
  const raiz = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  let nomes = [];
  try {
    nomes = readdirSync(raiz);
  } catch {
    return undefined;
  }
  const revisoes = nomes
    .map((n) => /^chromium_headless_shell-(\d+)$/.exec(n))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of revisoes) {
    const bin = join(raiz, m[0], 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

async function carregarPlaywright() {
  // Resolvido a partir DESTE arquivo (o node_modules da Forja), não do cwd do agente.
  const exigir = createRequire(fileURLToPath(import.meta.url));
  try {
    return exigir('playwright');
  } catch {
    return import('playwright');
  }
}

async function principal() {
  let o;
  try {
    o = lerArgumentos(process.argv.slice(2));
  } catch (e) {
    falhar(2, e.message);
  }
  let pw;
  try {
    pw = await carregarPlaywright();
  } catch (e) {
    falhar(3, `Playwright da Forja indisponível (${e.message.split('\n')[0]})`);
  }
  const executablePath = headlessShell();
  let navegador;
  try {
    navegador = await pw.chromium
      .launch({ headless: true, chromiumSandbox: true, executablePath })
      .catch(() => pw.chromium.launch({ headless: true, chromiumSandbox: false, executablePath }));
  } catch (e) {
    falhar(
      3,
      `não foi possível abrir o Chromium (${e.message.split('\n')[0]}); rode \`npx playwright install chromium-headless-shell\``,
    );
  }
  let codigo = 0;
  try {
    const ctx = await navegador.newContext({
      viewport: { width: o.viewport.largura, height: o.viewport.altura },
      reducedMotion: 'reduce',
      ...(o.storage ? { storageState: o.storage } : {}),
    });
    const pagina = await ctx.newPage();
    let resp;
    try {
      resp = await pagina.goto(o.url, { waitUntil: 'load', timeout: 45_000 });
    } catch (e) {
      codigo = 4;
      throw new Error(`navegação falhou: ${e.message.split('\n')[0]}`);
    }
    await pagina.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    if (o.espera?.ms) await pagina.waitForTimeout(o.espera.ms);
    if (o.espera?.seletor) {
      try {
        await pagina.waitForSelector(o.espera.seletor, { timeout: 30_000 });
      } catch (e) {
        codigo = 4;
        throw new Error(`seletor não apareceu (${o.espera.seletor}): ${e.message.split('\n')[0]}`);
      }
    }
    try {
      mkdirSync(dirname(o.saida), { recursive: true });
      await pagina.screenshot({
        path: o.saida,
        fullPage: o.full,
        animations: 'disabled',
        caret: 'hide',
      });
    } catch (e) {
      codigo = 5;
      throw new Error(`captura falhou: ${e.message.split('\n')[0]}`);
    }
    const status = resp?.status() ?? null;
    process.stdout.write(
      `${o.saida} ${o.viewport.largura}x${o.viewport.altura}${o.full ? ' (página inteira)' : ''} ` +
        `HTTP ${status ?? '?'} ${statSync(o.saida).size} bytes\n`,
    );
    if (status !== null && status >= 400) {
      process.stderr.write(`forja-print: aviso: a página respondeu HTTP ${status}\n`);
    }
  } catch (e) {
    await navegador.close().catch(() => undefined);
    falhar(codigo || 5, e.message);
  }
  await navegador.close().catch(() => undefined);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await principal();
}
