import Link from "next/link"
import { obterAppDataSource, runInTenantContext, listarChamados } from "@chamados/db"
import { Papel, StatusChamado, transicoesDoPapel } from "@chamados/shared"
import { exigirUsuario } from "@/lib/sessao"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  VARIANTE_STATUS,
} from "@/lib/rotulos"
import { ChamadoForm } from "./chamado-form"
import { acaoTransicionar } from "./actions"

/** Verbo de ação por status-alvo (rótulo dos botões de transição). */
const ACAO_STATUS: Record<StatusChamado, string> = {
  [StatusChamado.novo]: "Reabrir triagem",
  [StatusChamado.em_triagem]: "Enviar à triagem",
  [StatusChamado.aguardando_cliente]: "Pedir informações",
  [StatusChamado.em_atendimento]: "Atender",
  [StatusChamado.resolvido]: "Resolver",
  [StatusChamado.fechado]: "Fechar",
  [StatusChamado.cancelado]: "Cancelar",
}

function acaoRotulo(de: StatusChamado, para: StatusChamado): string {
  if (para === StatusChamado.em_atendimento && de === StatusChamado.resolvido) return "Reabrir"
  return ACAO_STATUS[para]
}

export default async function ChamadosPage() {
  const { usuario, tenant } = await exigirUsuario()
  const ds = await obterAppDataSource()
  const pagina = await runInTenantContext(ds, tenant.id, (em) =>
    listarChamados(em, usuario, { limite: 50 }),
  )

  const ehCliente = usuario.papel === Papel.cliente

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Chamados</h1>
        <p className="text-sm text-muted-foreground">
          {ehCliente
            ? "Abra e acompanhe os seus chamados em " + tenant.nome_exibicao + "."
            : "Fila de chamados de " + tenant.nome_exibicao + "."}
        </p>
      </div>

      {ehCliente && (
        <Card>
          <CardHeader>
            <CardTitle>Novo chamado</CardTitle>
            <CardDescription>Formulário mínimo (specs/04 §2).</CardDescription>
          </CardHeader>
          <CardContent>
            <ChamadoForm />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {ehCliente ? "Seus chamados" : "Todos os chamados"} ({pagina.itens.length})
          </CardTitle>
          {!ehCliente && (
            <CardDescription>
              Abertura em nome de um cliente e as ações completas chegam no M5.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {pagina.itens.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum chamado ainda.</p>
          ) : (
            <div className="flex flex-col divide-y">
              {pagina.itens.map((c) => {
                const alvos = transicoesDoPapel(usuario.papel, c.status)
                const temComplexidade = "complexidade" in c && c.complexidade
                return (
                  <div key={c.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-muted-foreground">
                        #{String(c.numero)}
                      </span>
                      <Link href={`/app/chamados/${c.id}`} className="font-medium hover:underline">
                        {c.titulo}
                      </Link>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={VARIANTE_STATUS[c.status]}>
                        {ROTULO_STATUS_CHAMADO[c.status]}
                      </Badge>
                      <Badge variant="outline">{ROTULO_NATUREZA[c.natureza]}</Badge>
                      <Badge variant="muted">{ROTULO_PRIORIDADE[c.prioridade]}</Badge>
                      {temComplexidade && (
                        <Badge variant="secondary">complexidade: {c.complexidade}</Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        atualizado {new Date(c.updated_at).toLocaleString("pt-BR")}
                      </span>
                    </div>
                    {alvos.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {alvos.map((para) => (
                          <form key={para} action={acaoTransicionar}>
                            <input type="hidden" name="id" value={c.id} />
                            <input type="hidden" name="novo_status" value={para} />
                            <Button type="submit" variant="outline" size="sm">
                              {acaoRotulo(c.status, para)}
                            </Button>
                          </form>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
