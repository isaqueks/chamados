import { redirect } from "next/navigation"
import { obterUsuarioAtual } from "@/lib/sessao"

/** Raiz: encaminha para o painel (se autenticado) ou para o login. */
export default async function Home() {
  const usuario = await obterUsuarioAtual()
  redirect(usuario ? "/app" : "/login")
}
