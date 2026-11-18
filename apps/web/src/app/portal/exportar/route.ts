import {
  obterAppDataSource,
  runInTenantContext,
  exportarChamadosVisaoPublica,
  TETO_EXPORTACAO,
} from '@chamados/db';
import { gerarXlsx, MIME_XLSX } from '@chamados/db/planilha';
import { Papel } from '@chamados/shared';
import { obterContexto } from '@/lib/sessao';
import { contentDisposition } from '@/lib/anexos';
import { lerListaPortal, statusConsultadosPortal } from '@/lib/portal-lista';
import { nomeArquivoExportacao, planilhaPublica } from '@/lib/exportacao-chamados';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exportar Excel do PORTAL (D-045): o recorte que o cliente está vendo em
 * `/portal` (Meus/Todos, aba, status, busca), sem paginação, até
 * `TETO_EXPORTACAO` linhas, SÓ com as colunas da visão pública (specs/03 §7 —
 * sem complexidade, responsável interno, e-mails ou IA). Cookie de sessão; só o
 * papel `cliente` (a equipe exporta pela fila do painel). RLS escopa o tenant.
 */
export async function GET(req: Request) {
  const { tenant, usuario } = await obterContexto();
  if (!tenant || !usuario) return new Response('Não autenticado', { status: 401 });
  if (usuario.papel !== Papel.cliente) return new Response('Sem permissão', { status: 403 });

  const estado = lerListaPortal(new URL(req.url).searchParams);
  const ds = await obterAppDataSource();
  const { itens, truncado } = await runInTenantContext(ds, tenant.id, (em) =>
    exportarChamadosVisaoPublica(
      em,
      usuario,
      {
        meus: estado.ver === 'meus',
        status: statusConsultadosPortal(estado),
        busca: estado.busca || undefined,
      },
      TETO_EXPORTACAO,
    ),
  );

  const arquivo = gerarXlsx(planilhaPublica(itens, truncado, TETO_EXPORTACAO));
  const nome = nomeArquivoExportacao(tenant.slug, new Date(), truncado);
  return new Response(new Uint8Array(arquivo), {
    status: 200,
    headers: {
      'Content-Type': MIME_XLSX,
      'Content-Disposition': contentDisposition(nome, false),
      'Content-Length': String(arquivo.length),
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
