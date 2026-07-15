import { redirect } from 'next/navigation';
import {
  obterAppDataSource,
  runInTenantContext,
  idCanalEmail,
  listarPreferenciasUsuario,
  papelDestinatario,
} from '@chamados/db';
import { exigirUsuario } from '@/lib/sessao';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PreferenciasForm } from '@/components/notificacoes/preferencias-form';

export default async function PreferenciasAppPage() {
  const { tenant, usuario } = await exigirUsuario();
  const papel = papelDestinatario(usuario.papel);
  if (!papel) redirect('/app');

  const ds = await obterAppDataSource();
  const itens = await runInTenantContext(ds, tenant.id, async (em) => {
    const canalId = await idCanalEmail(em);
    return canalId ? listarPreferenciasUsuario(em, usuario.id, papel, canalId) : [];
  });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Preferências de notificação
        </h1>
        <p className="text-sm text-muted-foreground">
          Escolha quais eventos de chamado você quer receber por e-mail.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Por e-mail</CardTitle>
          <CardDescription>
            Aplica-se aos chamados que você acompanha em {tenant.nome_exibicao}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PreferenciasForm itens={itens} />
        </CardContent>
      </Card>
    </div>
  );
}
