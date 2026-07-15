import Link from "next/link"
import { Plus, KeyRound } from "lucide-react"
import { obterAppDataSource, runInTenantContext, listarSistemasAlvo } from "@chamados/db"
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
import { Button, buttonVariants } from "@/components/ui/button"
import { acaoDefinirAtivoSistema } from "./actions"

export default async function SistemasPage() {
  const { tenant } = await exigirPapel(Papel.admin)
  const ds = await obterAppDataSource()
  const sistemas = await runInTenantContext(ds, tenant.id, (em) =>
    listarSistemasAlvo(em, { incluirInativos: true }),
  )

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Sistemas-alvo
          </h1>
          <p className="text-sm text-muted-foreground">
            Repositórios, logs e conexões de BD que a IA usa na triagem.
          </p>
        </div>
        <Link href="/app/sistemas/novo" className={buttonVariants({})}>
          <Plus className="size-4" />
          Novo
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cadastrados ({sistemas.length})</CardTitle>
          <CardDescription>Credenciais ficam cifradas no cofre.</CardDescription>
        </CardHeader>
        <CardContent>
          {sistemas.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-4">
              <p className="text-sm text-muted-foreground">
                Nenhum sistema-alvo cadastrado ainda.
              </p>
              <Link
                href="/app/sistemas/novo"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <Plus className="size-4" />
                Cadastrar o primeiro
              </Link>
            </div>
          ) : (
            <div className="flex flex-col divide-y">
              {sistemas.map((s) => (
                <div key={s.id} className="flex items-center gap-3 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/app/sistemas/${s.id}`}
                        className="font-medium hover:underline"
                      >
                        {s.nome}
                      </Link>
                      {!s.ativo && <Badge variant="muted">Inativo</Badge>}
                      {(s.tem_git_credencial ||
                        s.tem_logs_credencial ||
                        s.tem_bd_credencial) && (
                        <Badge variant="secondary" aria-label="Possui credenciais">
                          <KeyRound className="size-3" />
                          Cofre
                        </Badge>
                      )}
                    </div>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {s.git_repo_url}
                    </span>
                  </div>
                  <form action={acaoDefinirAtivoSistema}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="ativo" value={s.ativo ? "false" : "true"} />
                    <Button type="submit" variant="ghost" size="sm">
                      {s.ativo ? "Desativar" : "Ativar"}
                    </Button>
                  </form>
                  <Link
                    href={`/app/sistemas/${s.id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Editar
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
