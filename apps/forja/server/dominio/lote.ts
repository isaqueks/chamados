import type { Complexidade, Prioridade } from '@chamados/shared';
import type { PlanoV1 } from '../../comum/contratos';
import type { ConfigResolvidaDto } from '../../comum/dto';
import type { EstadoExecucao, EstadoLote, TipoEtapa } from '../../comum/estados';
import { ESTADOS_QUE_SOLTAM_SCHEMA, estadoTerminal } from './maquina-execucao';

/**
 * Lote, mesa de planos, semáforos e token `schema` como estruturas PURAS
 * (specs/forja/03 §7.1–§7.5; 06 §4.4/§4.5).
 *
 * POR QUE semáforo puro: a vaga é decidida por regra (quem está mais adiante
 * primeiro, ordem do lote, freio, token de schema) e precisa ser testável sem
 * processo; o orquestrador guarda o `Semaforos` em memória (reconstruído do
 * SQLite no boot pelas etapas `executando`) e só troca de valor pelas funções
 * daqui, que devolvem um novo objeto.
 */

// ---------------------------------------------------------------------------
// Plano limpo e mesa de planos (03 §7.4; 06 §4.4)
// ---------------------------------------------------------------------------

export type MotivoPlanoSujo =
  | 'confianca_nao_alta'
  | 'perguntas_ao_cliente'
  | 'decisoes_do_operador'
  | 'altera_schema'
  | 'alertas_seguranca';

/** Limpo = confiança alta, sem perguntas/decisões, sem schema e sem alertas de segurança. */
export function planoLimpo(plano: PlanoV1): { limpo: boolean; motivos: MotivoPlanoSujo[] } {
  const motivos: MotivoPlanoSujo[] = [];
  if (plano.confianca !== 'alta') motivos.push('confianca_nao_alta');
  if (plano.perguntas_ao_cliente.length > 0) motivos.push('perguntas_ao_cliente');
  if (plano.decisoes_do_operador.length > 0) motivos.push('decisoes_do_operador');
  if (plano.schema_banco.altera) motivos.push('altera_schema');
  if (plano.alertas_seguranca.length > 0) motivos.push('alertas_seguranca');
  return { limpo: motivos.length === 0, motivos };
}

export interface ItemMesa {
  execucao_id: string;
  estado: EstadoExecucao;
  /** Versão oficial do plano (null enquanto planeja). */
  plano: PlanoV1 | null;
}

export interface Mesa {
  /** Em `aguardando_plano` e limpos: os únicos com checkbox de aprovação em bloco. */
  limpos: string[];
  /** Em `aguardando_plano` com risco: aprovação um a um. */
  individuais: string[];
  /** Gdec (perguntas/decisões): por chamado, sem segurar o lote. */
  decisao: string[];
  /** Ainda sem plano (na fila, preparando, planejando, plano_pronto). */
  planejando: string[];
  /** Já passaram da mesa ou terminaram. */
  outros: string[];
}

const ANTES_DO_PLANO: readonly EstadoExecucao[] = [
  'na_fila',
  'preparando',
  'planejando',
  'plano_pronto',
];

export function montarMesa(itens: readonly ItemMesa[]): Mesa {
  const mesa: Mesa = { limpos: [], individuais: [], decisao: [], planejando: [], outros: [] };
  for (const i of itens) {
    if (i.estado === 'aguardando_plano' && i.plano) {
      (planoLimpo(i.plano).limpo ? mesa.limpos : mesa.individuais).push(i.execucao_id);
    } else if (i.estado === 'aguardando_decisao' || i.estado === 'aguardando_cliente_resposta') {
      mesa.decisao.push(i.execucao_id);
    } else if (ANTES_DO_PLANO.includes(i.estado)) {
      mesa.planejando.push(i.execucao_id);
    } else {
      mesa.outros.push(i.execucao_id);
    }
  }
  return mesa;
}

