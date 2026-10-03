import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Utilitários de navegador e de porta (specs/forja/08 S10; FJ-030 §3).
 *
 * Desde FJ-030 quem sobe o app e fotografa é o AGENTE (bloco B7, com
 * `scripts/forja-print.mjs`); o app só coleta e valida. Ficam aqui as peças
 * que ainda servem: achar o Chromium headless da máquina (o `forja-print` usa
 * a mesma regra), sondar porta, conferir PNG e o healthcheck — usados pelo
 * spike S10 e pelo Diagnóstico.
 */

/**
 * Caminho do `chrome-headless-shell` da revisão mais nova em
 * `~/.cache/ms-playwright` (ou `PLAYWRIGHT_BROWSERS_PATH`). Null se não houver.
 * [V S10] o Playwright pode pedir uma revisão que não está instalada.
 */
export function headlessShellInstalado(
  raiz: string = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright'),
): string | null {
  let entradas: string[];
  try {
    entradas = readdirSync(raiz);
  } catch {
    return null;
  }
  const revisoes = entradas
    .map((n) => /^chromium_headless_shell-(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of revisoes) {
    const bin = join(raiz, m[0], 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** Lança o Chromium headless do Playwright da Forja (sandbox se a máquina permitir). */
export async function lancarChromiumPlaywright(): Promise<{ fechar(): Promise<void> }> {
  const { chromium } = await import('playwright');
  const executablePath = headlessShellInstalado() ?? undefined;
  const navegador = await chromium
    .launch({ headless: true, chromiumSandbox: true, executablePath })
    .catch(() => chromium.launch({ headless: true, chromiumSandbox: false, executablePath }));
  return { fechar: () => navegador.close() };
}

/** Bind efêmero em `127.0.0.1` e fecha: a porta que o SO deu está livre agora. */
export function sondarPortaLivre(): Promise<number> {
  return new Promise((resolver, rejeitar) => {
    const srv = createServer();
    srv.once('error', rejeitar);
    srv.listen(0, '127.0.0.1', () => {
      const end = srv.address();
      const porta = typeof end === 'object' && end ? end.port : 0;
      srv.close(() => resolver(porta));
    });
  });
}

/** A porta voltou a ficar livre (nenhum órfão escutando)? */
export function portaLivre(porta: number): Promise<boolean> {
  return new Promise((resolver) => {
    const srv = createServer();
    srv.once('error', () => resolver(false));
    srv.listen(porta, '127.0.0.1', () => srv.close(() => resolver(true)));
  });
}

/** Largura × altura do cabeçalho IHDR de um PNG (null se não for PNG). */
export function dimensoesPng(buf: Buffer): { largura: number; altura: number } | null {
  const assinatura = '89504e470d0a1a0a';
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== assinatura) return null;
  return { largura: buf.readUInt32BE(16), altura: buf.readUInt32BE(20) };
}

export type Buscar = (url: string, init: RequestInit) => Promise<{ status: number }>;

/** `GET BASE_URL + caminho` até `status` ou `timeout_s`; para cedo se o app morreu. */
export async function aguardarHealthcheck(e: {
  baseUrl: string;
  healthcheck: { caminho: string; status: number; timeout_s: number };
  app?: { encerrado: boolean };
  buscar?: Buscar;
  intervaloMs?: number;
}): Promise<{ ok: boolean; motivo: 'ok' | 'app_morreu' | 'timeout'; ultimoStatus: number | null }> {
  const buscar = e.buscar ?? ((u, i) => fetch(u, i));
  const limite = Date.now() + e.healthcheck.timeout_s * 1000;
  const url = new URL(e.healthcheck.caminho, e.baseUrl).toString();
  let ultimoStatus: number | null = null;
  while (Date.now() < limite) {
    if (e.app?.encerrado) return { ok: false, motivo: 'app_morreu', ultimoStatus };
    try {
      const r = await buscar(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      ultimoStatus = r.status;
      if (r.status === e.healthcheck.status) return { ok: true, motivo: 'ok', ultimoStatus };
    } catch {
      // Ainda subindo.
    }
    await new Promise((r) => setTimeout(r, e.intervaloMs ?? 500));
  }
  return { ok: false, motivo: 'timeout', ultimoStatus };
}
