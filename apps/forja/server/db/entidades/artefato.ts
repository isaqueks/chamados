import { EntitySchema } from 'typeorm';
import type { TipoArtefato } from '../../../comum/estados';
import { JsonLivre, type JsonLivre as TJsonLivre } from '../json';
import { booleano, inteiro, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `artefato` (specs/forja/02 §4.9): produto versionado de uma etapa. Contratos
 * pequenos (`plano.v1`…) vivem em `conteudo` — o SQLite é a fonte da verdade;
 * diffs, logs, prompts e prints vivem em arquivo (`caminho`, relativo ao
 * diretório da execução). `sha256` + `tamanho_bytes` são conferidos ao mostrar
 * na aprovação (o arquivo pode ter sido mexido por um `Bash` do agente, U-3).
 *
 * `conteudo` é JSON livre aqui: quem valida contra o contrato (`validarContrato`
 * de `comum/contratos`) é o domínio, que sabe qual contrato a etapa pediu.
 * Edição humana do plano = nova versão com `editado_por_humano` (F-11).
 */
export interface Artefato extends ComTempo {
  id: string;
  execucao_id: string;
  etapa_id: string | null;
  tipo: TipoArtefato;
  versao: number;
  contrato: string | null;
  conteudo: TJsonLivre | null;
  caminho: string | null;
  sha256: string;
  tamanho_bytes: number;
  sha_git: string | null;
  patch_id: string | null;
  editado_por_humano: boolean;
}

export const ArtefatoSchema = new EntitySchema<Artefato>({
  name: 'Artefato',
  tableName: 'artefato',
  columns: {
    id: pk(),
    execucao_id: texto(),
    etapa_id: texto(true),
    tipo: texto(),
    versao: inteiro(),
    contrato: texto(true),
    conteudo: json(JsonLivre, 'artefato.conteudo', true),
    caminho: texto(true),
    sha256: texto(),
    tamanho_bytes: inteiro(),
    sha_git: texto(true),
    patch_id: texto(true),
    editado_por_humano: booleano(),
    ...tempo(),
  },
  indices: [
    { name: 'ux_artefato_versao', columns: ['execucao_id', 'tipo', 'versao'], unique: true },
    { name: 'ix_artefato_etapa', columns: ['etapa_id'] },
  ],
  checks: [
    {
      name: 'ck_artefato_conteudo_ou_caminho',
      expression: `"conteudo" IS NOT NULL OR "caminho" IS NOT NULL`,
    },
    { name: 'ck_artefato_patch_id_diff', expression: `"patch_id" IS NULL OR "tipo" = 'diff'` },
  ],
});
