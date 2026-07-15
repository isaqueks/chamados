import { obterAppDataSource, runInTenantContext, autorizarDownloadAnexo } from '@chamados/db';
import { urlAssinadaGet } from '@chamados/storage';
import { obterContexto } from '@/lib/sessao';

// Precisa do runtime Node (aws-sdk/pg) e nunca é pré-renderizado.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve um Anexo (specs/04 §6, specs/09 §5). O download é SEMPRE via URL
 * pré-assinada de curta duração, emitida SÓ após `autorizar()` E respeitando a
 * visibilidade da mensagem dona (anexo de nota interna nunca vai ao cliente). RLS
 * isola o tenant. Respostas de negação usam 404 para não vazar existência.
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

  // URL pré-assinada de curta duração (5 min) — objeto no bucket privado.
  const url = await urlAssinadaGet(r.storage_key, 300);
  return Response.redirect(url, 302);
}
