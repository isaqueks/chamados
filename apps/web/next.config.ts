import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pacotes do monorepo consumidos como código-fonte TS.
  transpilePackages: ['@chamados/shared', '@chamados/db'],
  // Dependências nativas/Node que NÃO devem ser empacotadas pelo bundler
  // (TypeORM carrega drivers dinamicamente; pg/ioredis são Node-only).
  serverExternalPackages: ['typeorm', 'pg', 'ioredis', 'reflect-metadata', '@node-rs/argon2'],
};

export default nextConfig;
