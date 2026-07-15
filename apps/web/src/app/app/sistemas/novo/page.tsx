import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { Papel } from '@chamados/shared';
import { exigirPapel } from '@/lib/sessao';
import { Card, CardContent } from '@/components/ui/card';
import { SistemaForm } from '../sistema-form';

export default async function NovoSistemaPage() {
  await exigirPapel(Papel.admin);

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
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Novo sistema-alvo</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <SistemaForm />
        </CardContent>
      </Card>
    </div>
  );
}
