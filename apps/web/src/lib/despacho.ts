import 'server-only';
import type { DataSource, EntityManager } from 'typeorm';
import {
  runInTenantContext,
  DespachanteFila,
  DespachanteNotificacoes,
  type Despachante,
  type EventoDominio,
  type HooksChamado,
} from '@chamados/db';

/**
 * Helper ÚNICO de despacho pós-mutação do web (M7 + M9). Injeta um despachante
 * COMPOSTO nos hooks da mutação e, APÓS o commit, faz `flush()` best-effort para
 * enfileirar os efeitos assíncronos. Substitui o antigo `comNotificacoes`: agora a
 * MESMA mutação alimenta a triagem de IA E as notificações, sem a UI escolher qual.
 */

function logWeb(msg: string, extra?: Record<string, unknown>): void {
  console.info(JSON.stringify({ evt: 'despacho', msg, ...extra, ts: new Date().toISOString() }));
}

/**
 * Despachante COMPOSTO: na MESMA transação da mutação, captura tanto os eventos de
 * TRIAGEM (→ fila `triagem-ia`, com dedupe/debounce) quanto os jobs de NOTIFICAÇÃO
 * traduzidos pelo seam de auditoria (→ fila `notificacoes`, com idempotência).
 * Delega a cada despachante concreto, que filtra o que lhe cabe — a triagem ignora
 * `notificacao`; as notificações ignoram `triagem_solicitada` — então a semântica
 * de cada lado é PRESERVADA. `capturaNotificacoes = true` sinaliza ao auditor para
 * traduzir `EventoChamado` → notificações. O `flush` roda pós-commit (best-effort):
 * uma falha de qualquer fila nunca quebra a mutação já commitada.
 */
class DespachanteComposto implements Despachante {
  readonly capturaNotificacoes = true;
  private readonly fila = new DespachanteFila(logWeb);
  private readonly notificacoes = new DespachanteNotificacoes(logWeb);

  publicar(ev: EventoDominio): void {
    this.fila.publicar(ev);
    this.notificacoes.publicar(ev);
  }

  async flush(): Promise<void> {
    await this.fila.flush();
    await this.notificacoes.flush();
  }
}

/**
 * Executa uma mutação de chamado no contexto do tenant COM o despachante composto
 * (triagem + notificações) injetado. Após o COMMIT, enfileira os efeitos
 * assíncronos (best-effort). Sem despachante concreto nada é enfileirado; aqui há
 * sempre um, então toda mutação de chamado da UI participa dos dois pipelines.
 */
export async function comDespacho<T>(
  ds: DataSource,
  tenantId: string,
  fn: (em: EntityManager, hooks: HooksChamado) => Promise<T>,
): Promise<T> {
  const despachante = new DespachanteComposto();
  const resultado = await runInTenantContext(ds, tenantId, (em) => fn(em, { despachante }));
  await despachante.flush();
  return resultado;
}
