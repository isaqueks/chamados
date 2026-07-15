import { EntitySchema } from 'typeorm';
import { TipoEvento, valoresEnum } from '@chamados/shared';

/**
 * EventoChamado (specs/02, specs/04 §9): trilha de auditoria/histórico IMUTÁVEL e
 * APPEND-ONLY. Todo fato relevante gera uma linha. Sem `updated_at`/`deleted_at`:
 * não sofre soft delete; expurgo só por política de retenção. O `dados` carrega o
 * payload (ex.: `{ de, para }`, `{ mensagem_id }`, `{ operador_anterior,
 * operador_novo }`). `ator_id NULL` = ação do `sistema` (jobs automáticos).
 */
export interface EventoChamado {
  id: string;
  tenant_id: string;
  chamado_id: string;
  tipo: TipoEvento;
  ator_id: string | null;
  execucao_ia_id: string | null;
  /** Payload jsonb OPACO (tipado `unknown` para não colidir com o
   * `QueryDeepPartialEntity` recursivo do TypeORM); consumidores fazem cast. */
  dados: unknown;
  created_at: Date;
}

export const EventoChamadoSchema = new EntitySchema<EventoChamado>({
  name: 'EventoChamado',
  tableName: 'evento_chamado',
  columns: {
    id: { type: 'uuid', primary: true, default: () => 'gen_random_uuid()' },
    tenant_id: { type: 'uuid' },
    chamado_id: { type: 'uuid' },
    tipo: {
      type: 'enum',
      enum: valoresEnum(TipoEvento),
      enumName: 'tipo_evento',
    },
    ator_id: { type: 'uuid', nullable: true },
    execucao_ia_id: { type: 'uuid', nullable: true },
    dados: { type: 'jsonb', default: () => "'{}'::jsonb" },
    created_at: { type: 'timestamptz', createDate: true },
  },
  indices: [
    {
      name: 'ix_evento_tenant_chamado_created',
      columns: ['tenant_id', 'chamado_id', 'created_at'],
    },
  ],
});
