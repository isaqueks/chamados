/**
 * Provisiona um tenant de PRODUÇÃO (specs/07 §3): tenant + agente_ia (service
 * account, criado pelo `provisionarTenant`) + categoria geral + admin HUMANO,
 * e ativa o tenant ao final. Idempotente: reexecutar não duplica nada.
 *
 * Diferente do `seed-dev`, NÃO cria dados de exemplo nem senhas conhecidas.
 *
 * Uso (na raiz do repo, com o .env do ambiente):
 *   npm run tenant:provisionar -- \
 *     --slug acme --nome "ACME Ltda" --exibicao "ACME Suporte" \
 *     --admin-email admin@empresa.com --admin-nome "Nome do Admin" \
 *     [--admin-senha "S3nh@Forte"] [--dominio suporte.empresa.com]
 *
 * Sem --admin-senha, uma senha forte é GERADA e impressa UMA ÚNICA vez no
 * console (troque-a no primeiro login). Nada de segredo é gravado em log.
 */
import { randomBytes } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { provisionarTenant, atualizarStatusTenant, criarUsuarioAtivoComSenha, existeContaPorEmail } =
  await import('../auth');
const { Papel, StatusTenant } = await import('@chamados/shared');

function arg(nome: string): string | null {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function exigirArg(nome: string): string {
  const v = arg(nome);
  if (!v) {
    console.error(
      `[provisionar-tenant] argumento obrigatório ausente: --${nome}\n` +
        'Uso: --slug <slug> --nome <nome> --exibicao <nome exibição> ' +
        '--admin-email <email> --admin-nome <nome> [--admin-senha <senha>] [--dominio <host>]',
    );
    process.exit(1);
  }
  return v;
}

/** Senha forte legível: 16 chars base64url + sufixo que garante as classes. */
function gerarSenhaForte(): string {
  return `${randomBytes(12).toString('base64url')}@A1`;
}

async function main(): Promise<void> {
  const slug = exigirArg('slug');
  const nome = exigirArg('nome');
  const exibicao = arg('exibicao') ?? nome;
  const adminEmail = exigirArg('admin-email');
  const adminNome = exigirArg('admin-nome');
  const senhaInformada = arg('admin-senha');
  const dominio = arg('dominio');

  const ds = criarAppDataSource();
  await ds.initialize();

  try {
    const prov = await provisionarTenant(ds, {
      slug,
      nome,
      nomeExibicao: exibicao,
      status: StatusTenant.em_provisionamento,
      ...(dominio ? { dominioProprio: dominio } : {}),
    });
    console.log(
      `[provisionar-tenant] tenant "${slug}" ${prov.criado ? 'CRIADO' : 'já existia'} ` +
        `(id=${prov.tenant_id}; agente_ia=${prov.agente_ia_id})`,
    );

    let senhaGerada: string | null = null;
    await runInTenantContext(ds, prov.tenant_id, async (em) => {
      if (await existeContaPorEmail(em, adminEmail)) {
        console.log(`[provisionar-tenant] admin ${adminEmail} já existe — senha mantida.`);
        return;
      }
      const senha = senhaInformada ?? (senhaGerada = gerarSenhaForte());
      await criarUsuarioAtivoComSenha(em, {
        tenant_id: prov.tenant_id,
        email: adminEmail,
        nome: adminNome,
        papel: Papel.admin,
        senha,
      });
      console.log(`[provisionar-tenant] admin ${adminEmail} criado.`);
    });

    await atualizarStatusTenant(ds, prov.tenant_id, StatusTenant.ativo);
    console.log(`[provisionar-tenant] tenant "${slug}" ATIVO.`);
    if (senhaGerada) {
      console.log(
        `[provisionar-tenant] SENHA INICIAL do admin (impressa só agora — troque no 1º login): ${senhaGerada}`,
      );
    }
  } finally {
    await ds.destroy();
  }
}

await main();
