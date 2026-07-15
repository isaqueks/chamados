/**
 * Configuração do storage S3-compatível (MinIO em dev; S3/R2 em prod — specs/01
 * §3.7). Defaults batem com o docker-compose.yml. Um único bucket com prefixo
 * por tenant (specs/07 §6.2).
 */

function env(nome: string, padrao: string): string {
  const v = process.env[nome];
  return v === undefined || v === '' ? padrao : v;
}

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO exige path-style (bucket no caminho, não no host). */
  forcePathStyle: boolean;
}

export function obterStorageConfig(): StorageConfig {
  const host = env('MINIO_HOST', env('POSTGRES_HOST', 'localhost'));
  const port = env('MINIO_PORT', '9000');
  return {
    endpoint: env('STORAGE_ENDPOINT', `http://${host}:${port}`),
    region: env('STORAGE_REGION', 'us-east-1'),
    bucket: env('STORAGE_BUCKET', 'chamados'),
    accessKeyId: env('MINIO_ROOT_USER', 'minioadmin'),
    secretAccessKey: env('MINIO_ROOT_PASSWORD', 'minioadmin'),
    forcePathStyle: true,
  };
}
