import { obterAppDataSource, runInTenantContext, listarSistemasAlvo } from '@chamados/db';
import { exigirContexto, jsonOk } from '@/lib/api-v1';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sistemas-alvo ATIVOS do tenant (specs/11 §4.6) — o que o formulário de abertura
 * já mostra a qualquer papel (portal do cliente inclusive): só `id`, `nome` e
 * `descricao`. Nada de repositório, logs, BD ou credenciais (isso é `sistema_alvo
 * · ler`, da equipe, e não passa por aqui).
 *
 * Existe para que quem cria chamado pela API consiga escolher o alvo quando o
 * tenant tem MAIS de um sistema (specs/04 §2) — daí o `sistema_alvo_obrigatorio`
 * já vir calculado com a mesma regra que `criarChamado` aplica.
 */
export async function GET(req: Request): Promise<Response> {
  const ctx = await exigirContexto(req);
  if (ctx instanceof Response) return ctx;

  const ds = await obterAppDataSource();
  const sistemas = await runInTenantContext(ds, ctx.tenant.id, (em) => listarSistemasAlvo(em));

  return jsonOk({
    sistemas: sistemas.map((s) => ({ id: s.id, nome: s.nome, descricao: s.descricao })),
    sistema_alvo_obrigatorio: sistemas.length > 1,
  });
}
