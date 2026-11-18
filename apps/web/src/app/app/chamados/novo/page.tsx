import Link from 'next/link';
import { ArrowLeft, UserPlus } from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  listarSistemasAlvo,
  listarClientesAtivosDoTenant,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import { exigirPapel } from '@/lib/sessao';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { NovoChamadoForm } from './novo-chamado-form';

/**
 * Novo chamado pelo painel (D-040, specs/04 §2, specs/08 §4.6): operador/admin
 * abrem um chamado EM NOME de um cliente ativo do tenant. Sem cliente ativo não
 * há solicitante possível — a tela orienta a convidar um (link para Usuários só
 * para quem pode convidar: admin).
 */
export default async function NovoChamadoPainelPage() {
  const { tenant, usuario } = await exigirPapel(Papel.operador, Papel.admin);
  const ds = await obterAppDataSource();
  const { sistemas, clientes } = await runInTenantContext(ds, tenant.id, async (em) => ({
    sistemas: await listarSistemasAlvo(em),
    clientes: await listarClientesAtivosDoTenant(em, usuario),
  }));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link
        href="/app/chamados"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Voltar à fila
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Novo chamado</h1>
        <p className="text-sm text-muted-foreground">
          Abra um chamado em nome de um cliente. Ele recebe a confirmação e a triagem automática
          começa em seguida.
        </p>
      </div>

      {clientes.length === 0 ? (
        <SemClientes podeConvidar={usuario.papel === Papel.admin} />
      ) : (
        <Card>
          <CardContent>
            <NovoChamadoForm
              sistemas={sistemas.map((s) => ({ id: s.id, nome: s.nome }))}
              clientes={clientes.map((c) => ({ value: c.id, label: c.nome, email: c.email }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SemClientes({ podeConvidar }: { podeConvidar: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card px-4 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <UserPlus className="size-5" />
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-medium">Nenhum cliente ativo ainda</p>
        <p className="text-sm text-muted-foreground">
          Todo chamado pertence a um cliente.{' '}
          {podeConvidar
            ? 'Convide o cliente em Usuários; assim que ele ativar a conta, você poderá abrir chamados em nome dele.'
            : 'Peça a um administrador para convidar o cliente; assim que ele ativar a conta, você poderá abrir chamados em nome dele.'}
        </p>
      </div>
      {podeConvidar && (
        <Link href="/app/usuarios" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <UserPlus className="size-3.5" />
          Convidar cliente
        </Link>
      )}
    </div>
  );
}
