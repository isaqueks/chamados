import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { obterAppDataSource, runInTenantContext, listarSistemasAlvo } from '@chamados/db';
import { exigirUsuario } from '@/lib/sessao';
import { Card, CardContent } from '@/components/ui/card';
import { ChamadoNovoForm } from './chamado-form';

/**
 * Abrir chamado (specs/04 §2, specs/08 §4.1) — formulário mínimo. O sistema-alvo
 * só aparece quando o tenant tem mais de um ativo; caso contrário é resolvido no
 * servidor (único sistema ou categoria geral).
 */
export default async function NovoChamadoPage() {
  const { tenant } = await exigirUsuario();
  const ds = await obterAppDataSource();
  const sistemas = await runInTenantContext(ds, tenant.id, (em) => listarSistemasAlvo(em));
  const opcoes = sistemas.map((s) => ({ id: s.id, nome: s.nome }));

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/portal"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Voltar
      </Link>

      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Abrir chamado</h1>
        <p className="text-sm text-muted-foreground">
          Conte o que está acontecendo. Nossa equipe cuida do resto.
        </p>
      </div>

      <Card>
        <CardContent>
          <ChamadoNovoForm sistemas={opcoes} />
        </CardContent>
      </Card>
    </div>
  );
}
