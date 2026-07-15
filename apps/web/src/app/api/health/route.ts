import { NextResponse } from 'next/server';
import { verificarPostgres } from '@chamados/db';
import Redis from 'ioredis';

// Precisa do runtime Node (TypeORM/pg/ioredis não rodam no Edge) e nunca deve
// ser pré-renderizado no build (conecta a serviços externos em tempo de request).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function verificarRedis(): Promise<boolean> {
  const client = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? '6379'),
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

export async function GET() {
  const [postgresOk, redisOk] = await Promise.all([verificarPostgres(), verificarRedis()]);

  const servicos = {
    postgres: postgresOk ? 'ok' : 'erro',
    redis: redisOk ? 'ok' : 'erro',
  } as const;

  const tudoOk = postgresOk && redisOk;

  return NextResponse.json(
    { status: tudoOk ? 'ok' : 'degradado', servicos },
    { status: tudoOk ? 200 : 503 },
  );
}
