import { EntitySchema } from 'typeorm';
import { VisibilidadeMensagem, valoresEnum } from '@chamados/shared';
import type { DocRichText } from './chamado';

/**
 * Mensagem (specs/02): item da timeline de um chamado. Notas internas usam
 * `visibilidade = interna` e NUNCA são retornadas ao cliente (filtro na camada
 * de dados + RLS). O corpo vive em duas representações: `corpo_json` (fonte da
 * verdade do editor) e `corpo_html` (HTML sanitizado para render). Mensagens são
 * IMUTÁVEIS no MVP (sem edição/exclusão via aplicação — specs/04 §4.2); o
 * `deleted_at` existe só para retenção/LGPD (specs/02 "Soft delete").
 */
export interface Mensagem {
  id: string;
  tenant_id: string;
  chamado_id: string;
  autor_id: string;
  visibilidade: VisibilidadeMensagem;
  corpo_json: DocRichText;
  corpo_html: string;
  /** Preenchido quando a mensagem foi gerada por uma execução de IA (M6+). */
  execucao_ia_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const MensagemSchema = new EntitySchema<Mensagem>({
  name: 'Mensagem',
  tableName: 'mensagem',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    chamado_id: { type: 'uuid' },
    autor_id: { type: 'uuid' },
    visibilidade: {
      type: 'enum',
      enum: valoresEnum(VisibilidadeMensagem),
      enumName: 'visibilidade_mensagem',
      default: VisibilidadeMensagem.publica,
    },
    corpo_json: { type: 'jsonb' },
    corpo_html: { type: 'text' },
    execucao_ia_id: { type: 'uuid', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  indices: [
    {
      name: 'ix_mensagem_tenant_chamado_created',
      columns: ['tenant_id', 'chamado_id', 'created_at'],
    },
  ],
});
