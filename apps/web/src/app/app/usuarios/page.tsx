import { X } from "lucide-react"
import {
  obterAppDataSource,
  runInTenantContext,
  listarUsuarios,
  listarConvitesPendentes,
} from "@chamados/db"
import { Papel } from "@chamados/shared"
import { exigirPapel } from "@/lib/sessao"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ROTULO_PAPEL, ROTULO_STATUS_USUARIO } from "@/lib/rotulos"
import { ConviteForm } from "./convite-form"
import { acaoRevogarConvite } from "./actions"

const fmtData = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
})

export default async function UsuariosPage() {
  const { tenant } = await exigirPapel(Papel.admin)
  const ds = await obterAppDataSource()

  const { usuarios, convites } = await runInTenantContext(ds, tenant.id, async (em) => ({
    usuarios: await listarUsuarios(em),
    convites: await listarConvitesPendentes(em),
  }))

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Usuários
        </h1>
        <p className="text-sm text-muted-foreground">
          Convide pessoas e gerencie o acesso da equipe deste tenant.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Convidar pessoa</CardTitle>
          <CardDescription>
            A pessoa recebe um link para definir a senha e ativar a conta.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConviteForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equipe ({usuarios.length})</CardTitle>
          <CardDescription>Contas existentes neste tenant.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Nome</th>
                  <th className="pb-2 font-medium">E-mail</th>
                  <th className="pb-2 font-medium">Papel</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {usuarios.map((u) => (
                  <tr key={u.id} className="border-b last:border-0">
                    <td className="py-2.5 font-medium">{u.nome}</td>
                    <td className="py-2.5 text-muted-foreground">
                      {u.papel === Papel.agente_ia ? (
                        <span className="italic">service account</span>
                      ) : (
                        u.email
                      )}
                    </td>
                    <td className="py-2.5">
                      <Badge variant="secondary">{ROTULO_PAPEL[u.papel]}</Badge>
                    </td>
                    <td className="py-2.5">
                      <Badge variant="muted">
                        {ROTULO_STATUS_USUARIO[u.status]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Convites pendentes ({convites.length})</CardTitle>
          <CardDescription>Aguardando aceite dentro do prazo.</CardDescription>
        </CardHeader>
        <CardContent>
          {convites.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhum convite pendente.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">E-mail</th>
                    <th className="pb-2 font-medium">Papel</th>
                    <th className="pb-2 font-medium">Expira</th>
                    <th className="pb-2 font-medium sr-only">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {convites.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-2.5 font-medium">{c.email}</td>
                      <td className="py-2.5">
                        <Badge variant="secondary">{ROTULO_PAPEL[c.papel]}</Badge>
                      </td>
                      <td className="py-2.5 text-muted-foreground">
                        {fmtData.format(new Date(c.expira_em))}
                      </td>
                      <td className="py-2.5 text-right">
                        <form action={acaoRevogarConvite}>
                          <input type="hidden" name="conviteId" value={c.id} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            aria-label="Revogar convite"
                          >
                            <X className="size-4" />
                            <span className="hidden sm:inline">Revogar</span>
                          </Button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
