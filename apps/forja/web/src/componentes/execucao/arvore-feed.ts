import { ehMarco, type EventoForja } from '@comum/protocolo-eventos';

/**
 * Árvore do feed da Execução (specs/forja/06 §4.2 "Árvore Fable → Opus").
 *
 * POR QUE uma árvore e não uma lista: o condutor (Fable) despacha subagentes
 * Opus pela ferramenta `Agent`; tudo o que um subagente faz chega com
 * `parent_tool_use_id` = `tool_use_id` daquela chamada `Agent` (o texto do
 * subagente só vem com `--forward-subagent-text`, [V 01 §4]). Aninhar por esse
 * id é o que deixa ler "o que o Opus fez a mando de qual despacho".
 *
 * Regras (puras, testadas):
 * - Toda `agente.ferramenta` vira um nó indexado pelo seu `tool_use_id`; o
 *   `agente.resultado_ferramenta` correspondente é anexado ao nó (linha
 *   "executou npm run typecheck · exit 0"), não vira linha própria.
 * - `subagente.iniciado`/`subagente.concluido` enriquecem o nó do `Agent`
 *   (nome do subagente, modelo de `modelUsage`, status).
 * - Evento com `parent_tool_use_id` desconhecido (o despacho ficou fora da
 *   janela carregada) cria um nó-grupo "despacho anterior" para não achatar a
 *   árvore — a nidificação nunca depende da ordem de paginação.
 * - Modo "Marcos" (padrão) poda nós que não são marco (`ehMarco`), mas mantém
 *   um nó não-marco se algum descendente for marco.
 */

export type ModoFeed = 'marcos' | 'tudo';

export interface InfoSubagente {
  nome: string;
  descricao: string | null;
  modelo: string | null;
  status: string | null;
  resumo: string | null;
}

export interface NoFeed {
  /** Chave estável para React: `seq` do evento que originou o nó. */
  chave: string;
  evento: EventoForja | null;
  /** Resultado da ferramenta deste nó (se houver). */
  resultado: Extract<EventoForja, { tipo: 'agente.resultado_ferramenta' }> | null;
  /** Preenchido nos nós de despacho `Agent`. */
  subagente: InfoSubagente | null;
  filhos: NoFeed[];
  /** Grupo criado para um `parent_tool_use_id` sem despacho carregado. */
  orfao: boolean;
}

type EventoComAutoria = Extract<
  EventoForja,
  {
    tipo:
      | 'agente.texto'
      | 'agente.ferramenta'
      | 'agente.resultado_ferramenta'
      | 'agente.fora_do_papel'
      | 'permissao.negada';
  }
>;

function temAutoria(e: EventoForja): e is EventoComAutoria {
  return (
    e.tipo === 'agente.texto' ||
    e.tipo === 'agente.ferramenta' ||
    e.tipo === 'agente.resultado_ferramenta' ||
    e.tipo === 'agente.fora_do_papel' ||
    e.tipo === 'permissao.negada'
  );
}

function novoNo(evento: EventoForja | null, chave: string): NoFeed {
  return { chave, evento, resultado: null, subagente: null, filhos: [], orfao: false };
}

function ehDespachoAgent(e: EventoForja): boolean {
  return e.tipo === 'agente.ferramenta' && (e.dados.ferramenta === 'Agent' || !!e.dados.subagente);
}

