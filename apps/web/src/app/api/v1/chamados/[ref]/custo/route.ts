import {
  obterAppDataSource,
  resolverIdChamado,
  obterChamado,
  definirEstimativaCusto,
  definirCustoFinal,
} from '@chamados/db';
import { autorizar } from '@chamados/shared';
import { atorDe, exigirContexto, jsonErro, jsonOk, lerJson, respostaDeMotivo } from '@/lib/api-v1';
import { parsearCusto } from '@/lib/api-chamados';
import { comDespacho } from '@/lib/despacho';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Define a ESTIMATIVA DE CUSTO e/ou o CUSTO FINAL do chamado (specs/11 §4.10 —
 * D-043). Corpo: `{ "estimativa_custo"?: "A".."E"|"I"|null, "custo_final"?:
 * number|null }` — chave ausente não mexe, `null` limpa.
 *
 * Rota fina sobre os MESMOS `definirEstimativaCusto`/`definirCustoFinal` do
 * painel, numa transação só (as duas mudanças entram juntas ou nenhuma):
 *  - estimativa: qualquer status não encerrado (fechado/cancelado → `409
 *    estado_terminal`); mudou → evento + webhook `estimativa_custo_alterada`;
 *  - custo final: só com o chamado em `resolvido` (`409
 *    custo_fora_da_resolucao`); para informá-lo AO resolver, use `POST
 *    …/status` com `custo_final`; mudou → evento + webhook `custo_final_definido`.
 * Idempotente: repetir o mesmo valor não grava evento nem dispara webhook.
 *
 * Como em `/ia` e `/atribuicao`, o `cliente` (que LÊ os dois campos) recebe
 * `403` ANTES de resolver o `{ref}` — 403/404 por chamado vazaria existência.
 */
export async function POST(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  if (!autorizar(atorDe(ctx), 'chamado', 'definir_custo', { tenant_id: ctx.tenant.id })) {
    return jsonErro(403, 'sem_permissao', 'Seu papel não permite definir o custo de chamados.');
  }

  const corpoReq = await lerJson(req);
  if (!corpoReq) {
    return jsonErro(
      400,
      'corpo_invalido',
      'Envie um JSON com "estimativa_custo" e/ou "custo_final".',
    );
  }
  const parse = parsearCusto(corpoReq);
  if (!parse.ok) return jsonErro(400, parse.codigo, parse.erro);

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();
  const ator = atorDe(ctx);

  // Uma recusa no meio (ex.: custo fora do resolvido) desfaz também a
  // estimativa: o throw sai de `comDespacho` e a transação faz rollback.
  class Recusa extends Error {
    constructor(readonly motivo: string) {
      super(motivo);
    }
  }

  try {
    const r = await comDespacho(ds, ctx.tenant.id, async (em, hooks) => {
      const id = await resolverIdChamado(em, decodeURIComponent(ref));
      if (!id) throw new Recusa('inexistente');
      if (parse.estimativa !== undefined) {
        const e = await definirEstimativaCusto(em, ator, id, parse.estimativa, hooks);
        if (!e.ok) throw new Recusa(e.motivo);
      }
      if (parse.custoFinal !== undefined) {
        const c = await definirCustoFinal(em, ator, id, parse.custoFinal, hooks);
        if (!c.ok) throw new Recusa(c.motivo);
      }
      const atual = await obterChamado(em, ator, id);
      return {
        estimativa_custo: atual?.estimativa_custo ?? null,
        custo_final: atual?.custo_final ?? null,
      };
    });
    return jsonOk(r);
  } catch (err) {
    if (err instanceof Recusa) return respostaDeMotivo(err.motivo);
    throw err;
  }
}
