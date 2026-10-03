/**
 * Lock por `session_id` da CLI (specs/forja/01 §6.8, 03 §10, 02 I-2): nunca
 * rodam dois processos na mesma sessão — turno do pipeline (`claude -p`),
 * mensagem de conversa (`-p --resume`) ou PTY assumido (`claude --resume`). A
 * escrita concorrente no transcript é comportamento [NV] e é tratada como
 * proibida.
 *
 * POR QUE em memória + espelho: o lock real precisa ser instantâneo e síncrono
 * (o runner e o terminal perguntam no mesmo tick); o SQLite só ESPELHA (`etapa`
 * executando / `sessao_terminal` assumida aberta) para a reconciliação do boot,
 * que recomeça com a tabela de locks vazia. A mesma instância precisa ser
 * injetada no runner da CLI e no gerente de terminais (ligação da R3).
 */

export type DonoLock =
  { tipo: 'etapa'; etapa_id: string } | { tipo: 'terminal'; sessao_terminal_id: string };

export class ErroSessaoOcupada extends Error {
  constructor(
    readonly session_id: string,
    readonly dono: DonoLock,
  ) {
    super(
      dono.tipo === 'terminal'
        ? `a sessão ${session_id} está assumida no Terminal; devolva para continuar`
        : `a sessão ${session_id} já tem um processo rodando (etapa ${dono.etapa_id})`,
    );
  }
}

/** Espelho opcional no SQLite (R3). Chamado DEPOIS de mudar o estado em memória. */
export interface EspelhoLocks {
  aoAdquirir?(session_id: string, dono: DonoLock): void;
  aoLiberar?(session_id: string, dono: DonoLock): void;
}

export interface LocksSessao {
  /** Adquire ou lança `ErroSessaoOcupada`. Readquirir com o MESMO dono é idempotente. */
  adquirir(session_id: string, dono: DonoLock): void;
  /** Libera só se o dono confere (um dono antigo não solta o lock de outro). */
  liberar(session_id: string, dono: DonoLock): boolean;
  dono(session_id: string): DonoLock | null;
}

function mesmoDono(a: DonoLock, b: DonoLock): boolean {
  if (a.tipo === 'etapa' && b.tipo === 'etapa') return a.etapa_id === b.etapa_id;
  if (a.tipo === 'terminal' && b.tipo === 'terminal') {
    return a.sessao_terminal_id === b.sessao_terminal_id;
  }
  return false;
}

export class LocksSessaoMemoria implements LocksSessao {
  private readonly mapa = new Map<string, DonoLock>();

  constructor(private readonly espelho: EspelhoLocks = {}) {}

  adquirir(session_id: string, dono: DonoLock): void {
    const atual = this.mapa.get(session_id);
    if (atual) {
      if (mesmoDono(atual, dono)) return;
      throw new ErroSessaoOcupada(session_id, atual);
    }
    this.mapa.set(session_id, dono);
    this.espelho.aoAdquirir?.(session_id, dono);
  }

  liberar(session_id: string, dono: DonoLock): boolean {
    const atual = this.mapa.get(session_id);
    if (!atual || !mesmoDono(atual, dono)) return false;
    this.mapa.delete(session_id);
    this.espelho.aoLiberar?.(session_id, dono);
    return true;
  }

  dono(session_id: string): DonoLock | null {
    return this.mapa.get(session_id) ?? null;
  }
}
