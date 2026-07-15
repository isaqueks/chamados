/** Conexão Redis do worker (defaults batem com o docker-compose). */
export const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? '6379'),
};

export const FILA_HEALTHCHECK = 'healthcheck';
