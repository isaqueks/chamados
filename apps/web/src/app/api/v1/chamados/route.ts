import {
  obterAppDataSource,
  runInTenantContext,
  listarChamados,
  criarChamado,
  markdownParaDoc,
  buscarUsuarioAtivoPorEmail,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import {
  atorDe,
  exigirContexto,
  jsonErro,
  jsonOk,
  lerJson,
  resolverNomes,
  respostaDeMotivo,
} from '@/lib/api-v1';
import {
  idsDeChamados,
  parsearEntradaCriar,
  parsearFiltros,
  projetarItemLista,
} from '@/lib/api-chamados';
import { comDespacho } from '@/lib/despacho';

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

/**
 * Abre um chamado (specs/11 §4.5) com o MESMO formulário mínimo do portal
 * (specs/04 §2): título, descrição em markdown, natureza opcional (default
 * `problema` — a IA reclassifica na triagem, D-017), prioridade opcional e o
 * sistema-alvo quando o tenant tem mais de um.
 *
 * Quem decide é o domínio, não esta rota: `criarChamado` chama `autorizar()`
 * (cliente abre para si; operador/admin abrem EM NOME DE um cliente; `agente_ia`
 * nunca), resolve o alvo (1 sistema → automático; 0 → categoria geral; >1 → exige
 * escolha) e valida limites. `comDespacho` liga a criação aos MESMOS efeitos da
 * UI: evento de auditoria, notificação e enfileiramento da triagem — um chamado
 * aberto pela API não é de segunda classe.
 *
 * O solicitante da equipe pode vir por `solicitante_email` (o que um assistente
 * conhece) ou `solicitante_id`; a resolução por e-mail é escopada ao tenant pela
 * RLS e exige conta ATIVA com papel `cliente` — a mesma regra do serviço.
 */
export async function POST(req: Request): Promise<Response> {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const corpoReq = await lerJson(req);
  if (!corpoReq) {
    return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "titulo" e "descricao".');
  }
  const parse = parsearEntradaCriar(corpoReq);
  if (!parse.ok) return jsonErro(400, parse.codigo, parse.erro);
  const { entrada } = parse;

  // Cliente abre SÓ para si (specs/04 §2): um "solicitante" vindo dele seria
  // ignorado em silêncio pelo serviço — melhor recusar do que fingir que valeu.
  if (
    ctx.usuario.papel === Papel.cliente &&
    (entrada.solicitante_email || entrada.solicitante_id)
  ) {
    return jsonErro(
      403,
      'sem_permissao',
      'Cliente abre chamado apenas para si: não informe "solicitante_email"/"solicitante_id".',
    );
  }

  const ds = await obterAppDataSource();
  const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
    let cliente_id = entrada.solicitante_id;
    if (entrada.solicitante_email) {
      const solicitante = await buscarUsuarioAtivoPorEmail(em, entrada.solicitante_email);
      if (!solicitante || solicitante.papel !== Papel.cliente) {
        return { ok: false as const, motivo: 'solicitante_invalido' as const };
      }
      cliente_id = solicitante.id;
    }
    return criarChamado(
      em,
      atorDe(ctx),
      {
        titulo: entrada.titulo,
        descricao: markdownParaDoc(entrada.descricao),
        natureza: entrada.natureza,
        prioridade: entrada.prioridade,
        sistema_alvo_id: entrada.sistema_alvo_id,
        categoria_id: entrada.categoria_id,
        cliente_id,
      },
      hooks,
    );
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ id: r.id, numero: Number(r.numero) }, 201);
}
