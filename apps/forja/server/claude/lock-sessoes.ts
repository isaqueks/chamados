/**
 * Lock por `session_id` (specs/forja/01 §6.8; 03 §10): nunca rodam dois
 * processos — turno do pipeline, mensagem de conversa ou PTY assumido — na
 * mesma sessão do Claude. A escrita concorrente num transcript é comportamento
 * não verificado da CLI e é tratada como proibida.
 *
 * O lock vive em memória (uma instância por processo Node, compartilhada pelo
 * runner e pelo gerente de PTY) e é espelhado no SQLite pela interface
 * `EspelhoLock`, para a reconciliação do boot saber quem segurava o quê. A
 * ligação do espelho com a tabela `etapa`/`sessao_terminal` é da integração.
 */

export interface EspelhoLock {
  gravar(sessionId: string, dono: string): void;
  remover(sessionId: string, dono: string): void;
}

export class ErroSessaoOcupada extends Error {
  constructor(
    readonly sessionId: string,
    readonly donoAtual: string,
  ) {
    super(`a sessão ${sessionId} já está em uso por ${donoAtual}`);
  }
}

export class LockSessoes {
  private readonly donos = new Map<string, string>();

  constructor(private readonly espelho: EspelhoLock | null = null) {}

  /** Lança `ErroSessaoOcupada` se outro dono segura a sessão. Reentrante para o mesmo dono. */
  adquirir(sessionId: string, dono: string): void {
    const atual = this.donos.get(sessionId);
    if (atual !== undefined && atual !== dono) throw new ErroSessaoOcupada(sessionId, atual);
    if (atual === dono) return;
    this.donos.set(sessionId, dono);
    this.espelho?.gravar(sessionId, dono);
  }

  /** Só o dono libera; liberar o que não é seu não faz nada. */
  liberar(sessionId: string, dono: string): void {
    if (this.donos.get(sessionId) !== dono) return;
    this.donos.delete(sessionId);
    this.espelho?.remover(sessionId, dono);
  }

  dono(sessionId: string): string | null {
    return this.donos.get(sessionId) ?? null;
  }
}
