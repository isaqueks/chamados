import { obterAppDataSource, runInTenantContext, autorizarDownloadAnexo } from '@chamados/db';
import { urlAssinadaGet } from '@chamados/storage';
import { obterContexto } from '@/lib/sessao';

// Precisa do runtime Node (aws-sdk/pg) e nunca é pré-renderizado.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** TTL curto da URL assinada (specs/09 §5): tempo só para o browser seguir o 302. */
const TTL_URL_ASSINADA_S = 120;

/** Sanitiza o nome de arquivo para o header `Content-Disposition` (ASCII seguro). */
function nomeAscii(nome: string): string {
  // Remove aspas/controles/barras e limita o tamanho — evita quebra de header.
  return (
    nome
      .replace(/[\r\n"\\/]+/g, '_')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 200) || 'arquivo'
  );
}

/**
 * Monta um `Content-Disposition` seguro. Imagens inline do rich text são exibidas
 * (`inline`); qualquer outro anexo é forçado a DOWNLOAD (`attachment`) — nunca
 * renderizado no contexto da aplicação. `filename*` (RFC 5987) preserva o nome
 * original em UTF-8; `filename` ASCII é o fallback.
 */
function contentDisposition(nome: string, inline: boolean): string {
  const tipo = inline ? 'inline' : 'attachment';
  const ascii = nomeAscii(nome);
  const utf8 = encodeURIComponent(nome).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16),
  );
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Serve um Anexo (specs/04 §6, specs/09 §5). O download é SEMPRE via URL
 * pré-assinada de curta duração, emitida SÓ após `autorizar()` E respeitando a
 * visibilidade da mensagem dona (anexo de nota interna nunca vai ao cliente). RLS
 * isola o tenant. Respostas de negação usam 404 para não vazar existência.
 *
 * Como o download é um REDIRECT direto ao storage, forçamos na URL assinada o
 * `Content-Type` REAL (validado por magic bytes no upload) e um
 * `Content-Disposition` seguro (attachment p/ não-imagens) — impedindo que um
 * arquivo seja renderizado/executado como HTML/script pelo browser.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { tenant, usuario } = await obterContexto();
  if (!tenant || !usuario) return new Response('Não autenticado', { status: 401 });

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    autorizarDownloadAnexo(em, usuario, id),
  );
  if (!r.ok) return new Response('Não encontrado', { status: 404 });

  // URL pré-assinada de curta duração com cabeçalhos de resposta seguros.
  const url = await urlAssinadaGet(r.storage_key, TTL_URL_ASSINADA_S, {
    contentType: r.content_type,
    contentDisposition: contentDisposition(r.nome_arquivo, r.inline),
  });
  return Response.redirect(url, 302);
}
