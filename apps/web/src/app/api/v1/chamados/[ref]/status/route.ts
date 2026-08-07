import { obterAppDataSource, resolverIdChamado, transicionarStatus } from '@chamados/db';
import { StatusChamado } from '@chamados/shared';
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
 * Transiciona o status do chamado (specs/11 §4.4).
 *
 * Quem decide é a MÁQUINA DE ESTADOS (specs/04 §1.3) dentro de
 * `transicionarStatus`, com o papel do token: um `cliente` só reabre um
 * `resolvido`; o guardrail humano-no-circuito continua valendo. A rota apenas
 * traduz o motivo de domínio em HTTP (409 para regra de negócio, 403 para papel).
 *
 * O `motivo` opcional entra no payload do `EventoChamado`, como em qualquer
 * mudança feita pela UI — a trilha de auditoria não distingue origem, mas o ator
 * registrado é o usuário do token (por isso a spec recomenda um usuário dedicado
 * para o MCP — specs/11 §7.3).
 */
export async function POST(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const corpoReq = await lerJson(req);
  if (!corpoReq) return jsonErro(400, 'corpo_invalido', 'Envie um JSON com "status".');

  const statusBruto = textoDe(corpoReq.status);
  if (!statusBruto) {
    return jsonErro(
      400,
      'parametro_invalido',
      `Informe "status". Valores: ${Object.values(StatusChamado).join(', ')}.`,
    );
  }
  const status = valorEnum(StatusChamado, statusBruto);
  if (!status) {
    return jsonErro(
      400,
      'parametro_invalido',
      `Status inválido: "${statusBruto}". Valores: ${Object.values(StatusChamado).join(', ')}.`,
    );
  }
  const motivo = textoDe(corpoReq.motivo) ?? undefined;

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();

  const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return { ok: false as const, motivo: 'inexistente' };
    return transicionarStatus(em, atorDe(ctx), id, status, { motivo }, hooks);
  });

  if (!r.ok) return respostaDeMotivo(r.motivo);
  return jsonOk({ status: r.chamado.status });
}
