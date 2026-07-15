import type { EntityManager } from 'typeorm';
import { SegredoSchema } from '../entities/segredo';
import { cifrarEnvelope, decifrarEnvelope } from './crypto';

/**
 * Cofre de segredos (specs/07 §5.2). Interface estável para permitir migrar de
 * envelope encryption local para um secrets manager (Vault, AWS SM) sem tocar no
 * resto do código. Todos os métodos operam sob o `EntityManager` transacional já
 * escopado ao tenant (`runInTenantContext`) — a RLS garante que uma `ref` só
 * resolve dentro do tenant dono.
 *
 * A `ref` retornada por `guardar` é o `id` da linha de segredo; é ela que vai nas
 * colunas `*_ref` das tabelas de negócio.
 */
export interface SecretStore {
  /** Cifra e persiste um valor; retorna a referência (`*_ref`). */
  guardar(em: EntityManager, tenantId: string, valor: string): Promise<string>;
  /** Decifra e retorna o valor de uma referência; `null` se não existir. */
  ler(em: EntityManager, ref: string): Promise<string | null>;
  /** Substitui o valor sob a MESMA referência (rotação sem recadastro). */
  substituir(em: EntityManager, ref: string, valor: string): Promise<void>;
  /** Remove um segredo (hard delete). */
  remover(em: EntityManager, ref: string): Promise<void>;
}

/** Máscara fixa exibida na UI no lugar de um segredo (specs/07 §5.2). */
export const MASCARA_SEGREDO = '••••••••';

/**
 * Máscara para exibição: NUNCA deriva do valor real (não vaza tamanho/prefixo).
 * Retorna a máscara fixa quando há segredo, string vazia quando não há.
 */
export function mascararSegredo(ref: string | null | undefined): string {
  return ref ? MASCARA_SEGREDO : '';
}

/** Implementação local com envelope encryption (AES-256-GCM). */
export const envelopeSecretStore: SecretStore = {
  async guardar(em, tenantId, valor) {
    const env = cifrarEnvelope(valor);
    const res = await em.insert(SegredoSchema, {
      tenant_id: tenantId,
      dek_cifrada: env.dek_cifrada,
      valor_cifrado: env.valor_cifrado,
    });
    return res.identifiers[0]!.id as string;
  },

  async ler(em, ref) {
    const linha = await em.findOne(SegredoSchema, { where: { id: ref } });
    if (!linha) return null;
    return decifrarEnvelope({
      dek_cifrada: linha.dek_cifrada,
      valor_cifrado: linha.valor_cifrado,
    });
  },

  async substituir(em, ref, valor) {
    const env = cifrarEnvelope(valor);
    await em.update(
      SegredoSchema,
      { id: ref },
      { dek_cifrada: env.dek_cifrada, valor_cifrado: env.valor_cifrado },
    );
  },

  async remover(em, ref) {
    await em.delete(SegredoSchema, { id: ref });
  },
};

/** Fábrica do cofre corrente (hoje: envelope local). */
export function criarSecretStore(): SecretStore {
  return envelopeSecretStore;
}
