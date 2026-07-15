import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { obterStorageConfig, type StorageConfig } from './config';

export { obterStorageConfig, type StorageConfig } from './config';

/**
 * Cliente de storage S3-compatível (specs/01, specs/07 §6.2). Isolamento por
 * PREFIXO de chave por tenant; acesso por URL pré-assinada de curta duração ou
 * por streaming controlado pela aplicação. Nenhum bucket/prefixo é público.
 */

const globalRef = globalThis as unknown as { __chamadosS3?: S3Client };

function cfg(): StorageConfig {
  return obterStorageConfig();
}

/** Retorna um S3Client singleton (sobrevive ao HMR do Next em dev). */
export function obterS3(): S3Client {
  if (!globalRef.__chamadosS3) {
    const c = cfg();
    globalRef.__chamadosS3 = new S3Client({
      endpoint: c.endpoint,
      region: c.region,
      forcePathStyle: c.forcePathStyle,
      credentials: {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
      },
    });
  }
  return globalRef.__chamadosS3;
}

/** Garante que o bucket existe (idempotente). Cria se ausente. */
export async function garantirBucket(): Promise<void> {
  const s3 = obterS3();
  const bucket = cfg().bucket;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (e: unknown) {
      // Corrida: outro processo pode ter criado entre o head e o create.
      const nome = (e as { name?: string })?.name ?? '';
      if (nome !== 'BucketAlreadyOwnedByYou' && nome !== 'BucketAlreadyExists') {
        throw e;
      }
    }
  }
}

// --- Chaves com prefixo por tenant (specs/07 §6.2) --------------------------

/** Prefixo raiz de um tenant. */
export function prefixoTenant(tenantId: string): string {
  return `tenants/${tenantId}`;
}

/** Chave de um asset de branding (logo/favicon). */
export function chaveBranding(tenantId: string, arquivo: string): string {
  return `${prefixoTenant(tenantId)}/branding/${arquivo}`;
}

/** Chave de um anexo de chamado (base para o M4). */
export function chaveAnexo(tenantId: string, chamadoId: string, anexoId: string): string {
  return `${prefixoTenant(tenantId)}/anexos/${chamadoId}/${anexoId}`;
}

// --- Operações de objeto ----------------------------------------------------

/** Envia (put) um objeto. Garante o bucket antes. */
export async function enviarObjeto(
  key: string,
  corpo: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await garantirBucket();
  const s3 = obterS3();
  await s3.send(
    new PutObjectCommand({
      Bucket: cfg().bucket,
      Key: key,
      Body: corpo,
      ContentType: contentType,
    }),
  );
}

export interface ObjetoBaixado {
  corpo: Buffer;
  contentType: string;
}

/** Baixa um objeto para memória (uso: streaming de logo pela aplicação). */
export async function obterObjeto(key: string): Promise<ObjetoBaixado | null> {
  const s3 = obterS3();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: cfg().bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return {
      corpo: Buffer.from(bytes),
      contentType: res.ContentType ?? 'application/octet-stream',
    };
  } catch (e: unknown) {
    const nome = (e as { name?: string })?.name ?? '';
    if (nome === 'NoSuchKey' || nome === 'NotFound') return null;
    throw e;
  }
}

/** Remove um objeto (idempotente). */
export async function removerObjeto(key: string): Promise<void> {
  const s3 = obterS3();
  await s3.send(new DeleteObjectCommand({ Bucket: cfg().bucket, Key: key }));
}

/**
 * URL pré-assinada de GET, com TTL curto (default 5 min). Base para servir
 * anexos no M4 (specs/09 §5). Emitida apenas após checagem de autorização.
 */
export async function urlAssinadaGet(key: string, ttlSegundos = 300): Promise<string> {
  const s3 = obterS3();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg().bucket, Key: key }), {
    expiresIn: ttlSegundos,
  });
}