/**
 * "Aprovar limpos (N)…": a confirmação é explícita e só aceita planos limpos
 * em `aguardando_plano` do próprio lote (03 §7.4; 06 §4.4). Qualquer item
 * fora disso recusa o bloco inteiro — nunca "aprovar tudo" às cegas.
 */
export function validarAprovacaoEmBloco(
  selecionados: readonly string[],
  itens: readonly ItemMesa[],
): { ok: boolean; erros: { execucao_id: string; motivo: string }[] } {
  const erros: { execucao_id: string; motivo: string }[] = [];
  if (selecionados.length === 0)
    erros.push({ execucao_id: '', motivo: 'nenhum plano selecionado' });
  const porId = new Map(itens.map((i) => [i.execucao_id, i]));
  const vistos = new Set<string>();
  for (const id of selecionados) {
    if (vistos.has(id)) {
      erros.push({ execucao_id: id, motivo: 'selecionado mais de uma vez' });
      continue;
    }
    vistos.add(id);
    const item = porId.get(id);
    if (!item) erros.push({ execucao_id: id, motivo: 'não pertence a este lote' });
    else if (item.estado !== 'aguardando_plano' || !item.plano) {
      erros.push({ execucao_id: id, motivo: `não está aguardando plano (${item.estado})` });
    } else {
      const { limpo, motivos } = planoLimpo(item.plano);
      if (!limpo) erros.push({ execucao_id: id, motivo: `plano não limpo: ${motivos.join(', ')}` });
    }
  }
  return { ok: erros.length === 0, erros };
}

/** "Arquivos em comum" (interseção de `arquivos_previstos`): só aviso no MVP (06 §4.4). */
export function arquivosEmComum(
  itens: readonly { execucao_id: string; arquivos_previstos: readonly string[] }[],
): { arquivo: string; execucoes: string[] }[] {
  const por = new Map<string, Set<string>>();
  for (const i of itens) {
    for (const a of i.arquivos_previstos) {
      const s = por.get(a) ?? new Set<string>();
      s.add(i.execucao_id);
      por.set(a, s);
    }
  }
  return [...por.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([arquivo, s]) => ({ arquivo, execucoes: [...s] }))
    .sort((a, b) => a.arquivo.localeCompare(b.arquivo));
}

// ---------------------------------------------------------------------------
// Ordem de início (03 §7.2)
// ---------------------------------------------------------------------------

const PESO_PRIORIDADE: Record<Prioridade, number> = { urgente: 0, alta: 1, media: 2, baixa: 3 };
const PESO_COMPLEXIDADE: Record<Complexidade, number> = { facil: 0, medio: 1, dificil: 2 };

export interface ItemOrdem {
  execucao_id: string;
  prioridade: Prioridade;
  complexidade: Complexidade | null;
  /** `criado_em` do chamado (ISO): mais antigo primeiro. */
  chamado_criado_em: string;
}

/**
 * Prioridade (`urgente` → `baixa`), complexidade (`facil` primeiro; sem
 * classificação por último), idade do chamado. Com `ordemManual` (o humano
 * reordenou), ela vale para os ids que cita; os demais seguem a regra, depois.
 */
export function ordenarInicio(
  itens: readonly ItemOrdem[],
  ordemManual: readonly string[] = [],
): string[] {
  const manual = new Map(ordemManual.map((id, i) => [id, i]));
  return [...itens]
    .sort((a, b) => {
      const ma = manual.get(a.execucao_id);
      const mb = manual.get(b.execucao_id);
      if (ma !== undefined || mb !== undefined) {
        if (ma === undefined) return 1;
        if (mb === undefined) return -1;
        return ma - mb;
      }
      return (
        PESO_PRIORIDADE[a.prioridade] - PESO_PRIORIDADE[b.prioridade] ||
        (a.complexidade ? PESO_COMPLEXIDADE[a.complexidade] : 3) -
          (b.complexidade ? PESO_COMPLEXIDADE[b.complexidade] : 3) ||
        Date.parse(a.chamado_criado_em) - Date.parse(b.chamado_criado_em) ||
        a.execucao_id.localeCompare(b.execucao_id)
      );
    })
    .map((i) => i.execucao_id);
}

