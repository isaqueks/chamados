import {
  obterAppDataSource,
  runInTenantContext,
  listarCategorias,
  ehCategoriaGeral,
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
import { CategoriaForm } from "./categoria-form"
import { CategoriaLinha, type CategoriaView } from "./categoria-linha"

export default async function CategoriasPage() {
  const { tenant } = await exigirPapel(Papel.admin)
  const ds = await obterAppDataSource()
  const categorias = await runInTenantContext(ds, tenant.id, (em) =>
    listarCategorias(em, { incluirInativas: true }),
  )

  const views: CategoriaView[] = categorias.map((c) => ({
    id: c.id,
    nome: c.nome,
    descricao: c.descricao,
    ativo: c.ativo,
    geral: ehCategoriaGeral(c),
  }))

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Categorias
        </h1>
        <p className="text-sm text-muted-foreground">
          Classificação de chamados sem um sistema-alvo específico.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nova categoria</CardTitle>
          <CardDescription>
            “Geral” é a categoria padrão do tenant e não pode ser removida.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CategoriaForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Categorias ({views.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col divide-y">
            {views.map((c) => (
              <CategoriaLinha key={c.id} categoria={c} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
