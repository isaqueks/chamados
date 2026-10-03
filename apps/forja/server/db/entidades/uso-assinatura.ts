import { EntitySchema } from 'typeorm';
import type { StatusCota } from '../../../comum/estados';
import { JsonLivre, type JsonLivre as TJsonLivre } from '../json';
import { booleano, json, pk, real, texto } from './colunas';

/**
 * `uso_assinatura` (specs/forja/02 §4.14): snapshots do `rate_limit_event` da
 * CLI [V 01 §2] — base do freio de cota (F-14) e do indicador de uso. Só
 * `criado_em`; expira em 30 dias (02 §9). `bruto` guarda o `rate_limit_info`
 * integral, porque o formato é da CLI e muda sem aviso.
 */
export interface UsoAssinatura {
  id: string;
  etapa_id: string | null;
  utilizacao_5h: number | null;
  utilizacao_7d: number | null;
  reinicia_5h_em: string | null;
  reinicia_7d_em: string | null;
  status: StatusCota | null;
  status_overage: string | null;
  usando_creditos_extras: boolean | null;
  bruto: TJsonLivre;
  criado_em: string;
}

export const UsoAssinaturaSchema = new EntitySchema<UsoAssinatura>({
  name: 'UsoAssinatura',
  tableName: 'uso_assinatura',
  columns: {
    id: pk(),
    etapa_id: texto(true),
    utilizacao_5h: real(true),
    utilizacao_7d: real(true),
    reinicia_5h_em: texto(true),
    reinicia_7d_em: texto(true),
    status: texto(true),
    status_overage: texto(true),
    usando_creditos_extras: booleano(true),
    bruto: json(JsonLivre, 'uso_assinatura.bruto'),
    criado_em: texto(),
  },
  indices: [{ name: 'ix_uso_assinatura_criado', columns: ['criado_em'] }],
});
