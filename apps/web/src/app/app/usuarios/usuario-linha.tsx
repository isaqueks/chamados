'use client';

import { useActionState, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Papel, type StatusUsuario } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ROTULO_PAPEL, ROTULO_STATUS_USUARIO } from '@/lib/rotulos';
import { acaoEditarUsuario, type EstadoUsuario } from './actions';

const INICIAL: EstadoUsuario = {};

export interface UsuarioView {
  id: string;
  nome: string;
  email: string;
  papel: Papel;
  status: StatusUsuario;
}

/**
 * Linha da tabela de usuários com edição inline de nome/e-mail (specs/03 §5.1).
 *
 * Não são editáveis: a **própria conta** do admin (perfil próprio é outro fluxo) e
 * o **`agente_ia`** (conta de serviço). A UI apenas ESCONDE o botão nesses casos —
 * a fronteira real é o service, que recusa os dois independentemente da tela.
 */
export function UsuarioLinha({ usuario, ehVoce }: { usuario: UsuarioView; ehVoce: boolean }) {
  const [editando, setEditando] = useState(false);
  const [estado, acao, pendente] = useActionState(acaoEditarUsuario, INICIAL);

  const servico = usuario.papel === Papel.agente_ia;
  const editavel = !servico && !ehVoce;
  // O estado da action é por COMPONENTE, mas a mesma action serve todas as linhas:
  // só exibimos o retorno se ele for desta conta.
  const retorno = estado.usuarioId === usuario.id ? estado : null;

  if (editando) {
    return (
      <tr className="border-b last:border-0">
        <td colSpan={5} className="py-3">
          <form action={acao} className="flex flex-col gap-3">
            <input type="hidden" name="usuarioId" value={usuario.id} />
            {retorno?.erro && (
              <Alert variant="destructive">
                <AlertDescription>{retorno.erro}</AlertDescription>
              </Alert>
            )}
            {retorno?.sucesso && (
              <Alert>
                <AlertDescription>{retorno.sucesso}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor={`nome-${usuario.id}`}>Nome</Label>
                <Input
                  id={`nome-${usuario.id}`}
                  name="nome"
                  defaultValue={usuario.nome}
                  required
                  minLength={2}
                  maxLength={120}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor={`email-${usuario.id}`}>E-mail</Label>
                <Input
                  id={`email-${usuario.id}`}
                  name="email"
                  type="email"
                  defaultValue={usuario.email}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={pendente}>
                  {pendente ? 'Salvando…' : 'Salvar'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditando(false)}
                  disabled={pendente}
                >
                  {retorno?.sucesso ? 'Fechar' : 'Cancelar'}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Trocar o e-mail encerra as sessões desta pessoa — ela entra de novo com o endereço
              novo e a mesma senha.
            </p>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b last:border-0">
      <td className="py-2.5 font-medium">
        {usuario.nome}
        {ehVoce && <span className="ml-2 text-xs font-normal text-muted-foreground">(você)</span>}
      </td>
      <td className="py-2.5 text-muted-foreground">
        {servico ? <span className="italic">service account</span> : usuario.email}
      </td>
      <td className="py-2.5">
        <Badge variant="secondary">{ROTULO_PAPEL[usuario.papel]}</Badge>
      </td>
      <td className="py-2.5">
        <Badge variant="muted">{ROTULO_STATUS_USUARIO[usuario.status]}</Badge>
      </td>
      <td className="py-2.5 text-right">
        {editavel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditando(true)}
            aria-label={`Editar ${usuario.nome}`}
          >
            <Pencil className="size-3.5" />
            <span className="hidden sm:inline">Editar</span>
          </Button>
        )}
      </td>
    </tr>
  );
}
