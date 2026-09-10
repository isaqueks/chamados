import {
  obterAppDataSource,
  runInTenantContext,
  resolverIdChamado,
  obterChamado,
  listarMensagens,
  listarAnexosVisiveis,
} from '@chamados/db';
import { atorDe, exigirContexto, jsonErro, jsonOk, resolverNomes } from '@/lib/api-v1';
import {
  agruparAnexos,
  idsDeChamados,
  idsDeMensagens,
  parsearFormato,
  projetarDetalhe,
  projetarMensagens,
  FORMATOS_CORPO,
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
 *
 * `?formato=texto|markdown|html` (D-035) escolhe a projeção do corpo; `anexos`
 * (da descrição e por mensagem, imagens inline incluídas) vêm de
 * `listarAnexosVisiveis` alimentada SÓ com os ids das mensagens que o papel já
 * recebeu — anexo de nota interna nunca chega ao cliente, por construção.
 */
export async function GET(req: Request, ctxRota: { params: Promise<{ ref: string }> }) {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const formato = parsearFormato(new URL(req.url).searchParams.get('formato'));
  if (!formato) {
    return jsonErro(
      400,
      'parametro_invalido',
      `Parâmetro "formato" inválido. Valores: ${FORMATOS_CORPO.join(', ')}.`,
    );
  }

  const { ref } = await ctxRota.params;
  const ds = await obterAppDataSource();

  const dados = await runInTenantContext(ds, ctx.tenant.id, async (em) => {
    const id = await resolverIdChamado(em, decodeURIComponent(ref));
    if (!id) return null;

    const ator = atorDe(ctx);
    const chamado = await obterChamado(em, ator, id);
    if (!chamado) return null; // inexistente OU fora do escopo do papel: mesma resposta.

    const mensagens = await listarMensagens(em, ator, id);
    const anexos = await listarAnexosVisiveis(
      em,
      id,
      mensagens.map((m) => m.id),
    );
    const idsChamado = idsDeChamados([chamado]);
    const nomes = await resolverNomes(em, {
      usuarios: [...idsChamado.usuarios, ...idsDeMensagens(mensagens)],
      sistemas: idsChamado.sistemas,
      categorias: idsChamado.categorias,
    });
    return { chamado, mensagens, anexos, nomes };
  });

  if (!dados) return jsonErro(404, 'chamado_inexistente', 'Chamado não encontrado.');

  const { descricao, porMensagem } = agruparAnexos(dados.anexos);
  return jsonOk({
    chamado: projetarDetalhe(dados.chamado, dados.nomes, { formato, anexos: descricao }),
    mensagens: projetarMensagens(dados.mensagens, dados.nomes, {
      formato,
      anexosPorMensagem: porMensagem,
    }),
  });
}
