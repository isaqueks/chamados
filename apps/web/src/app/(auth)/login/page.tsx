import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Papel } from '@chamados/shared';
import { caminhoSeguro } from '@/lib/caminho';
import { obterContexto } from '@/lib/sessao';
import { CabecalhoTenant } from '@/components/cabecalho-tenant';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { tenant, usuario } = await obterContexto();
  // Destino preservado do deep link (`?next=`, validado — só caminho interno).
  const next = caminhoSeguro((await searchParams).next);
  if (usuario) {
    // Já logado: honra o destino (os layouts corrigem a área se for a errada);
    // sem destino, raiz da área do papel (antes: /app fixo — cliente quicava).
    redirect(next ?? (usuario.papel === Papel.cliente ? '/portal' : '/app'));
  }

  return (
    <>
      <CabecalhoTenant />
      <Card>
        <CardHeader>
          <CardTitle>Entrar</CardTitle>
          <CardDescription>
            {tenant ? `Acesse o suporte de ${tenant.nome_exibicao}.` : 'Helpdesk multi-tenant.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tenant ? (
            <LoginForm next={next} />
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                Endereço de tenant desconhecido. Em desenvolvimento, acesse por um subdomínio (ex.:{' '}
                <code>acme.localhost:3000</code>) ou use <code>?tenant=acme</code>.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {tenant && (
        <p className="text-center text-sm text-muted-foreground">
          <Link
            href="/esqueci-senha"
            className="underline-offset-4 hover:text-foreground hover:underline"
          >
            Esqueci minha senha
          </Link>
        </p>
      )}
    </>
  );
}
