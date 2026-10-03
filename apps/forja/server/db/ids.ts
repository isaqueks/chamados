import { randomBytes } from 'node:crypto';

/**
 * Identidade e tempo das linhas do SQLite da Forja (specs/forja/02 §1).
 *
 * - PK `TEXT` com **UUID v7** gerado pelo app: os 48 bits iniciais são o
 *   timestamp em ms, então a PK ordena por tempo de criação (útil em listagens
 *   e no `ORDER BY id` como desempate). O Node 22 só gera v4 nativamente; a
 *   montagem abaixo segue a RFC 9562 §5.7 (versão 7, variante 10xx).
 * - Timestamps em `TEXT` ISO-8601 UTC com ms e `Z`, gravados pelo app: o
 *   `CURRENT_TIMESTAMP` do SQLite não tem ms nem fuso e não ordenaria junto.
 */

let ultimoMs = 0;
let sequencia = 0;

/** UUID v7 (RFC 9562). Monotônico dentro do processo: dois ids no mesmo ms saem em ordem. */
export function novoId(agoraMs: number = Date.now()): string {
  const aleatorio = randomBytes(16);
  if (agoraMs <= ultimoMs) {
    agoraMs = ultimoMs;
    sequencia = (sequencia + 1) & 0xfff;
    if (sequencia === 0) agoraMs = ++ultimoMs;
  } else {
    ultimoMs = agoraMs;
    sequencia = aleatorio.readUInt16BE(6) & 0x7ff;
  }
  const b = Buffer.alloc(16);
  b.writeUIntBE(agoraMs, 0, 6);
  b[6] = 0x70 | ((sequencia >> 8) & 0x0f);
  b[7] = sequencia & 0xff;
  aleatorio.copy(b, 8, 8, 16);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Relógio injetável (testes); devolve ISO-8601 UTC com ms. */
export type Relogio = () => Date;

export const relogioSistema: Relogio = () => new Date();

export function iso(data: Date): string {
  return data.toISOString();
}
