import {
  obterAppDataSource,
  resolverIdChamado,
  atribuirOperador,
  desatribuirOperador,
} from '@chamados/db';
import { autorizar } from '@chamados/shared';
import { atorDe, exigirContexto, jsonErro, jsonOk, lerJson, respostaDeMotivo } from '@/lib/api-v1';
import { parsearAtribuicao } from '@/lib/api-chamados';
import { comDespacho } from '@/lib/despacho';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Atribui (`operador_id: uuid`) ou desatribui (`operador_id: null`) o chamado
 * (specs/11 §4.9 — D-036 L4). É como um integrador (a Forja) marca quem está
 * implementando, sem criar status novo.
 *
 * Rota fina sobre os MESMOS `atribuirOperador`/`desatribuirOperador` do painel:
 * `autorizar(chamado · atribuir)` decide (operador/admin), os terminais recusam
 * (`409 estado_terminal`) e o alvo precisa ser operador/admin ATIVO deste tenant
 * — a busca roda sob RLS, então um usuário de outro tenant não é encontrado e
 * vira `400 parametro_invalido`, igual a um id inexistente.
 *
 * Ao contrário de L1, o serviço NÃO é idempotente: reatribuir à mesma pessoa
 * grava outro `EventoChamado` e notifica de novo (notificação `atribuicao`,
 * obrigatória para o operador destino, e webhook). Quem integra compara antes.
 */
export async function POST(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  // O MESMO `autorizar()` que o serviço aplica, consultado ANTES de resolver o
  // `{ref}`: a ação nunca é do `cliente`, em chamado nenhum — responder 403 só
  // quando o chamado existe e 404 quando não existe vazaria a existência de
  // chamados alheios. O serviço continua checando (defesa em profundidade).
  if (!autorizar(atorDe(ctx), 'chamado', 'atribuir')) {
    return jsonErro(403, 'sem_permissao', 'Seu papel não permite atribuir chamados.');
  }

  const corpoReq = await lerJson(req);
  if (!corpoReq) return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "operador_id".');
  const parse = parsearAtribuicao(corpoReq);
  if (!parse.ok) return jsonErro(400, parse.codigo, parse.erro);
  const { operadorId } = parse;

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();

  const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return { ok: false as const, motivo: 'inexistente' };
    return operadorId === null
      ? desatribuirOperador(em, atorDe(ctx), id, hooks)
      : atribuirOperador(em, atorDe(ctx), id, operadorId, hooks);
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ operador_id: operadorId });
}
