import {
  obterAppDataSource,
  resolverIdChamado,
  criarMensagem,
  markdownParaDoc,
  listarAnexosVisiveis,
  type EntradaMensagem,
} from '@chamados/db';
import { VisibilidadeMensagem } from '@chamados/shared';
import {
  atorDe,
  exigirContexto,
  type ContextoApi,
  jsonErro,
  jsonOk,
  lerJson,
  respostaDeMotivo,
  textoDe,
} from '@/lib/api-v1';
import { projetarAnexo, valorEnum } from '@/lib/api-chamados';
import { ehMultipart, lerFormularioMultipart, parsearMensagemMultipart } from '@/lib/api-upload';
import { comDespacho } from '@/lib/despacho';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Publica uma mensagem na timeline (specs/11 §4.3): `publica` (visível ao cliente)
 * ou `interna` (nota da equipe).
 *
 * Três coisas herdadas do domínio, deliberadamente NÃO reimplementadas aqui:
 *  - **Autorização**: `criarMensagem` chama `autorizar()` — cliente escrevendo
 *    nota interna é recusado na fronteira real (specs/03 §7), não na UI.
 *  - **Sanitização**: o corpo chega em MARKDOWN e passa pelo mesmo
 *    `markdownParaDoc` + pipeline de validação/sanitização do editor (specs/04 §5).
 *    Nunca aceitamos HTML cru.
 *  - **Efeitos**: `comDespacho` liga a mutação aos MESMOS pipelines da UI —
 *    notificações e, quando é resposta pública de cliente, re-enfileiramento da
 *    triagem (specs/05 §2). Uma mensagem publicada pela API não é de segunda classe.
 *    Inclui a auto-atribuição (D-039): resposta `publica` de operador/admin torna
 *    o usuário do token o responsável — regra de `criarMensagem`, não desta rota.
 *
 * Duas formas de corpo (D-046):
 *  - **JSON** `{visibilidade, corpo}` — só texto, como sempre;
 *  - **`multipart/form-data`** `visibilidade`, `corpo`, `arquivos` (0..N) —
 *    imagens aparecem NA conversa (marcador `![x](anexo:nome.png)` ou ao fim do
 *    corpo), os demais tipos viram anexos. Validação, limites, `anexo · enviar` e
 *    storage são os da UI (`criarMensagem` → `gravarAnexo`/`materializarDoc`);
 *    qualquer arquivo inválido recusa TUDO antes de um INSERT ou upload.
 *
 * Resposta `201 { id, anexos: [...] }` (`anexos` na projeção do detalhe).
 */
export async function POST(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const { ref } = await ctxRota.params;
  if (ehMultipart(req.headers.get('content-type'))) {
    const lido = await lerFormularioMultipart(req);
    if (!lido.ok) return jsonErro(lido.status, lido.codigo, lido.erro);
    const parse = await parsearMensagemMultipart(lido.form);
    if (!parse.ok) return jsonErro(parse.status, parse.codigo, parse.erro);
    const { visibilidade, corpo } = parse.mensagem;
    return publicar(ctx, ref, {
      visibilidade,
      corpo: corpo.doc,
      anexos: corpo.anexos.length > 0 ? corpo.anexos : undefined,
      imagens_inline: corpo.imagens.length > 0 ? corpo.imagens : undefined,
    });
  }

  const corpoReq = await lerJson(req);
  if (!corpoReq) {
    return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "visibilidade" e "corpo".');
  }

  const visBruta = textoDe(corpoReq.visibilidade);
  if (!visBruta) {
    return jsonErro(400, 'parametro_invalido', 'Informe "visibilidade": "publica" ou "interna".');
  }
  const visibilidade = valorEnum(VisibilidadeMensagem, visBruta);
  if (!visibilidade) {
    return jsonErro(400, 'parametro_invalido', 'Visibilidade deve ser "publica" ou "interna".');
  }

  const corpo = textoDe(corpoReq.corpo);
  if (!corpo) return jsonErro(400, 'corpo_invalido', 'O campo "corpo" não pode ser vazio.');

  return publicar(ctx, ref, { visibilidade, corpo: markdownParaDoc(corpo) });
}

/**
 * Publica pelo domínio (as duas formas de corpo convergem aqui) e devolve os
 * anexos criados, lidos na MESMA transação (RLS do tenant).
 */
async function publicar(
  ctx: ContextoApi,
  ref: string,
  entrada: Omit<EntradaMensagem, 'chamado_id'>,
): Promise<Response> {
  const ds = await obterAppDataSource();
  const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return { ok: false as const, motivo: 'chamado_inexistente' };
    const criada = await criarMensagem(em, atorDe(ctx), { ...entrada, chamado_id: id }, hooks);
    if (!criada.ok) return criada;
    const anexos = (await listarAnexosVisiveis(em, id, [criada.id])).filter(
      (a) => a.mensagem_id === criada.id,
    );
    return { ok: true as const, id: criada.id, anexos };
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ id: r.id, anexos: r.anexos.map(projetarAnexo) }, 201);
}
