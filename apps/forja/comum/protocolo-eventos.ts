import type {
  ClassificacaoProcesso,
  EstadoExecucao,
  EstadoItemFilaMerge,
  MotivoEstado,
  MotivoFimEtapa,
  NivelVerificacao,
  PapelAgente,
  StatusCota,
  TipoEtapa,
} from './estados';

/**
 * Protocolo de eventos servidor → UI (specs/forja/01 §8). POR QUE um envelope
 * único: tudo o que acontece (estado, spawn, ferramenta, subagente, comando,
 * commit, chamada à API) vira um evento persistido com `seq` monotônico e pode
 * ser reproduzido na UI depois de um reload (princípio 7 de 01 §1). O `seq` é o
 * `id:` do SSE e o `Last-Event-ID` da reconexão; o SQLite (`evento`, append-only)
 * guarda o envelope com payload ENXUTO (texto truncado, entradas resumidas) — o
 * bruto fica só em `eventos.jsonl` da etapa (02 §4.8).
 *
 * A união abaixo é discriminada por `tipo`: o servidor só consegue publicar um
 * `dados` coerente com o tipo, e a UI faz `switch (evento.tipo)` com narrowing.
 */

export const NivelEvento = { info: 'info', aviso: 'aviso', erro: 'erro' } as const;
export type NivelEvento = (typeof NivelEvento)[keyof typeof NivelEvento];

/** Catálogo do MVP (01 §8.2). Tipo novo = mudança desta spec + CHANGELOG. */
export const TipoEventoForja = {
  execucao_estado: 'execucao.estado',
  etapa_iniciada: 'etapa.iniciada',
  etapa_finalizada: 'etapa.finalizada',
  agente_texto: 'agente.texto',
  agente_ferramenta: 'agente.ferramenta',
  agente_resultado_ferramenta: 'agente.resultado_ferramenta',
  agente_fora_do_papel: 'agente.fora_do_papel',
  subagente_iniciado: 'subagente.iniciado',
  subagente_concluido: 'subagente.concluido',
  permissao_negada: 'permissao.negada',
  telemetria_turno: 'telemetria.turno',
  uso_atualizado: 'uso.atualizado',
  verificacao_comando: 'verificacao.comando',
  git_checkpoint: 'git.checkpoint',
  chamado_sinal: 'chamado.sinal',
  cli_alerta: 'cli.alerta',
  fila_merge_item: 'fila_merge.item',
  sistema_recarregar: 'sistema.recarregar',
} as const;
export type TipoEventoForja = (typeof TipoEventoForja)[keyof typeof TipoEventoForja];

/** Autoria de uma linha do feed (árvore Fable → Opus pelo `parent_tool_use_id`, 06 §4.2). */
export interface AutoriaAgente {
  papel_agente: PapelAgente | null;
  /** `tool_use_id` da chamada `Agent` que originou a fala (null = thread principal). */
  parent_tool_use_id: string | null;
}

/** Formato de `dados` por tipo de evento. Sempre enxuto: nada de payload bruto. */
export interface DadosEventoForja {
  'execucao.estado': {
    estado: EstadoExecucao;
    estado_anterior: EstadoExecucao | null;
    motivo_estado: MotivoEstado | null;
    numero: number;
    projeto_id: string;
  };
  'etapa.iniciada': {
    tipo_etapa: TipoEtapa;
    n: number;
    ciclo: number;
    papel: PapelAgente | null;
    session_id: string | null;
    retomada: boolean;
    modelo: string | null;
  };
  'etapa.finalizada': {
    tipo_etapa: TipoEtapa;
    n: number;
    motivo_fim: MotivoFimEtapa;
    custo_micro_usd: number | null;
    duracao_ms: number;
  };
  'agente.texto': AutoriaAgente & { texto: string; truncado: boolean; pensamento: boolean };
  'agente.ferramenta': AutoriaAgente & {
    tool_use_id: string;
    ferramenta: string;
    /** Entrada resumida em uma linha (ex.: caminho editado, comando). */
    resumo_entrada: string;
    /** Preenchido quando `ferramenta = Agent`. */
    subagente: string | null;
  };
  'agente.resultado_ferramenta': AutoriaAgente & {
    tool_use_id: string;
    erro: boolean;
    resumo: string;
  };
  'agente.fora_do_papel': AutoriaAgente & { ferramenta: 'Edit' | 'Write' | 'Bash'; alvo: string };
  'subagente.iniciado': { tool_use_id: string; subagente: string; descricao: string };
  'subagente.concluido': {
    tool_use_id: string;
    subagente: string;
    status: string;
    resumo: string;
    modelo: string | null;
  };
  'permissao.negada': AutoriaAgente & { ferramenta: string; resumo_entrada: string };
  'telemetria.turno': {
    custo_micro_usd: number;
    custo_delta_micro_usd: number;
    num_turns: number;
    duracao_ms: number;
    modelos: string[];
    classificacao: ClassificacaoProcesso;
  };
  'uso.atualizado': {
    utilizacao_5h: number | null;
    utilizacao_7d: number | null;
    reinicia_5h_em: string | null;
    reinicia_7d_em: string | null;
    status: StatusCota | null;
    usando_creditos_extras: boolean;
    freio_ativo: boolean;
  };
  /** Não é mais emitido desde FJ-032 (a Forja não executa comandos); fica para o histórico. */
  'verificacao.comando': {
    nome: string;
    exit_code: number | null;
    duracao_ms: number;
    log_ref: string;
    sha: string;
    nivel_parcial: NivelVerificacao | null;
  };
  'git.checkpoint': { sha: string; passo: string | null; mensagem: string; arquivos: number };
  'chamado.sinal': {
    numero: number;
    sinal:
      | 'cliente_respondeu'
      | 'mensagem_nova'
      | 'ia_reativada'
      | 'pr_ia_detectado'
      | 'status_mudou'
      | 'sincronizado';
    detalhe: string;
  };
  'cli.alerta': {
    codigo: string;
    /** Bloqueia o pipeline até ação humana (Diagnóstico)? */
    bloqueante: boolean;
  };
  'fila_merge.item': {
    item_id: string;
    estado: EstadoItemFilaMerge;
    ordem: number;
    motivo: string | null;
  };
  'sistema.recarregar': { motivo: 'cliente_lento' | 'lacuna_no_historico' | 'reinicio' };
}