// ---------------------------------------------------------------------------
// Semáforos (03 §7.2, §7.3)
// ---------------------------------------------------------------------------

/** Sem `verificacoes` desde FJ-032: a Forja não executa comandos do projeto. */
export type RecursoGlobal = 'planejadores' | 'agentes';
/** Recursos por `(projeto, destino)`. */
export type RecursoPorDestino = 'merge' | 'schema';
export type Recurso = RecursoGlobal | RecursoPorDestino;

export interface SemaforoContador {
  limite: number;
  ocupantes: readonly string[];
}

export interface SemaforoPorChave {
  limite: number;
  /** chave `(projeto, destino)` → execuções que seguram a vaga. */
  ocupantes: Readonly<Record<string, readonly string[]>>;
}

export interface Semaforos {
  planejadores: SemaforoContador;
  agentes: SemaforoContador;
  merge: SemaforoPorChave;
  schema: SemaforoPorChave;
}

/** Chave da fila serial e do token de schema: `(projeto_id, branch_destino)`. */
export function chaveDestino(projetoId: string, branchDestino: string): string {
  return `${projetoId}\u0000${branchDestino}`;
}

/** Semáforos vazios a partir de `limites.concorrencia` (defaults 3·2, merge 1, schema 1). */
export function semaforosVazios(
  c: ConfigResolvidaDto['limites']['concorrencia'] = {
    planejadores: 3,
    agentes: 2,
    schema_em_voo: 1,
  },
): Semaforos {
  return {
    planejadores: { limite: c.planejadores, ocupantes: [] },
    agentes: { limite: c.agentes, ocupantes: [] },
    merge: { limite: 1, ocupantes: {} },
    schema: { limite: c.schema_em_voo, ocupantes: {} },
  };
}

export interface PedidoVaga {
  execucao_id: string;
  recurso: Recurso;
  /** Obrigatória para `merge`/`schema` (`chaveDestino`). */
  chave?: string;
}

export type ResultadoVaga =
  { ok: true; ja_ocupa: boolean } | { ok: false; razao: string; ocupantes: string[] };

function porDestino(r: Recurso): r is RecursoPorDestino {
  return r === 'merge' || r === 'schema';
}

function ocupantesDe(
  s: Semaforos,
  p: PedidoVaga,
): { limite: number; ocupantes: readonly string[] } {
  if (porDestino(p.recurso)) {
    if (!p.chave) throw new Error(`semáforo "${p.recurso}" exige chave (projeto, destino)`);
    const sem = s[p.recurso];
    return { limite: sem.limite, ocupantes: sem.ocupantes[p.chave] ?? [] };
  }
  return s[p.recurso];
}

/** Há vaga? Idempotente: quem já ocupa "pode" (não conta duas vezes). */
export function podeIniciar(s: Semaforos, p: PedidoVaga): ResultadoVaga {
  const { limite, ocupantes } = ocupantesDe(s, p);
  if (ocupantes.includes(p.execucao_id)) return { ok: true, ja_ocupa: true };
  if (ocupantes.length < limite) return { ok: true, ja_ocupa: false };
  return {
    ok: false,
    razao: `semáforo ${p.recurso} cheio (${ocupantes.length}/${limite})`,
    ocupantes: [...ocupantes],
  };
}

function trocarOcupantes(s: Semaforos, p: PedidoVaga, novos: readonly string[]): Semaforos {
  if (porDestino(p.recurso)) {
    const sem = s[p.recurso];
    const ocupantes = { ...sem.ocupantes };
    if (novos.length === 0) delete ocupantes[p.chave!];
    else ocupantes[p.chave!] = novos;
    return { ...s, [p.recurso]: { ...sem, ocupantes } };
  }
  return { ...s, [p.recurso]: { ...s[p.recurso], ocupantes: novos } };
}

