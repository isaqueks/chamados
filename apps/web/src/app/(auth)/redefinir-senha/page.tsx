import Link from 'next/link';
import { CabecalhoTenant } from '@/components/cabecalho-tenant';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RedefinirForm } from './redefinir-form';

export default async function RedefinirSenhaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <>
      <CabecalhoTenant />
      <Card>
        <CardHeader>
          <CardTitle>Nova senha</CardTitle>
          <CardDescription>Escolha uma nova senha para sua conta.</CardDescription>
        </CardHeader>
        <CardContent>
          {token ? (
            <RedefinirForm token={token} />
          ) : (
            <Alert variant="destructive">
              <AlertDescription>
                Link inválido ou incompleto. Solicite um novo em{' '}
                <Link href="/esqueci-senha" className="underline">
                  Esqueci minha senha
                </Link>
                .
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </>
  );
}
