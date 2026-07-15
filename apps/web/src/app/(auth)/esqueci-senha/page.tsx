import Link from 'next/link';
import { CabecalhoTenant } from '@/components/cabecalho-tenant';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EsqueciForm } from './esqueci-form';

export default function EsqueciSenhaPage() {
  return (
    <>
      <CabecalhoTenant />
      <Card>
        <CardHeader>
          <CardTitle>Redefinir senha</CardTitle>
          <CardDescription>
            Informe seu e-mail e enviaremos um link para criar uma nova senha.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EsqueciForm />
        </CardContent>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="underline-offset-4 hover:text-foreground hover:underline">
          Voltar para o login
        </Link>
      </p>
    </>
  );
}