/** Ocupa a vaga (novo objeto). Lança se não houver vaga: chame `podeIniciar` antes. */
export function ocupar(s: Semaforos, p: PedidoVaga): Semaforos {
  const v = podeIniciar(s, p);
  if (!v.ok) throw new Error(v.razao);
  if (v.ja_ocupa) return s;
  return trocarOcupantes(s, p, [...ocupantesDe(s, p).ocupantes, p.execucao_id]);
}

/** Solta a vaga (no-op se não ocupava). */
export function liberar(s: Semaforos, p: PedidoVaga): Semaforos {
  const atuais = ocupantesDe(s, p).ocupantes;
  if (!atuais.includes(p.execucao_id)) return s;
  return trocarOcupantes(
    s,
    p,
    atuais.filter((id) => id !== p.execucao_id),
  );
}

/** Solta TODAS as vagas da execução, menos o `schema` (preso até mergeado/descartado/cancelado). */
export function liberarTudoMenosSchema(s: Semaforos, execucaoId: string): Semaforos {
  let novo = s;
  for (const recurso of ['planejadores', 'agentes'] as const) {
    novo = liberar(novo, { execucao_id: execucaoId, recurso });
  }
  for (const chave of Object.keys(novo.merge.ocupantes)) {
    novo = liberar(novo, { execucao_id: execucaoId, recurso: 'merge', chave });
  }
  return novo;
}

/** Etapas que consomem cota da assinatura (freio bloqueia o início, 03 §7.6). */
export const ETAPAS_DE_AGENTE: readonly TipoEtapa[] = [
  'planejar',
  'implementar',
  'revisar',
  'relatar',
  'conversar',
  'resolver_conflito',
];

/**
 * Vagas que uma etapa prende (03 §7.2). A vaga de `agentes` é por TURNO;
 * `verificar` (coleta, FJ-032) e `evidenciar` não prendem nada (não há processo);
 * `integrar` prende o `merge` do destino (a reverificação pelo revisor, quando
 * há, roda dentro dela); a conversa não usa vaga.
 */
