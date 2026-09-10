import { obterAppDataSource, runInTenantContext, autorizarDownloadAnexo } from '@chamados/db';
import { obterObjeto } from '@chamados/storage';
import { atorDe, exigirContexto, jsonErro } from '@/lib/api-v1';
import { contentDisposition } from '@/lib/anexos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Entrega um Anexo à API (specs/11 §4.7, D-035): autentica por **Bearer** e
 * autoriza com o MESMO `autorizarDownloadAnexo` da rota de cookie — RLS isola o
 * tenant, cliente só baixa dos próprios chamados e anexo de nota interna nunca
 * sai para cliente (specs/04 §6). Negação é sempre 404, sem vazar existência.
 *
 * Diferença deliberada da rota de cookie: aqui os bytes saem PELA APLICAÇÃO em
 * vez de um redirect para URL assinada do storage. O consumidor é um processo
 * (servidor MCP) que muitas vezes não alcança o bucket (MinIO interno à VPS) e
 * cujo `fetch` descarta o `Authorization` num redirect cross-origin. Os
 * controles de specs/09 §5 continuam: `Content-Type` pinado ao tipo validado no
 * upload, `Content-Disposition` seguro (attachment para tudo que não é imagem),
 * `nosniff` e sem cache.
 */
export async function GET(req: Request, ctxRota: { params: Promise<{ id: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const { id } = await ctxRota.params;
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, ctx.tenant.id, (em) =>
    autorizarDownloadAnexo(em, atorDe(ctx), id),
  );
  if (!r.ok) return jsonErro(404, 'anexo_inexistente', 'Anexo não encontrado.');

  const objeto = await obterObjeto(r.storage_key);
  if (!objeto) return jsonErro(404, 'anexo_inexistente', 'Anexo não encontrado.');

  return new Response(new Uint8Array(objeto.corpo), {
    status: 200,
    headers: {
      'content-type': r.content_type,
      'content-length': String(objeto.corpo.length),
      'content-disposition': contentDisposition(r.nome_arquivo, r.inline),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store, private',
    },
  });
}
