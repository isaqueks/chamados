import { obterAppDataSource, resolverIdChamado, definirSilencioIa } from '@chamados/db';
import { autorizar } from '@chamados/shared';
import { atorDe, exigirContexto, jsonErro, jsonOk, lerJson, respostaDeMotivo } from '@/lib/api-v1';
import { parsearSilencioIa } from '@/lib/api-chamados';
import { comDespacho } from '@/lib/despacho';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Silencia/reativa a IA no chamado (specs/11 §4.8 — D-036 L1).
 *
 * Existe para um integrador (a Forja) tirar a triagem automática do caminho
 * enquanto implementa: uma mensagem do cliente re-dispara a triagem (specs/05
 * §2), que poderia responder ao cliente, gerar SPEC nova e abrir PR concorrente.
 *
 * Rota fina sobre o MESMO `definirSilencioIa` do painel: `autorizar(chamado ·
 * silenciar_ia)` decide (operador/admin; cliente e agente_ia nunca — D-024), os
 * terminais recusam (`409 estado_terminal`) e repetir o valor atual é no-op sem
 * evento — idempotente por construção do serviço, não da rota. O evento
 * `ia_silenciada`/`ia_reativada` é interno: não notifica nem dispara webhook.
 */
export async function POST(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  // O MESMO `autorizar()` que o serviço aplica, consultado ANTES de resolver o
  // `{ref}`: a ação nunca é do `cliente`, em chamado nenhum — responder 403 só
  // quando o chamado existe e 404 quando não existe vazaria a existência de
  // chamados alheios. O serviço continua checando (defesa em profundidade).
  if (!autorizar(atorDe(ctx), 'chamado', 'silenciar_ia')) {
    return jsonErro(403, 'sem_permissao', 'Seu papel não permite silenciar/reativar a IA.');
  }

  const corpoReq = await lerJson(req);
  if (!corpoReq) return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "silenciada".');
  const parse = parsearSilencioIa(corpoReq);
  if (!parse.ok) return jsonErro(400, parse.codigo, parse.erro);

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();

  const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return { ok: false as const, motivo: 'inexistente' };
    return definirSilencioIa(em, atorDe(ctx), id, parse.silenciada, hooks);
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ ia_silenciada: parse.silenciada });
}
