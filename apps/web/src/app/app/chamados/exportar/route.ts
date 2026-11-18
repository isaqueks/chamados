import {
  obterAppDataSource,
  runInTenantContext,
  exportarFilaChamados,
  TETO_EXPORTACAO,
} from '@chamados/db';
import { gerarXlsx, MIME_XLSX } from '@chamados/db/planilha';
import { Papel } from '@chamados/shared';
import { obterContexto } from '@/lib/sessao';
import { contentDisposition } from '@/lib/anexos';
import { lerEstadoFila, paraFiltrosFila } from '@/lib/fila-params';
import { nomeArquivoExportacao, planilhaEquipe } from '@/lib/exportacao-chamados';

// Runtime Node (pg + node:zlib) e nunca pré-renderizada.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exportar Excel da fila (D-045, specs/08 §4.4): baixa um `.xlsx` com TODOS os
 * chamados do recorte atual (mesmos parâmetros da URL de `/app/chamados`, sem
 * paginação), até `TETO_EXPORTACAO` linhas. Autenticação pelo COOKIE de sessão
 * (mesmo caminho de `/api/anexos/[id]`); só operador/admin — `403` para os
 * demais papéis. A consulta roda em `runInTenantContext` (RLS escopa o tenant) e
 * reaproveita `aplicarFiltros` da fila: a planilha é exatamente o que a tela lista.
 */
export async function GET(req: Request) {
  const { tenant, usuario } = await obterContexto();
  if (!tenant || !usuario) return new Response('Não autenticado', { status: 401 });
  if (usuario.papel !== Papel.operador && usuario.papel !== Papel.admin) {
    return new Response('Sem permissão', { status: 403 });
  }

  const estado = lerEstadoFila(new URL(req.url).searchParams);
  const ds = await obterAppDataSource();
  const { itens, truncado } = await runInTenantContext(ds, tenant.id, (em) =>
    exportarFilaChamados(em, usuario, paraFiltrosFila(estado, false), TETO_EXPORTACAO),
  );

  const arquivo = gerarXlsx(planilhaEquipe(itens, truncado, TETO_EXPORTACAO));
  const nome = nomeArquivoExportacao(tenant.slug, new Date(), truncado);
  return new Response(new Uint8Array(arquivo), {
    status: 200,
    headers: {
      'Content-Type': MIME_XLSX,
      'Content-Disposition': contentDisposition(nome, false),
      'Content-Length': String(arquivo.length),
      // Dados do tenant: nunca em cache compartilhado nem no disco do navegador.
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      // Informativo para clientes HTTP (o navegador só vê o nome do arquivo/aba).
      'X-Exportacao-Linhas': String(itens.length),
      'X-Exportacao-Truncada': truncado ? '1' : '0',
    },
  });
}
