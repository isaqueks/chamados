import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  obterAppDataSource,
  runInTenantContext,
  buscarSistemaAlvo,
  listarExecucoesDoSistema,
  permitirRepoLocal,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import { exigirPapel } from '@/lib/sessao';
import { Card, CardContent } from '@/components/ui/card';
import { SistemaForm } from '../sistema-form';
import { ConhecimentoSistemaCard } from './conhecimento-card';

export default async function EditarSistemaPage({ params }: { params: Promise<{ id: string }> }) {
  const { tenant, usuario } = await exigirPapel(Papel.admin);
  const { id } = await params;
  const ds = await obterAppDataSource();
  const { sistema, execucoesMapa } = await runInTenantContext(ds, tenant.id, async (em) => {
    const sistema = await buscarSistemaAlvo(em, id);
    if (!sistema) return { sistema: null, execucoesMapa: [] };
    const ator = { id: usuario.id, tenant_id: tenant.id, papel: usuario.papel };
    const execucoesMapa = await listarExecucoesDoSistema(em, ator, id, { limite: 5 });
    return { sistema, execucoesMapa };
  });
  if (!sistema) notFound();
  const repoLocalHabilitado = permitirRepoLocal();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/app/sistemas"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Sistemas-alvo
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{sistema.nome}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <SistemaForm sistema={sistema} permitirRepoLocal={repoLocalHabilitado} />
        </CardContent>
      </Card>

      <ConhecimentoSistemaCard sistema={sistema} execucoes={execucoesMapa} />
    </div>
  );
}
