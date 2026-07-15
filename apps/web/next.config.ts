import type { NextConfig } from 'next';

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

  const diretivas: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': scriptSrc,
    // Tailwind + variáveis de branding por tenant (<style> inline) + placeholder do editor.
    'style-src': ["'self'", "'unsafe-inline'"],
    // Logos/anexos vêm de rotas próprias ('self'); imagens coladas viajam como data:/blob:.
    'img-src': ["'self'", 'data:', 'blob:'],
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
