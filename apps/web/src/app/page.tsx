import { redirect } from 'next/navigation';
import { Papel } from '@chamados/shared';
import { obterUsuarioAtual } from '@/lib/sessao';

/**
 * Raiz: encaminha por papel/sessão (specs/03 §4.1, specs/08 §1). Sem sessão →
 * login; cliente → portal; operador/admin → painel.
 */
export default async function Home() {
  const usuario = await obterUsuarioAtual();
  if (!usuario) redirect('/login');
  redirect(usuario.papel === Papel.cliente ? '/portal' : '/app');
}
