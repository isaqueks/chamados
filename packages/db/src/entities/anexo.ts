import { EntitySchema } from 'typeorm';

/**
 * Anexo (specs/02): arquivos anexados a um chamado (descrição) OU a uma mensagem,
 * incluindo as imagens inline do rich text (`inline = true`). A linha guarda só
 * METADADOS + a `storage_key` (objeto físico no bucket S3-compat, com prefixo por
 * tenant). `content_type` é o tipo REAL validado por magic bytes no upload
 * (specs/09 §5), não o informado pelo cliente. O acesso é sempre por URL
 * pré-assinada de curta duração, emitida após autorização e respeitando a
 * visibilidade da mensagem dona (specs/04 §6).
 */
export interface Anexo {
  id: string;
  tenant_id: string;
  chamado_id: string | null;
  mensagem_id: string | null;
  nome_arquivo: string;
  content_type: string;
  /** bigint → string no driver pg. */
  tamanho_bytes: string;
  storage_key: string;
  checksum_sha256: string | null;
  inline: boolean;
  created_at: Date;
  deleted_at: Date | null;
}

export const AnexoSchema = new EntitySchema<Anexo>({
  name: 'Anexo',
  tableName: 'anexo',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    chamado_id: { type: 'uuid', nullable: true },
    mensagem_id: { type: 'uuid', nullable: true },
    nome_arquivo: { type: 'text' },
    content_type: { type: 'text' },
    tamanho_bytes: { type: 'bigint' },
    storage_key: { type: 'text' },
    checksum_sha256: { type: 'text', nullable: true },
    inline: { type: 'boolean', default: false },
    created_at: { type: 'timestamptz', createDate: true },
    deleted_at: { type: 'timestamptz', deleteDate: true, nullable: true },
  },
  indices: [
    { name: 'ix_anexo_tenant_chamado', columns: ['tenant_id', 'chamado_id'] },
    { name: 'ix_anexo_tenant_mensagem', columns: ['tenant_id', 'mensagem_id'] },
  ],
});
