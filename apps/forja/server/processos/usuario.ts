/**
 * A Forja nunca roda como root (specs/forja/05 §5.3, teste objetivo do M0 em
 * §12, checklist §13). POR QUE recusar já no boot: como root o Terminal no
 * navegador seria um shell root e a verificação rodaria scripts do projeto
 * como root; o `claude -p --dangerously-skip-permissions` só falharia mais
 * tarde, na CLI, deixando o resto do app de pé.
 */
export const MENSAGEM_ROOT =
  'a Forja não roda como root (05 §5.3): inicie-a com o seu usuário normal, sem sudo';

/** `null` = pode iniciar; senão a mensagem da recusa. `uid` ausente (não-POSIX) não recusa. */
export function recusaPorRoot(uid: number | undefined): string | null {
  return uid === 0 ? MENSAGEM_ROOT : null;
}
