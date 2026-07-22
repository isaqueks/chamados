import { EntitySchema } from 'typeorm';
import { StatusChamado, Natureza, Prioridade, Complexidade, valoresEnum } from '@chamados/shared';

/**
 * Documento rich text (ProseMirror/TipTap) armazenado em `*_json`. Tipado como
 * container JSON OPACO (índice `string → unknown`) para não colidir com o
 * `QueryDeepPartialEntity` recursivo do TypeORM em inserts/updates de jsonb —
 * mesmo motivo de `ConfigBranding`/`LogsConfig`. Os tipos ricos e recursivos do
 * documento (nós/marcas) e o pipeline de validação/sanitização vivem em
 * `chamados/rich-text.ts` (specs/04 §5, specs/09 §6); esta forma opaca é só o
 * contrato de armazenamento.
 */
export interface NoDocArmazenado {
  type: string;
  text?: string;
  content?: NoDocArmazenado[];
}
export type DocRichText = { type: string; content?: NoDocArmazenado[] };

/**
 * Chamado (specs/02): entidade central. `numero` é sequencial por tenant
 * (ver `tenant_contador` e o serviço de criação). A descrição vive em duas
 * representações: `descricao_json` (fonte da verdade do editor) e
 * `descricao_html` (HTML sanitizado para render). Campos internos
 * (`complexidade`, `operador_id`) NUNCA vão ao cliente — ver serializers.
 */
export interface Chamado {
  id: string;
  tenant_id: string;
  numero: string; // bigint → string no driver pg
  sistema_alvo_id: string | null;
  categoria_id: string | null;
  cliente_id: string;
  operador_id: string | null;
  titulo: string;
  descricao_json: DocRichText;
  descricao_html: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
  /** IA silenciada neste chamado (D-024): nenhuma triagem roda enquanto true. */
  ia_silenciada: boolean;
  resolvido_em: Date | null;
  fechar_automaticamente_em: Date | null;
  fechado_em: Date | null;
  reaberto_count: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const ChamadoSchema = new EntitySchema<Chamado>({
  name: 'Chamado',
  tableName: 'chamado',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      default: () => 'gen_random_uuid()',
    },
    tenant_id: { type: 'uuid' },
    numero: { type: 'bigint' },
    sistema_alvo_id: { type: 'uuid', nullable: true },
    categoria_id: { type: 'uuid', nullable: true },
    cliente_id: { type: 'uuid' },
    operador_id: { type: 'uuid', nullable: true },
    titulo: { type: 'text' },
    descricao_json: { type: 'jsonb' },
    descricao_html: { type: 'text' },
    status: {
      type: 'enum',
      enum: valoresEnum(StatusChamado),
      enumName: 'status_chamado',
      default: StatusChamado.novo,
    },
    natureza: {
      type: 'enum',
      enum: valoresEnum(Natureza),
      enumName: 'natureza',
    },
    prioridade: {
      type: 'enum',
      enum: valoresEnum(Prioridade),
      enumName: 'prioridade',
      default: Prioridade.media,
    },
    complexidade: {
      type: 'enum',
      enum: valoresEnum(Complexidade),
      enumName: 'complexidade',
      nullable: true,
    },
    ia_silenciada: { type: 'boolean', default: false },
    resolvido_em: { type: 'timestamptz', nullable: true },
    fechar_automaticamente_em: { type: 'timestamptz', nullable: true },
    fechado_em: { type: 'timestamptz', nullable: true },
    reaberto_count: { type: 'int', default: 0 },
    created_at: { type: 'timestamptz', createDate: true },
    updated_at: { type: 'timestamptz', updateDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  uniques: [{ name: 'uq_chamado_tenant_numero', columns: ['tenant_id', 'numero'] }],
  indices: [
    { name: 'ix_chamado_tenant_status_updated', columns: ['tenant_id', 'status', 'updated_at'] },
    {
      name: 'ix_chamado_tenant_cliente_created',
      columns: ['tenant_id', 'cliente_id', 'created_at'],
    },
    { name: 'ix_chamado_tenant_operador_status', columns: ['tenant_id', 'operador_id', 'status'] },
  ],
});
