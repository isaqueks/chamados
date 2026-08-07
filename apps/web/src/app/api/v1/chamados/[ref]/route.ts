import {
  obterAppDataSource,
  runInTenantContext,
  resolverIdChamado,
  obterChamado,
  listarMensagens,
} from '@chamados/db';
import { atorDe, exigirContexto, jsonErro, jsonOk, resolverNomes } from '@/lib/api-v1';
import {
  idsDeChamados,
  idsDeMensagens,
  projetarDetalhe,
  projetarMensagens,
} from '@/lib/api-chamados';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Detalhe do chamado + TIMELINE (specs/11 §4.2). `{ref}` é o UUID ou o número
 * legível (`12`/`#12` — como a equipe fala).
 *
 * A fronteira de visibilidade é do domínio, não desta rota: `obterChamado` devolve
 * `null` para chamado de outro cliente (→ 404, sem vazar existência) e
 * `listarMensagens` filtra `visibilidade='publica'` NO REPOSITÓRIO quando o papel
 * é `cliente`, com o serializer de specs/03 §7 como segunda barreira. Notas
 * internas chegam apenas a operador/admin.
 */
export async function GET(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();

  const dados = await runInTenantContext(ds, ctx.tenant.id, async (em) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return null;

    const ator = atorDe(ctx);
    const chamado = await obterChamado(em, ator, id);
    if (!chamado) return null; // inexistente OU fora do escopo do papel: mesma resposta.

    const mensagens = await listarMensagens(em, ator, id);
    const idsChamado = idsDeChamados([chamado]);
    const nomes = await resolverNomes(em, {
      usuarios: [...idsChamado.usuarios, ...idsDeMensagens(mensagens)],
      sistemas: idsChamado.sistemas,
      categorias: idsChamado.categorias,
    });
    return { chamado, mensagens, nomes };
  });

  if (!dados) return jsonErro(404, 'chamado_inexistente', 'Chamado não encontrado.');

  return jsonOk({
    chamado: projetarDetalhe(dados.chamado, dados.nomes),
    mensagens: projetarMensagens(dados.mensagens, dados.nomes),
  });
}
