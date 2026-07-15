import type { NextConfig } from 'next';

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
};

export default nextConfig;
