import { ErroSessaoOcupada as ErroSessaoOcupadaRunner, LockSessoes } from '../claude/lock-sessoes';
import { ErroSessaoOcupada, type LocksSessao } from '../processos/lock-sessao';

/**
 * Um lock só por `session_id` para o runner da CLI E o gerente de PTY
 * (specs/forja/01 §6.8; 03 §10: nunca dois processos na mesma sessão).
 *
 * POR QUE um adaptador: a R2 entregou duas classes — `LockSessoes` (runner,
 * dono = string `runner:<etapa>:<n>`) e `LocksSessao` (terminal, dono tipado
 * `etapa | terminal`). Duas instâncias separadas deixariam o "Assumir" abrir o
 * `claude --resume` com um turno `-p` ainda vivo na mesma sessão. Aqui o runner
 * passa a gravar no MESMO mapa do terminal: o dono do runner vira
 * `{tipo:'etapa', etapa_id: <dono do runner>}` (a string inteira, para que dois
 * processos do runner continuem sendo donos diferentes, como na classe original).
 * A API pública das duas classes fica intocada.
 */
export class LockSessoesCompartilhado extends LockSessoes {
  constructor(private readonly locks: LocksSessao) {
    super(null);
  }

  override adquirir(sessionId: string, dono: string): void {
    try {
      this.locks.adquirir(sessionId, { tipo: 'etapa', etapa_id: dono });
    } catch (e) {
      // O runner documenta `ErroSessaoOcupada` dele; quem segura vira texto legível.
      if (e instanceof ErroSessaoOcupada) {
        const atual =
          e.dono.tipo === 'terminal' ? `terminal:${e.dono.sessao_terminal_id}` : e.dono.etapa_id;
        throw new ErroSessaoOcupadaRunner(sessionId, atual);
      }
      throw e;
    }
  }

  override liberar(sessionId: string, dono: string): void {
    this.locks.liberar(sessionId, { tipo: 'etapa', etapa_id: dono });
  }

  override dono(sessionId: string): string | null {
    const d = this.locks.dono(sessionId);
    if (!d) return null;
    return d.tipo === 'terminal' ? `terminal:${d.sessao_terminal_id}` : d.etapa_id;
  }
}
