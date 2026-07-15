import Link from "next/link"
import { exigirUsuario, Papel } from "@/lib/sessao"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { ROTULO_PAPEL } from "@/lib/rotulos"

export default async function PainelPage() {
  const { usuario, tenant } = await exigirUsuario()

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Olá, {usuario.nome.split(" ")[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          Você está no painel de {tenant.nome_exibicao}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Seu acesso</CardTitle>
            <CardDescription>Identidade escopada a este tenant.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Papel</span>
              <Badge variant="secondary">{ROTULO_PAPEL[usuario.papel]}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">E-mail</span>
              <span className="font-medium">{usuario.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Tenant</span>
              <span className="font-medium">{tenant.slug}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Próximos passos</CardTitle>
            <CardDescription>Fundação de autenticação (M1).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
            <p>
              Chamados, sistemas-alvo e o portal do cliente chegam nos próximos
              marcos. Por ora, administradores podem gerenciar o acesso da equipe.
            </p>
            {usuario.papel === Papel.admin && (
              <Link
                href="/app/usuarios"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Gerenciar usuários
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
