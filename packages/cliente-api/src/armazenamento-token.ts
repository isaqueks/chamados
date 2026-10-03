/**
 * Onde o token de sessão da API vive (specs/forja/01 §5.2; specs/forja/07 §2.2).
 *
 * O cliente não decide persistência: recebe um `ArmazenamentoToken`. O padrão é
 * EM MEMÓRIA — o comportamento histórico do MCP (sessão morre com o processo). A
 * Forja injeta a versão SQLite cifrada (specs/forja/05, 02 §8) porque cada login
 * cria uma `Sessao` nova e consome o rate limit do login (07 §2.2): o token tem de
 * sobreviver a reinícios.
 *
 * O cliente só chama `ler()` uma vez (na primeira requisição), `gravar()` após
 * cada login bem-sucedido e `limpar()` quando o servidor recusa o token (401) ou
 * na desconexão explícita. `expiraEm` é informativo (07 §2.2: quem manda é o 401).
 */
export interface ArmazenamentoToken {
  /** Token persistido, ou `null` se não houver. */
  ler(): Promise<string | null>;
  /** Guarda o token recém-obtido no login (`expiraEm` = ISO 8601 de `expira_em`). */
  gravar(token: string, expiraEm: string): Promise<void>;
  /** Esquece o token (recusado pelo servidor ou sessão encerrada). */
  limpar(): Promise<void>;
}

/** Implementação padrão: só memória do processo (MCP). */
export class ArmazenamentoTokenMemoria implements ArmazenamentoToken {
  private token: string | null = null;
  private expiraEm: string | null = null;

  async ler(): Promise<string | null> {
    return this.token;
  }

  async gravar(token: string, expiraEm: string): Promise<void> {
    this.token = token;
    this.expiraEm = expiraEm;
  }

  async limpar(): Promise<void> {
    this.token = null;
    this.expiraEm = null;
  }

  /** Expiração informada no último login (diagnóstico; `null` sem token). */
  expiracao(): string | null {
    return this.expiraEm;
  }
}
