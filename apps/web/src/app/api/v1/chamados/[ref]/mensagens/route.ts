import {
  obterAppDataSource,
  resolverIdChamado,
  criarMensagem,
  markdownParaDoc,
} from '@chamados/db';
import { VisibilidadeMensagem } from '@chamados/shared';
import {
  atorDe,
  exigirContexto,
  jsonErro,
  jsonOk,
  lerJson,
  respostaDeMotivo,
  textoDe,
} from '@/lib/api-v1';
import { valorEnum } from '@/lib/api-chamados';
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
 */
export async function POST(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

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

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();

  const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return { ok: false as const, motivo: 'chamado_inexistente' };
    return criarMensagem(
      em,
      atorDe(ctx),
      { chamado_id: id, visibilidade, corpo: markdownParaDoc(corpo) },
      hooks,
    );
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ id: r.id }, 201);
}
