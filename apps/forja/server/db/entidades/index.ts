import { AprovacaoSchema } from './aprovacao';
import { ArtefatoSchema } from './artefato';
import { ChamadoCacheSchema } from './chamado-cache';
import { ComentarioSchema } from './comentario';
import { ConexaoChamadosSchema } from './conexao-chamados';
import { EtapaSchema } from './etapa';
import { EventoSchema } from './evento';
import { ExecucaoSchema } from './execucao';
import { ItemFilaMergeSchema } from './item-fila-merge';
import { LoteSchema } from './lote';
import { MapeamentoSistemaSchema } from './mapeamento-sistema';
import { OutboxChamadoSchema } from './outbox-chamado';
import { ProjetoSchema } from './projeto';
import { SessaoTerminalSchema } from './sessao-terminal';
import { UsoAssinaturaSchema } from './uso-assinatura';

/** Todas as entidades de specs/forja/02 §4, na ordem do documento. */
export const ENTIDADES = [
  ConexaoChamadosSchema,
  ProjetoSchema,
  MapeamentoSistemaSchema,
  ChamadoCacheSchema,
  LoteSchema,
  ExecucaoSchema,
  EtapaSchema,
  EventoSchema,
  ArtefatoSchema,
  ComentarioSchema,
  AprovacaoSchema,
  ItemFilaMergeSchema,
  OutboxChamadoSchema,
  UsoAssinaturaSchema,
  SessaoTerminalSchema,
];

export * from './aprovacao';
export * from './artefato';
export * from './chamado-cache';
export * from './comentario';
export * from './conexao-chamados';
export * from './etapa';
export * from './evento';
export * from './execucao';
export * from './item-fila-merge';
export * from './lote';
export * from './mapeamento-sistema';
export * from './outbox-chamado';
export * from './projeto';
export * from './sessao-terminal';
export * from './uso-assinatura';
