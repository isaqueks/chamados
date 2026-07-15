import Link from "next/link"
import { obterAppDataSource, consultarConvite } from "@chamados/db"
import { obterTenantAtual } from "@/lib/tenant"
import { CabecalhoTenant } from "@/components/cabecalho-tenant"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ROTULO_PAPEL } from "@/lib/rotulos"
import { AceiteForm } from "./aceite-form"

export default async function AceitarConvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const tenant = await obterTenantAtual()

  const info =
    token && tenant
      ? await consultarConvite(await obterAppDataSource(), tenant.id, token)
      : null

  return (
    <>
      <CabecalhoTenant />
      <Card>
        <CardHeader>
          <CardTitle>Aceitar convite</CardTitle>
          <CardDescription>
            {info?.aceitavel
              ? `Você foi convidado como ${ROTULO_PAPEL[info.papel]}. Defina sua senha para entrar.`
              : "Convite de acesso."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!token || !tenant ? (
            <Alert variant="destructive">
              <AlertDescription>Link de convite inválido.</AlertDescription>
            </Alert>
          ) : !info || !info.aceitavel ? (
            <Alert variant="destructive">
              <AlertDescription>
                Este convite é inválido, já foi usado ou expirou. Peça um novo ao
                administrador do tenant.
              </AlertDescription>
            </Alert>
          ) : (
            <AceiteForm token={token} email={info.email} />
          )}
        </CardContent>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        <Link
          href="/login"
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          Já tenho conta
        </Link>
      </p>
    </>
  )
}