export function recursosDaEtapa(
  tipo: TipoEtapa,
  ctx: { chave_destino: string; precisa_token_schema?: boolean },
): Omit<PedidoVaga, 'execucao_id'>[] {
  switch (tipo) {
    case 'planejar':
      return [{ recurso: 'planejadores' }];
    case 'implementar':
      return ctx.precisa_token_schema
        ? [{ recurso: 'agentes' }, { recurso: 'schema', chave: ctx.chave_destino }]
        : [{ recurso: 'agentes' }];
    case 'revisar':
    case 'relatar':
    case 'resolver_conflito':
      return [{ recurso: 'agentes' }];
    case 'verificar':
    case 'evidenciar':
      return [];
    case 'integrar':
      return [{ recurso: 'merge', chave: ctx.chave_destino }];
    case 'conversar':
      return [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Distribuição de vagas (03 §7.2 "vaga vai primeiro para quem está mais adiante")
// ---------------------------------------------------------------------------

/** Mais adiante primeiro: `relatando` > `revisando` > `implementando` > nova execução. */
export function pesoAvanco(estado: EstadoExecucao): number {
  switch (estado) {
    case 'relatando':
      return 0;
    case 'revisando':
      return 1;
    case 'integrando':
    case 'verificando':
      return 2;
    case 'implementando':
    case 'retrabalho_humano':
      return 3;
    case 'plano_pronto':
    case 'aguardando_plano':
    case 'planejando':
      return 4;
    default:
      return 5;
  }
}

export interface CandidatoVaga {
  execucao_id: string;
  /** Estado em que a etapa vai rodar (ou `na_fila` para nova execução). */
  estado: EstadoExecucao;
  etapa: TipoEtapa;
  /** Posição na ordem de início (`ordenarInicio`), menor = antes. */
  ordem: number;
  chave_destino: string;
  /** `implementar` com `plano.schema_banco.altera` (03 §7.3). */
  precisa_token_schema?: boolean;
}

export interface EntradaDistribuicao {
  candidatos: readonly CandidatoVaga[];
  semaforos: Semaforos;
  /** Freio de cota ativo (`avaliarFreio`). */
  freio_ativo: boolean;
  /** CLI na versão compatível (03 §11 "CLI atualizada"). */
  cli_compativel: boolean;
}

export interface ResultadoDistribuicao {
  iniciar: { execucao_id: string; etapa: TipoEtapa }[];
  aguardando: { execucao_id: string; razao: string; ocupantes?: string[] }[];
  semaforos: Semaforos;
}

/**
 * Decide quem começa agora. Ordem: mais adiante primeiro, depois `ordem` do
 * lote. Freio e CLI incompatível só seguram etapas de AGENTE (verificação e
 * integração seguem). A conversa nunca entra aqui (é iniciada pelo humano).
 */
export function distribuirVagas(e: EntradaDistribuicao): ResultadoDistribuicao {
  let s = e.semaforos;
  const iniciar: ResultadoDistribuicao['iniciar'] = [];
  const aguardando: ResultadoDistribuicao['aguardando'] = [];
  const fila = [...e.candidatos].sort(
    (a, b) => pesoAvanco(a.estado) - pesoAvanco(b.estado) || a.ordem - b.ordem,
  );
  for (const c of fila) {
    const deAgente = ETAPAS_DE_AGENTE.includes(c.etapa);
    if (deAgente && e.freio_ativo) {
      aguardando.push({ execucao_id: c.execucao_id, razao: 'freio de cota' });
      continue;
    }
    if (deAgente && !e.cli_compativel) {
      aguardando.push({ execucao_id: c.execucao_id, razao: 'CLI incompatível' });
      continue;
    }
    const pedidos = recursosDaEtapa(c.etapa, c).map((p) => ({ ...p, execucao_id: c.execucao_id }));
    const negado = pedidos.map((p) => ({ p, v: podeIniciar(s, p) })).find((x) => !x.v.ok);
    if (negado && !negado.v.ok) {
      aguardando.push({
        execucao_id: c.execucao_id,
        razao:
          negado.p.recurso === 'schema'
            ? 'aguardando vaga de schema'
            : `aguardando vaga (${negado.p.recurso})`,
        ocupantes: negado.v.ocupantes,
      });
      continue;
    }
    for (const p of pedidos) s = ocupar(s, p);
    iniciar.push({ execucao_id: c.execucao_id, etapa: c.etapa });
  }
  return { iniciar, aguardando, semaforos: s };
}

// ---------------------------------------------------------------------------
// Token `schema` (03 §7.3)
// ---------------------------------------------------------------------------

/** O token é solto em `mergeado`/`descartado`/`cancelado`; em `precisa_humano` continua preso. */
export function soltaTokenSchema(para: EstadoExecucao): boolean {
  return ESTADOS_QUE_SOLTAM_SCHEMA.includes(para);
}

export type DecisaoSchemaImprevisto =
  | { acao: 'ja_tem' }
  | { acao: 'tomar'; semaforos: Semaforos }
  /** Ocupado: segue até G2 com o alerta; a fila só integra depois de quem segura (03 §7.3). */
  | { acao: 'alertar'; ocupantes: string[]; alerta: string };

/** O selo `altera_banco` apareceu sem previsão no plano: tenta tomar o token. */
export function decidirSchemaImprevisto(
  s: Semaforos,
  execucaoId: string,
  chave: string,
): DecisaoSchemaImprevisto {
  const pedido: PedidoVaga = { execucao_id: execucaoId, recurso: 'schema', chave };
  const v = podeIniciar(s, pedido);
  if (v.ok)
    return v.ja_ocupa ? { acao: 'ja_tem' } : { acao: 'tomar', semaforos: ocupar(s, pedido) };
  return {
    acao: 'alertar',
    ocupantes: v.ocupantes,
    alerta: `schema concorrente com ${v.ocupantes.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// Fila de merge e falha parcial (03 §7.5, §8; I-5)
// ---------------------------------------------------------------------------

export interface ItemFila {
  id: string;
  execucao_id: string;
  ordem: number;
  estado:
    | 'aguardando'
    | 'integrando'
    | 'verificando'
    | 'publicando'
    | 'concluido'
    | 'devolvido'
    | 'conflito';
  /** Schema concorrente: só integra depois desta execução chegar a `mergeado` (03 §7.3). */
  depois_de_execucao_id?: string | null;
}

/**
 * Próximo item a integrar numa fila `(projeto, destino)`: nenhum se já há um
 * em processamento (I-5) ou se a sentinela travou a fila; senão o primeiro
 * `aguardando` pela ordem, pulando quem espera um schema concorrente ainda
 * não mergeado — "sem esperar aprovações pendentes de itens anteriores".
 */
export function proximoDaFilaMerge(
  itens: readonly ItemFila[],
  opcoes: { mergeadas: ReadonlySet<string>; travada?: boolean },
): ItemFila | null {
  if (opcoes.travada) return null;
  const emProcesso = ['integrando', 'verificando', 'publicando'];
  if (itens.some((i) => emProcesso.includes(i.estado))) return null;
  return (
    [...itens]
      .filter((i) => i.estado === 'aguardando')
      .sort((a, b) => a.ordem - b.ordem)
      .find((i) => !i.depois_de_execucao_id || opcoes.mergeadas.has(i.depois_de_execucao_id)) ??
    null
  );
}

const FASES: readonly EstadoLote[] = ['planejando', 'mesa_de_planos', 'implementando', 'encerrado'];

const MESA: readonly EstadoExecucao[] = [
  'plano_pronto',
  'aguardando_plano',
  'aguardando_decisao',
  'aguardando_cliente_resposta',
];

/** Estados que só existem depois de algum plano aprovado (inclui `concluido`). */
const IMPLEMENTACAO: readonly EstadoExecucao[] = [
  'implementando',
  'verificando',
  'revisando',
  'relatando',
  'aguardando_aprovacao',
  'retrabalho_humano',
  'na_fila_merge',
  'integrando',
  'resolvendo_conflito',
  'mergeado',
  'comunicando',
  'mergeado_pendente_chamado',
  'aguardando_deploy',
  'concluido',
];

/**
 * Fase do lote (`estado_lote`, 03 §7.1) derivada das execuções, monotônica:
 * nunca volta. Encerrado = todas terminais. Laterais e `precisa_humano` não
 * movem a fase (podem acontecer em qualquer uma). "Com pendências" não é estado.
 */
export function faseDoLote(atual: EstadoLote, estados: readonly EstadoExecucao[]): EstadoLote {
  if (atual === 'cancelado' || atual === 'encerrado') return atual;
  let alvo: EstadoLote = 'planejando';
  if (estados.length > 0 && estados.every(estadoTerminal)) alvo = 'encerrado';
  else if (estados.some((e) => IMPLEMENTACAO.includes(e))) alvo = 'implementando';
  else if (estados.some((e) => MESA.includes(e))) alvo = 'mesa_de_planos';
  return FASES.indexOf(alvo) > FASES.indexOf(atual) ? alvo : atual;
}

/** Há execução que precisa de você (03 §7.1: derivado, não é estado). */
export function lotePendencias(estados: readonly EstadoExecucao[]): boolean {
  return estados.some((e) => e === 'precisa_humano' || e === 'falhou');
}
