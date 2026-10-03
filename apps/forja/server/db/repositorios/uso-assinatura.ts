import { LessThan, MoreThanOrEqual } from 'typeorm';
import { UsoAssinaturaSchema, type UsoAssinatura } from '../entidades/uso-assinatura';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `uso_assinatura` (specs/forja/02 §4.14, retenção 30 dias em
 * §9). Append-only na prática: cada `rate_limit_event` vira um snapshot; o
 * freio de cota lê o último.
 */

export type NovoUsoAssinatura = Omit<UsoAssinatura, 'id' | 'criado_em' | 'etapa_id'> & {
  etapa_id?: string | null;
};

export class RepositorioUsoAssinatura extends RepositorioBase {
  async registrar(dados: NovoUsoAssinatura): Promise<UsoAssinatura> {
    const linha: UsoAssinatura = {
      id: novoId(),
      ...dados,
      etapa_id: dados.etapa_id ?? null,
      criado_em: this.agora(),
    };
    await this.inserir(UsoAssinaturaSchema, linha);
    return linha;
  }

  ultimo(): Promise<UsoAssinatura | null> {
    return this.m.findOne(UsoAssinaturaSchema, {
      where: {},
      order: { criado_em: 'DESC', id: 'DESC' },
    });
  }

  desde(iso: string): Promise<UsoAssinatura[]> {
    return this.m.find(UsoAssinaturaSchema, {
      where: { criado_em: MoreThanOrEqual(iso) },
      order: { criado_em: 'ASC' },
    });
  }

  /** Retenção (02 §9). Devolve quantas linhas apagou. */
  async expurgarAntesDe(iso: string): Promise<number> {
    const r = await this.m.delete(UsoAssinaturaSchema, { criado_em: LessThan(iso) });
    return r.affected ?? 0;
  }
}
