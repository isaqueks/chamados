import { randomUUID, createHash } from 'node:crypto';
import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { autorizar, VisibilidadeMensagem, type Papel } from '@chamados/shared';
import { enviarObjeto, chaveAnexo } from '@chamados/storage';
import { AnexoSchema, type Anexo } from '../entities/anexo';
import { MensagemSchema } from '../entities/mensagem';
import { ChamadoSchema } from '../entities/chamado';
import { auditorDe, type HooksChamado } from './auditoria';
import { detectarTipo, type TipoDetectado, type MotivoArquivo } from './validacao-arquivo';

/**
 * Anexos (specs/04 §6, specs/09 §5): upload validado por conteúdo (magic bytes) e
 * download SEMPRE via URL pré-assinada emitida após `autorizar()` E respeitando a
 * visibilidade da mensagem dona (anexo de nota interna nunca vai ao cliente). A
 * chave de objeto tem prefixo por tenant; a linha guarda só metadados.
 */

/** Ator mínimo para autorização de anexo. */
export interface AtorAnexo {
  id: string;
  tenant_id: string;
  papel: Papel;
}

/** Arquivo recebido no upload (já em memória). */
export interface ArquivoUpload {
  nome_arquivo: string;
  buffer: Buffer;
}

/** Onde o anexo é vinculado (a descrição do chamado OU uma mensagem). */
export interface AlvoAnexo {
  chamado_id: string;
  mensagem_id?: string | null;
}

/**
 * Grava um anexo já VALIDADO (tipo detectado). Cria a linha, faz upload com chave
 * prefixada por tenant e emite `anexo_adicionado`. Uso interno (a autorização é do
 * chamador, que já validou a permissão de escrita na mensagem/descrição).
 */
export async function gravarAnexo(
  em: EntityManager,
  alvo: AlvoAnexo,
  arquivo: { nome_arquivo: string; buffer: Buffer; tipo: TipoDetectado },
  atorId: string | null,
  tenantId: string,
  hooks?: HooksChamado,
): Promise<string> {
  const anexoId = randomUUID();
  const storageKey = chaveAnexo(tenantId, alvo.chamado_id, anexoId);
  await em.insert(AnexoSchema, {
    id: anexoId,
    tenant_id: tenantId,
    chamado_id: alvo.mensagem_id ? null : alvo.chamado_id,
    mensagem_id: alvo.mensagem_id ?? null,
    nome_arquivo: arquivo.nome_arquivo.slice(0, 255),
    content_type: arquivo.tipo.contentType,
    tamanho_bytes: String(arquivo.buffer.length),
    storage_key: storageKey,
    checksum_sha256: createHash('sha256').update(arquivo.buffer).digest('hex'),
    inline: false,
  });
  await enviarObjeto(storageKey, arquivo.buffer, arquivo.tipo.contentType);
  await auditorDe(hooks)(em, {
    tipo: 'anexo_adicionado',
    chamado_id: alvo.chamado_id,
    ator_id: atorId,
    dados: { anexo_id: anexoId, mensagem_id: alvo.mensagem_id ?? null, inline: false },
  });
  return anexoId;
}

/** Resultado da autorização de download. */
export type MotivoDownload = 'inexistente' | 'sem_permissao';
export type ResultadoDownload =
  | {
      ok: true;
      storage_key: string;
      content_type: string;
      nome_arquivo: string;
      inline: boolean;
    }
  | { ok: false; motivo: MotivoDownload };

/**
 * Autoriza o download de um anexo e devolve os metadados para emitir a URL
 * assinada. Regras: RLS já isola o tenant (cross-tenant → `inexistente`); anexo de
 * mensagem `interna` NUNCA é servível ao cliente (specs/04 §6); leitura exige
 * pertencimento ao chamado (cliente → só os próprios).
 */
export async function autorizarDownloadAnexo(
  em: EntityManager,
  ator: AtorAnexo,
  anexoId: string,
): Promise<ResultadoDownload> {
  const anexo = await em.findOne(AnexoSchema, { where: { id: anexoId, deleted_at: IsNull() } });
  if (!anexo) return { ok: false, motivo: 'inexistente' };

  // Resolve o chamado dono e a visibilidade (via mensagem, quando houver).
  let chamadoId = anexo.chamado_id;
  let visibilidade: VisibilidadeMensagem = VisibilidadeMensagem.publica;
  if (anexo.mensagem_id) {
    const msg = await em.findOne(MensagemSchema, {
      where: { id: anexo.mensagem_id, deleted_at: IsNull() },
    });
    if (!msg) return { ok: false, motivo: 'inexistente' };
    chamadoId = msg.chamado_id;
    visibilidade = msg.visibilidade;
  }
  if (!chamadoId) return { ok: false, motivo: 'inexistente' };

  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) return { ok: false, motivo: 'inexistente' };

  // Fronteira inegociável: anexo de nota interna exige papel interno.
  if (
    visibilidade === VisibilidadeMensagem.interna &&
    !autorizar(ator, 'mensagem_interna', 'ler')
  ) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (
    !autorizar(ator, 'anexo', 'baixar', {
      cliente_id: chamado.cliente_id,
      tenant_id: chamado.tenant_id,
    })
  ) {
    return { ok: false, motivo: 'sem_permissao' };
  }

  return {
    ok: true,
    storage_key: anexo.storage_key,
    content_type: anexo.content_type,
    nome_arquivo: anexo.nome_arquivo,
    inline: anexo.inline,
  };
}

/** Lista os anexos NÃO-inline de uma mensagem (para render de "arquivos anexados"). */
export async function listarAnexosDaMensagem(
  em: EntityManager,
  mensagemId: string,
): Promise<Anexo[]> {
  return em.find(AnexoSchema, {
    where: { mensagem_id: mensagemId, inline: false, deleted_at: IsNull() },
    order: { created_at: 'ASC' },
  });
}

export type { MotivoArquivo };
export { detectarTipo };
