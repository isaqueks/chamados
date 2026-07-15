import { EntitySchema } from 'typeorm';
import { StatusExecucaoIA, valoresEnum } from '@chamados/shared';

/**
 * ExecucaoIA (specs/02, specs/05): registro APPEND-ONLY de cada execução do
 * pipeline do `agente_ia`. Guarda o gatilho, o provider/modelo usado, o snapshot
 * do input (`entrada`), a trilha de ações (`acoes`), o resultado bruto do
 * provider (`resultado` = `AIProviderResult`) e a telemetria de custo/duração/
 * tokens. NÃO sofre soft delete (trilha de auditoria — specs/02 "Soft delete").
 *
 * Os `*_json` opacos (`entrada`/`acoes`/`resultado`) são tipados como `unknown`
 * para não colidir com a recursão de `QueryDeepPartialEntity` do TypeORM em
 * inserts/updates de jsonb — mesmo padrão de `EventoChamado.dados`.
 */
export interface ExecucaoIA {
  id: string;
  tenant_id: string;
  chamado_id: string;
  status: StatusExecucaoIA;
  /** Abstração de provider (ex.: 'claude-agent-sdk', 'fake'). */
  provider: string;
  /** Modelo concreto (ex.: 'claude-opus-4-8'). */
  modelo: string;
  /** Gatilho (specs/05 §2): 'chamado_criado' | 'resposta_cliente' | 'reprocessamento_manual'. */
  gatilho: string;
  /** Snapshot sanitizado do input (inclui `ultima_mensagem_id`). */
  entrada: unknown;
  /** Trilha de ações (chamadas de ferramenta, etc.). */
  acoes: unknown;
  /** Resultado BRUTO do provider (`AIProviderResult`); null enquanto não conclui. */
  resultado: unknown;
  custo_usd: string | null; // numeric(12,6) → string no driver pg
  tokens_entrada: number | null;
  tokens_saida: number | null;
  duracao_ms: number | null;
  /** Motivo detalhado quando `falhou` (ex.: 'timeout', 'budget_excedido'). */
  erro: string | null;
  iniciado_em: Date | null;
  finalizado_em: Date | null;
  created_at: Date;
}

export const ExecucaoIASchema = new EntitySchema<ExecucaoIA>({
  name: 'ExecucaoIA',
  tableName: 'execucao_ia',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    chamado_id: { type: 'uuid' },
    status: {
      type: 'enum',
      enum: valoresEnum(StatusExecucaoIA),
      enumName: 'status_execucao_ia',
      default: StatusExecucaoIA.na_fila,
    },
    provider: { type: 'text' },
    modelo: { type: 'text' },
    gatilho: { type: 'text' },
    entrada: { type: 'jsonb', default: () => "'{}'::jsonb" },
    acoes: { type: 'jsonb', default: () => "'[]'::jsonb" },
    resultado: { type: 'jsonb', nullable: true },
    custo_usd: { type: 'numeric', precision: 12, scale: 6, nullable: true },
    tokens_entrada: { type: 'int', nullable: true },
    tokens_saida: { type: 'int', nullable: true },
    duracao_ms: { type: 'int', nullable: true },
    erro: { type: 'text', nullable: true },
    iniciado_em: { type: 'timestamptz', nullable: true },
    finalizado_em: { type: 'timestamptz', nullable: true },
    created_at: { type: 'timestamptz', createDate: true },
  },
  indices: [
    {
      name: 'ix_execucao_ia_tenant_chamado_created',
      columns: ['tenant_id', 'chamado_id', 'created_at'],
    },
  ],
});
