import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carrega o `.env` da RAIZ do monorepo. O Next só lê `apps/web/.env*`, mas as
 * variáveis compartilhadas do projeto (SECRET_STORE_MASTER_KEY,
 * SISTEMAS_PERMITIR_REPO_LOCAL, NOTIFICACOES_*, etc.) vivem num único `.env`
 * na raiz, lido também pelo worker e pelos scripts (docs/desenvolvimento.md).
 * Nunca sobrescreve o que já veio do ambiente do processo ou de `.env` local
 * do app — apenas preenche o que falta. Sem `.env` na raiz (ex.: produção com
 * env real), segue silenciosamente.
 */
function carregarEnvDaRaiz(): void {
  const base = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  try {
    const conteudo = readFileSync(resolve(base, '../../.env'), 'utf8');
    for (const linha of conteudo.split(/\r?\n/)) {
      const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, nome, bruto] = m;
      if (process.env[nome] !== undefined) continue;
      process.env[nome] = bruto.replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* raiz sem .env — ambiente do processo é a fonte */
  }
}
carregarEnvDaRaiz();

const ehProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy PRAGMÁTICA (specs/09 §6 — hardening M10 frente B).
 *
 * Equilíbrio consciente: o Next (App Router) e o TipTap injetam estilos inline e,
 * em prod, scripts de bootstrap/streaming inline SEM nonce. Uma CSP totalmente
 * estrita (script-src 'self' + nonce) exigiria gerar e propagar um nonce por
 * request no proxy (Edge) e reescrever o layout — trabalho grande e frágil no
 * Next 16. Optamos por uma CSP que já elimina os vetores mais comuns
 * (frame-ancestors, object-src, base-uri, img/connect restritos) mantendo
 * 'unsafe-inline' onde o framework hoje exige.
 *
 * CAMINHO PARA ENDURECER (documentar): mover para CSP com nonce por request
 * (script-src 'self' 'nonce-<n>' 'strict-dynamic'), gerado no proxy e lido via
 * headers() no root layout; então remover 'unsafe-inline'/'unsafe-eval' de
 * script-src. Em dev, 'unsafe-eval' é necessário para o React Refresh/HMR.
 */
function contentSecurityPolicy(): string {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (!ehProd) scriptSrc.push("'unsafe-eval'"); // React Refresh/HMR em dev.

  // Em dev o HMR usa WebSocket (ws:) para o cliente do Next.
  const connectSrc = ["'self'"];
  if (!ehProd) connectSrc.push('ws:', 'http://localhost:*', 'ws://localhost:*');

  // Origem do STORAGE (MinIO/S3): o download de anexos é um 302 de /api/anexos
  // para uma URL PRÉ-ASSINADA do storage — o CSP avalia a URL FINAL do redirect,
  // então `img-src 'self'` sozinho BLOQUEAVA silenciosamente toda imagem colada
  // (bug da tarefa #16). Espelha a resolução de endpoint de @chamados/storage.
  const imgSrc = ["'self'", 'data:', 'blob:'];
  const origemStorage = (() => {
    const explicito = process.env.STORAGE_ENDPOINT?.trim();
    const host = process.env.MINIO_HOST ?? process.env.POSTGRES_HOST ?? 'localhost';
    const porta = process.env.MINIO_PORT ?? '9000';
    try {
      return new URL(explicito || `http://${host}:${porta}`).origin;
    } catch {
      return null;
    }
  })();
  if (origemStorage) imgSrc.push(origemStorage);

  const diretivas: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': scriptSrc,
    // Tailwind + variáveis de branding por tenant (<style> inline) + placeholder do editor.
    'style-src': ["'self'", "'unsafe-inline'"],
    // Logos/anexos: rotas próprias ('self') + o REDIRECT à URL assinada do
    // storage; imagens coladas no editor viajam como data:/blob: até materializar.
    'img-src': imgSrc,
    'font-src': ["'self'", 'data:'],
    'connect-src': connectSrc,
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'frame-src': ["'none'"],
  };
  if (ehProd) diretivas['upgrade-insecure-requests'] = [];

  return Object.entries(diretivas)
    .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
    .join('; ');
}

/** Cabeçalhos de segurança aplicados a TODAS as respostas (specs/09 §6). */
const cabecalhosSeguranca = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  // Pacotes do monorepo consumidos como código-fonte TS.
  transpilePackages: ['@chamados/shared', '@chamados/db'],
  // Dependências nativas/Node que NÃO devem ser empacotadas pelo bundler
  // (TypeORM carrega drivers dinamicamente; pg/ioredis são Node-only).
  serverExternalPackages: ['typeorm', 'pg', 'ioredis', 'reflect-metadata', '@node-rs/argon2'],
  experimental: {
    // Imagens coladas no editor viajam como data: base64 no JSON (campo `corpo`/
    // `descricao`) e os anexos vão por multipart no MESMO server action — o limite
    // padrão (1mb) estoura com facilidade.
    serverActions: { bodySizeLimit: '32mb' },
  },
  // Cabeçalhos de segurança (specs/09 §6). Aplicam a páginas, rotas /api e assets.
  async headers() {
    return [{ source: '/:path*', headers: cabecalhosSeguranca }];
  },
};

export default nextConfig;
