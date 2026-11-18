import {
  obterAppDataSource,
  runInTenantContext,
  listarChamados,
  criarChamado,
  markdownParaDoc,
  buscarUsuarioAtivoPorEmail,
  listarAnexosVisiveis,
  type ArquivoUpload,
  type DocRico,
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
  ehEquipe,
  idsDeChamados,
  parsearEntradaCriar,
  parsearFiltros,
  projetarAnexo,
  projetarItemLista,
  type EntradaCriarApi,
} from '@/lib/api-chamados';
import { ehMultipart, lerFormularioMultipart, parsearCriarMultipart } from '@/lib/api-upload';
import { comDespacho } from '@/lib/despacho';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lista/filtra chamados (specs/11 §4.1). Delega a `listarChamados`: todo papel
 * lista o tenant (o cliente também, desde a D-037, sempre pela projeção pública do
 * serializer de specs/03 §7); `meus=true` recorta para os chamados em que o
 * usuário é o solicitante. A API não reimplementa nada disso. RLS isola o tenant.
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

  // `complexidade` é interna (specs/04 §3.3): filtrar por ela revelaria o campo
  // ao cliente pelo conjunto do resultado. Recusa explícita (D-036 L3) em vez de
  // ignorar — o mesmo princípio do filtro que não mente.
  if (parse.filtros.complexidade && !ehEquipe(ctx.usuario.papel)) {
    return jsonErro(403, 'sem_permissao', 'O filtro "complexidade" é exclusivo da equipe.');
  }
  // Mesma razão para `atribuicao`: o responsável é interno (specs/03 §7) e, com a
  // leitura do tenant inteiro (D-037), o filtro o revelaria pelo conjunto.
  if (parse.filtros.atribuicao && !ehEquipe(ctx.usuario.papel)) {
    return jsonErro(403, 'sem_permissao', 'O filtro "atribuicao" é exclusivo da equipe.');
  }

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
 * `estimativa_custo` (D-043, opcional): só a equipe — vinda de `cliente`, o
 * domínio recusa com `403`.
 *
 * O solicitante da equipe pode vir por `solicitante_email` (o que um assistente
 * conhece) ou `solicitante_id`; a resolução por e-mail é escopada ao tenant pela
 * RLS e exige conta ATIVA com papel `cliente` — a mesma regra do serviço.
 *
 * `multipart/form-data` (D-046): os mesmos campos como partes de texto +
 * `arquivos` só de IMAGEM, que entram na descrição (marcador
 * `![x](anexo:nome.png)` ou ao fim) pelo mesmo pipeline das imagens coladas no
 * portal. Resposta `201 { id, numero, anexos }`.
 */
export async function POST(req: Request): Promise<Response> {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  let entrada: EntradaCriarApi;
  let descricao: DocRico;
  let imagens: ArquivoUpload[] = [];
  if (ehMultipart(req.headers.get('content-type'))) {
    const lido = await lerFormularioMultipart(req);
    if (!lido.ok) return jsonErro(lido.status, lido.codigo, lido.erro);
    const parse = await parsearCriarMultipart(lido.form);
    if (!parse.ok) return jsonErro(parse.status, parse.codigo, parse.erro);
    ({ entrada, imagens } = parse);
    descricao = parse.doc;
  } else {
    const corpoReq = await lerJson(req);
    if (!corpoReq) {
      return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "titulo" e "descricao".');
    }
    const parse = parsearEntradaCriar(corpoReq);
    if (!parse.ok) return jsonErro(400, parse.codigo, parse.erro);
    entrada = parse.entrada;
    descricao = markdownParaDoc(entrada.descricao);
  }

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
    const criado = await criarChamado(
      em,
      atorDe(ctx),
      {
        titulo: entrada.titulo,
        descricao,
        imagens_inline: imagens.length > 0 ? imagens : undefined,
        natureza: entrada.natureza,
        prioridade: entrada.prioridade,
        sistema_alvo_id: entrada.sistema_alvo_id,
        categoria_id: entrada.categoria_id,
        cliente_id,
        estimativa_custo: entrada.estimativa_custo,
      },
      hooks,
    );
    if (!criado.ok) return criado;
    // Anexos da descrição (as imagens enviadas), na MESMA transação.
    const anexos = await listarAnexosVisiveis(em, criado.id, []);
    return { ...criado, anexos };
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ id: r.id, numero: Number(r.numero), anexos: r.anexos.map(projetarAnexo) }, 201);
}