/** Junta eventos por `seq` (sem duplicatas), em ordem crescente. */
export function mesclarEventos(
  atuais: readonly EventoForja[],
  novos: readonly EventoForja[],
): EventoForja[] {
  const porSeq = new Map<number, EventoForja>();
  for (const e of atuais) porSeq.set(e.seq, e);
  for (const e of novos) porSeq.set(e.seq, e);
  return [...porSeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Monta a árvore completa (sem poda), na ordem dos `seq`. */
export function montarArvoreFeed(eventos: readonly EventoForja[]): NoFeed[] {
  const raiz: NoFeed[] = [];
  /** tool_use_id → nó da ferramenta (inclusive despachos `Agent`). */
  const porToolUse = new Map<string, NoFeed>();
  /** tool_use_id de despacho → nó-pai dos eventos do subagente. */
  const despachos = new Map<string, NoFeed>();

  const ordenados = [...eventos].sort((a, b) => a.seq - b.seq);

  function grupoDoPai(parentId: string): NoFeed {
    const existente = despachos.get(parentId);
    if (existente) return existente;
    const grupo = novoNo(null, `orfao:${parentId}`);
    grupo.orfao = true;
    grupo.subagente = {
      nome: 'subagente',
      descricao: null,
      modelo: null,
      status: null,
      resumo: null,
    };
    despachos.set(parentId, grupo);
    porToolUse.set(parentId, grupo);
    raiz.push(grupo);
    return grupo;
  }

  function destino(parentId: string | null): NoFeed[] {
    return parentId ? grupoDoPai(parentId).filhos : raiz;
  }

  for (const e of ordenados) {
    const chave = String(e.seq);
    switch (e.tipo) {
      case 'agente.ferramenta': {
        const existente = porToolUse.get(e.dados.tool_use_id);
        if (existente && existente.orfao) {
          // O despacho chegou depois de filhos já vistos (paginação): adota o grupo.
          existente.evento = e;
          existente.orfao = false;
          existente.chave = chave;
          if (existente.subagente) existente.subagente.nome = e.dados.subagente ?? 'subagente';
          continue;
        }
        const no = novoNo(e, chave);
        if (ehDespachoAgent(e)) {
          no.subagente = {
            nome: e.dados.subagente ?? 'subagente',
            descricao: null,
            modelo: null,
            status: null,
            resumo: null,
          };
          despachos.set(e.dados.tool_use_id, no);
        }
        porToolUse.set(e.dados.tool_use_id, no);
        destino(e.dados.parent_tool_use_id).push(no);
        break;
      }
      case 'agente.resultado_ferramenta': {
        const alvo = porToolUse.get(e.dados.tool_use_id);
        if (alvo && !alvo.orfao) {
          alvo.resultado = e;
        } else {
          destino(e.dados.parent_tool_use_id).push(novoNo(e, chave));
        }
        break;
      }
      case 'subagente.iniciado': {
        const alvo = despachos.get(e.dados.tool_use_id) ?? grupoDoPai(e.dados.tool_use_id);
        alvo.subagente = {
          ...(alvo.subagente ?? { modelo: null, status: null, resumo: null }),
          nome: e.dados.subagente,
          descricao: e.dados.descricao,
        };
        break;
      }
      case 'subagente.concluido': {
        const alvo = despachos.get(e.dados.tool_use_id) ?? grupoDoPai(e.dados.tool_use_id);
        alvo.subagente = {
          ...(alvo.subagente ?? { descricao: null }),
          nome: e.dados.subagente,
          modelo: e.dados.modelo,
          status: e.dados.status,
          resumo: e.dados.resumo,
        };
        break;
      }
      default: {
        if (temAutoria(e)) destino(e.dados.parent_tool_use_id).push(novoNo(e, chave));
        else raiz.push(novoNo(e, chave));
      }
    }
  }
  return raiz;
}

/** O nó em si é marco? Despacho e grupo órfão contam como marco (são a estrutura). */
function noEhMarco(no: NoFeed): boolean {
  if (no.subagente) return true;
  if (no.resultado?.dados.erro) return true;
  return no.evento ? ehMarco(no.evento) : false;
}

/** Poda para o modo "Marcos": mantém marcos e ancestrais de marcos. */
export function podarPorModo(nos: readonly NoFeed[], modo: ModoFeed): NoFeed[] {
  if (modo === 'tudo') return [...nos];
  const saida: NoFeed[] = [];
  for (const no of nos) {
    const filhos = podarPorModo(no.filhos, modo);
    if (noEhMarco(no) || filhos.length > 0) saida.push({ ...no, filhos });
  }
  return saida;
}

/** Atalho: árvore já podada. */
export function arvoreDoFeed(eventos: readonly EventoForja[], modo: ModoFeed): NoFeed[] {
  return podarPorModo(montarArvoreFeed(eventos), modo);
}

/** Contador de negações de permissão (cabeçalho da etapa, 06 §4.2). */
export function contarNegacoes(eventos: readonly EventoForja[], etapaId?: string): number {
  return eventos.filter(
    (e) => e.tipo === 'permissao.negada' && (etapaId === undefined || e.etapa_id === etapaId),
  ).length;
}

export type TomLinhaFeed = 'normal' | 'app' | 'negacao' | 'fora_do_papel' | 'erro' | 'aviso';

/**
 * Tom visual de uma linha: ⚙ eventos do app, NEGADO em rose, "Fable editou
 * diretamente" em âmbar (informativo), erro em rose.
 */
export function tomDaLinha(e: EventoForja): TomLinhaFeed {
  if (e.tipo === 'permissao.negada') return 'negacao';
  if (e.tipo === 'agente.fora_do_papel') return 'fora_do_papel';
  if (e.nivel === 'erro') return 'erro';
  if (e.nivel === 'aviso') return 'aviso';
  if (
    e.tipo === 'execucao.estado' ||
    e.tipo === 'etapa.iniciada' ||
    e.tipo === 'etapa.finalizada' ||
    e.tipo === 'git.checkpoint' ||
    e.tipo === 'verificacao.comando' ||
    e.tipo === 'telemetria.turno' ||
    e.tipo === 'uso.atualizado' ||
    e.tipo === 'cli.alerta' ||
    e.tipo === 'chamado.sinal' ||
    e.tipo === 'fila_merge.item'
  ) {
    return 'app';
  }
  return 'normal';
}

/** Texto da linha do feed — o `resumo` do servidor, com os detalhes que importam. */
export function textoDaLinha(e: EventoForja): string {
  switch (e.tipo) {
    case 'permissao.negada':
      return `NEGADO ${e.dados.ferramenta}(${e.dados.resumo_entrada}) · regra deny da Forja`;
    case 'agente.fora_do_papel':
      return `Fable editou diretamente ${e.dados.alvo} (sem delegar)`;
    case 'verificacao.comando':
      return `${e.dados.nome} · exit ${e.dados.exit_code ?? '—'}`;
    case 'git.checkpoint':
      return `commit${e.dados.passo ? ` do passo ${e.dados.passo}` : ''} · ${e.dados.sha.slice(0, 7)}`;
    default:
      return e.resumo;
  }
}

/** Último marco recebido — o único anunciado ao leitor de tela (06 §9). */
export function ultimoMarco(eventos: readonly EventoForja[]): EventoForja | null {
  for (let i = eventos.length - 1; i >= 0; i -= 1) {
    const e = eventos[i]!;
    if (ehMarco(e)) return e;
  }
  return null;
}

/**
 * "Possivelmente travado" (06 §4.2; sem kill automático): o SERVIDOR decide com
 * o `limites.timeout_min.aviso_inatividade` do projeto e manda
 * `ExecucaoDto.sem_atividade_desde`; a UI só conta a duração no relógio local.
 */
export function semAtividadeHa(desde: string | null, agora: Date = new Date()): number | null {
  if (!desde) return null;
  const t = Date.parse(desde);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, agora.getTime() - t);
}

/**
 * Eventos que mudam o retrato da APROVAÇÃO (06 §4.3): estado, patch novo
 * (commit), fim de etapa (relatório regenerado) e mensagem nova do cliente
 * (o `ciente_mensagem_id` muda). Telemetria e falas não recarregam.
 */
export function exigeRecarregarAprovacao(e: EventoForja): boolean {
  return (
    e.tipo === 'execucao.estado' ||
    e.tipo === 'etapa.finalizada' ||
    e.tipo === 'git.checkpoint' ||
    (e.tipo === 'chamado.sinal' &&
      (e.dados.sinal === 'mensagem_nova' || e.dados.sinal === 'cliente_respondeu'))
  );
}

/** Eventos que mudam o "retrato" da execução (estado, trilha, plano): refazer o GET. */
export function exigeRecarregarExecucao(e: EventoForja): boolean {
  return (
    e.tipo === 'execucao.estado' ||
    e.tipo === 'etapa.iniciada' ||
    e.tipo === 'etapa.finalizada' ||
    e.tipo === 'git.checkpoint' ||
    e.tipo === 'verificacao.comando' ||
    e.tipo === 'telemetria.turno' ||
    (e.tipo === 'chamado.sinal' &&
      (e.dados.sinal === 'mensagem_nova' || e.dados.sinal === 'cliente_respondeu'))
  );
}
