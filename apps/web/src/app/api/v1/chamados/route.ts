import { obterAppDataSource, runInTenantContext, listarChamados } from '@chamados/db';
import { atorDe, exigirContexto, jsonErro, jsonOk, resolverNomes } from '@/lib/api-v1';
import { idsDeChamados, parsearFiltros, projetarItemLista } from '@/lib/api-chamados';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lista/filtra chamados (specs/11 §4.1). Delega a `listarChamados`, que já aplica
 * o ESCOPO POR PAPEL (cliente → só os próprios; equipe → o tenant) e o serializer
 * de specs/03 §7 — a API não reimplementa nada disso. RLS isola o tenant.
 *
 * Filtro com valor fora do domínio é rejeitado (400), nunca ignorado: devolver
 * "tudo" quando o cliente pediu `status=aberto` seria mentir sobre o resultado.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const parse = parsearFiltros(url.searchParams);
  if (!parse.ok) return jsonErro(400, 'parametro_invalido', parse.erro);

  const ds = await obterAppDataSource();
  const { itens, proximoCursor, nomes } = await runInTenantContext(
    ds,
    ctx.tenant.id,
    async (em) => {
      const pagina = await listarChamados(em, atorDe(ctx), parse.filtros);
      const nomes = await resolverNomes(em, idsDeChamados(pagina.itens));
      return { ...pagina, nomes };
    },
  );

  return jsonOk({
    itens: itens.map((c) => projetarItemLista(c, nomes)),
    proximo_cursor: proximoCursor,
  });
}
