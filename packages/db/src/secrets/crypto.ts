import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption AES-256-GCM (specs/09 §7) para o cofre de segredos local.
 *
 * Modelo:
 *  - CHAVE MESTRA (KEK) fica FORA do banco, em `SECRET_STORE_MASTER_KEY` (32
 *    bytes em base64). Um dump do banco não revela segredos sem a KEK.
 *  - Para cada segredo gera-se uma DATA KEY (DEK) aleatória de 32 bytes; a DEK
 *    cifra o valor (GCM) e a própria DEK é embrulhada (wrap) pela KEK (GCM).
 *  - Persistimos apenas: DEK embrulhada + valor cifrado. Rotacionar a KEK no
 *    futuro só exige re-embrulhar as DEKs, sem tocar nos valores.
 *
 * Cada blob é `iv(12) || authTag(16) || ciphertext`, serializado em base64.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const TAG_BYTES = 16;
const CHAVE_BYTES = 32; // AES-256

let chaveMestraCache: Buffer | null = null;

/**
 * Carrega e valida a chave mestra do ambiente. Lança se ausente/ malformada —
 * é uma falha de configuração que deve interromper qualquer operação de segredo.
 */
export function carregarChaveMestra(): Buffer {
  if (chaveMestraCache) return chaveMestraCache;
  const raw = process.env.SECRET_STORE_MASTER_KEY;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'SECRET_STORE_MASTER_KEY não configurada. Gere com: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  let chave: Buffer;
  try {
    chave = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new Error('SECRET_STORE_MASTER_KEY inválida (não é base64).');
  }
  if (chave.length !== CHAVE_BYTES) {
    throw new Error(
      `SECRET_STORE_MASTER_KEY deve ter ${CHAVE_BYTES} bytes (256 bits) em base64; ` +
        `recebido ${chave.length} bytes.`,
    );
  }
  chaveMestraCache = chave;
  return chave;
}

/** Apenas para testes: limpa o cache da chave mestra. */
export function _resetChaveMestraCache(): void {
  chaveMestraCache = null;
}

/** Cifra `texto` com `chave` (AES-256-GCM) → blob base64 `iv|tag|ct`. */
function cifrar(texto: Buffer, chave: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, chave, iv);
  const ct = Buffer.concat([cipher.update(texto), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decifra um blob base64 `iv|tag|ct` com `chave` (AES-256-GCM). */
function decifrar(blobB64: string, chave: Buffer): Buffer {
  const blob = Buffer.from(blobB64, 'base64');
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Blob de segredo corrompido (tamanho insuficiente).');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, chave, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export interface EnvelopeCifrado {
  /** DEK aleatória embrulhada (wrap) pela chave mestra. */
  dek_cifrada: string;
  /** Valor secreto cifrado sob a DEK. */
  valor_cifrado: string;
}

/** Cifra um valor em texto claro com envelope encryption. */
export function cifrarEnvelope(valor: string): EnvelopeCifrado {
  const kek = carregarChaveMestra();
  const dek = randomBytes(CHAVE_BYTES);
  const valor_cifrado = cifrar(Buffer.from(valor, 'utf8'), dek);
  const dek_cifrada = cifrar(dek, kek);
  return { dek_cifrada, valor_cifrado };
}

/** Decifra um envelope de volta ao texto claro. */
export function decifrarEnvelope(env: EnvelopeCifrado): string {
  const kek = carregarChaveMestra();
  const dek = decifrar(env.dek_cifrada, kek);
  return decifrar(env.valor_cifrado, dek).toString('utf8');
}