interface EnvelopeEvento<T extends TipoEventoForja> {
  /** Monotônico, nunca reutilizado (`evento.seq`, `id:` do SSE). */
  seq: number;
  /** ISO-8601 UTC com ms. */
  em: string;
  execucao_id: string | null;
  etapa_id: string | null;
  tipo: T;
  nivel: NivelEvento;
  /** Uma linha pt-BR para o feed. */
  resumo: string;
  dados: DadosEventoForja[T];
}

/** `EventoForja { seq, em, execucao_id | null, etapa_id | null, tipo, nivel, resumo, dados }` (01 §8.2). */
export type EventoForja = { [T in TipoEventoForja]: EnvelopeEvento<T> }[TipoEventoForja];

/** Evento ainda sem `seq`/`em` (quem atribui é o barramento/persistência). Preserva a união. */
export type NovoEventoForja = EventoForja extends infer E
  ? E extends EventoForja
    ? Omit<E, 'seq' | 'em'>
    : never
  : never;

/**
 * Tipos que descem no canal global `GET /api/eventos` (01 §8.1): estados de
 * todas as execuções, fila, cota, sinais do Chamados, alertas da CLI, fila de
 * merge. O feed completo de uma execução vai só no canal da execução.
 */
const TIPOS_CANAL_GLOBAL: ReadonlySet<TipoEventoForja> = new Set<TipoEventoForja>([
  'execucao.estado',
  'uso.atualizado',
  'chamado.sinal',
  'cli.alerta',
  'fila_merge.item',
  'sistema.recarregar',
]);

export function pertenceAoCanalGlobal(evento: Pick<EventoForja, 'tipo'>): boolean {
  return TIPOS_CANAL_GLOBAL.has(evento.tipo);
}

/** O evento interessa ao canal `GET /api/execucoes/:id/eventos`? */
export function pertenceAoCanalDaExecucao(
  evento: Pick<EventoForja, 'tipo' | 'execucao_id'>,
  execucaoId: string,
): boolean {
  return evento.execucao_id === execucaoId || evento.tipo === 'sistema.recarregar';
}

/** Marcos do feed (06 §4.2 "Marcos"; 06 §9: `aria-live` só para marcos). */
const TIPOS_MARCO: ReadonlySet<TipoEventoForja> = new Set<TipoEventoForja>([
  'execucao.estado',
  'etapa.iniciada',
  'etapa.finalizada',
  'agente.ferramenta',
  'agente.fora_do_papel',
  'subagente.iniciado',
  'subagente.concluido',
  'permissao.negada',
  'verificacao.comando',
  'git.checkpoint',
  'cli.alerta',
]);

/** Ferramentas de leitura: aparecem só no modo "Tudo" do feed. */
const FERRAMENTAS_LEITURA: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob']);

export function ehMarco(evento: EventoForja): boolean {
  if (evento.nivel === 'erro') return true;
  if (evento.tipo === 'agente.ferramenta') return !FERRAMENTAS_LEITURA.has(evento.dados.ferramenta);
  return TIPOS_MARCO.has(evento.tipo);
}
