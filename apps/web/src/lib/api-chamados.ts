import {
  StatusChamado,
  Natureza,
  Prioridade,
  Papel,
  type Complexidade,
  type VisibilidadeMensagem,
} from '@chamados/shared';
import type { ChamadoView, FiltrosChamado, MensagemTimeline } from '@chamados/db';
import { htmlParaTexto } from '@chamados/db';

/**
 * Parsing de filtros e PROJEÇÕES da API `/api/v1/chamados` (specs/11 §4).
 *
 * Módulo PURO (sem banco, sem `next/headers`, sem `server-only`): é a tradução
 * entre o contrato HTTP e as formas do domínio — por isso é testável isoladamente,
 * e é aqui que moram as garantias de contrato cobertas por teste. As decisões de
 * permissão NÃO passam por aqui: quem filtra por papel é o service
 * (`listarChamados`, `listarMensagens`) e o serializer de specs/03 §7; estas
 * funções apenas EMITEM o que o domínio já autorizou.
 */

/** Nomes resolvidos em lote (preenchidos por `resolverNomes` em `api-v1.ts`). */
export interface Nomes {
  usuarios: Map<string, { nome: string; papel: Papel }>;
  sistemas: Map<string, string>;
  categorias: Map<string, string>;
}

/**
 * Valida um valor contra um enum canônico. Valor fora do domínio é ERRO
 * explícito (specs/11 §4.1) — filtro silenciosamente ignorado mentiria sobre o
 * resultado ("filtrei por status X" devolvendo tudo).
 */
export function valorEnum<T extends Record<string, string>>(
  e: T,
  valor: string,
): T[keyof T] | null {
  return (Object.values(e) as string[]).includes(valor) ? (valor as T[keyof T]) : null;
}

/** Inteiro dentro de uma faixa fechada (para `limite`). */
export function inteiroNaFaixa(valor: string, min: number, max: number): number | null {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LIMITE_MIN = 1;
export const LIMITE_MAX = 100;

export type ResultadoFiltros = { ok: true; filtros: FiltrosChamado } | { ok: false; erro: string };

/**
 * Interpreta os query params da listagem. Valor fora do domínio é ERRO explícito
 * (specs/11 §4.1) — nunca ignorado em silêncio: um filtro descartado devolveria
 * "todos os chamados" fingindo ter filtrado.
 */
export function parsearFiltros(sp: URLSearchParams): ResultadoFiltros {
  const filtros: FiltrosChamado = {};

  // `status` aceita lista separada por vírgula (ex.: novo,em_triagem).
  const status = sp.get('status');
  if (status !== null) {
    const partes = status
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (partes.length === 0) return { ok: false, erro: 'Parâmetro "status" vazio.' };
    const valores: StatusChamado[] = [];
    for (const p of partes) {
      const v = valorEnum(StatusChamado, p);
      if (!v) {
        return {
          ok: false,
          erro: `Status inválido: "${p}". Valores: ${Object.values(StatusChamado).join(', ')}.`,
        };
      }
      valores.push(v);
    }
    filtros.status = valores;
  }

  const natureza = sp.get('natureza');
  if (natureza !== null) {
    const v = valorEnum(Natureza, natureza.trim());
    if (!v) {
      return {
        ok: false,
        erro: `Natureza inválida: "${natureza}". Valores: ${Object.values(Natureza).join(', ')}.`,
      };
    }
    filtros.natureza = v;
  }

  const prioridade = sp.get('prioridade');
  if (prioridade !== null) {
    const v = valorEnum(Prioridade, prioridade.trim());
    if (!v) {
      return {
        ok: false,
        erro: `Prioridade inválida: "${prioridade}". Valores: ${Object.values(Prioridade).join(', ')}.`,
      };
    }
    filtros.prioridade = v;
  }

  const atribuicao = sp.get('atribuicao');
  if (atribuicao !== null) {
    const v = atribuicao.trim();
    if (v === 'atribuido' || v === 'nao_atribuido') {
      filtros.atribuicao = v;
    } else if (RE_UUID.test(v)) {
      filtros.atribuicao = { operador_id: v };
    } else {
      return {
        ok: false,
        erro: 'Atribuição inválida: use "atribuido", "nao_atribuido" ou o UUID de um operador.',
      };
    }
  }

  const sistema = sp.get('sistema_alvo_id');
  if (sistema !== null) {
    if (!RE_UUID.test(sistema.trim())) {
      return { ok: false, erro: 'Parâmetro "sistema_alvo_id" deve ser um UUID.' };
    }
    filtros.sistema_alvo_id = sistema.trim();
  }

  const categoria = sp.get('categoria_id');
  if (categoria !== null) {
    if (!RE_UUID.test(categoria.trim())) {
      return { ok: false, erro: 'Parâmetro "categoria_id" deve ser um UUID.' };
    }
    filtros.categoria_id = categoria.trim();
  }

  const busca = sp.get('busca');
  if (busca !== null && busca.trim().length > 0) filtros.busca = busca.trim();

  const limite = sp.get('limite');
  if (limite !== null) {
    const n = inteiroNaFaixa(limite.trim(), LIMITE_MIN, LIMITE_MAX);
    if (n === null) {
      return {
        ok: false,
        erro: `Parâmetro "limite" deve ser inteiro entre ${LIMITE_MIN} e ${LIMITE_MAX}.`,
      };
    }
    filtros.limite = n;
  }

  const cursor = sp.get('cursor');
  if (cursor !== null && cursor.trim().length > 0) filtros.cursor = cursor.trim();

  return { ok: true, filtros };
}

// ---------------------------------------------------------------------------
// Projeções
// ---------------------------------------------------------------------------

/** `complexidade` só existe na view da EQUIPE (o serializer a remove do cliente). */
function complexidadeDe(c: ChamadoView): Complexidade | null | undefined {
  return 'complexidade' in c ? c.complexidade : undefined;
}

function operadorIdDe(c: ChamadoView): string | null | undefined {
  return 'operador_id' in c ? c.operador_id : undefined;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Ids referenciados por uma lista de chamados (entrada de `resolverNomes`). */
export function idsDeChamados(itens: ChamadoView[]): {
  usuarios: Array<string | null | undefined>;
  sistemas: Array<string | null | undefined>;
  categorias: Array<string | null | undefined>;
} {
  return {
    usuarios: itens.flatMap((c) => [c.cliente_id, operadorIdDe(c) ?? null]),
    sistemas: itens.map((c) => c.sistema_alvo_id),
    categorias: itens.map((c) => c.categoria_id),
  };
}

/**
 * Item COMPACTO da listagem (specs/11 §4.1): sem a descrição (que só vem no
 * detalhe) e com nomes no lugar de UUIDs — o consumidor é um assistente, e cada
 * campo inútil é token desperdiçado. Campos internos (`complexidade`) só
 * aparecem se a view do papel os trouxe.
 */
export function projetarItemLista(c: ChamadoView, nomes: Nomes): Record<string, unknown> {
  const complexidade = complexidadeDe(c);
  const operadorId = operadorIdDe(c);
  return {
    id: c.id,
    numero: Number(c.numero),
    titulo: c.titulo,
    status: c.status,
    natureza: c.natureza,
    prioridade: c.prioridade,
    ...(complexidade !== undefined ? { complexidade } : {}),
    ...(operadorId !== undefined
      ? { operador_nome: operadorId ? (nomes.usuarios.get(operadorId)?.nome ?? null) : null }
      : {}),
    solicitante_nome: nomes.usuarios.get(c.cliente_id)?.nome ?? null,
    sistema_nome: c.sistema_alvo_id ? (nomes.sistemas.get(c.sistema_alvo_id) ?? null) : null,
    categoria_nome: c.categoria_id ? (nomes.categorias.get(c.categoria_id) ?? null) : null,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  };
}

/** Detalhe do chamado: como o item, mais a descrição em TEXTO puro (specs/11 §4.2). */
export function projetarDetalhe(c: ChamadoView, nomes: Nomes): Record<string, unknown> {
  const complexidade = complexidadeDe(c);
  const iaSilenciada = 'ia_silenciada' in c ? c.ia_silenciada : undefined;
  return {
    ...projetarItemLista(c, nomes),
    descricao: htmlParaTexto(c.descricao_html),
    ...(iaSilenciada !== undefined ? { ia_silenciada: iaSilenciada } : {}),
    resolvido_em: iso(c.resolvido_em),
    fechar_automaticamente_em: iso(c.fechar_automaticamente_em),
    fechado_em: iso(c.fechado_em),
    reaberto_count: c.reaberto_count,
  };
}

/**
 * Timeline: corpo em TEXTO puro (nunca HTML — specs/11 §1.5) e autor por
 * nome+papel. `visibilidade` só existe nos itens da EQUIPE: para o cliente, o
 * repositório nem trouxe notas internas e o serializer removeu o campo, então a
 * ausência aqui é consequência da fronteira, não uma segunda decisão.
 */
export function projetarMensagens(
  mensagens: MensagemTimeline[],
  nomes: Nomes,
): Array<Record<string, unknown>> {
  return mensagens.map((m) => {
    const autor = nomes.usuarios.get(m.autor_id);
    const visibilidade: VisibilidadeMensagem | undefined =
      'visibilidade' in m ? m.visibilidade : undefined;
    return {
      id: m.id,
      autor_nome: autor?.nome ?? null,
      autor_papel: autor?.papel ?? null,
      ...(visibilidade !== undefined ? { visibilidade } : {}),
      corpo: htmlParaTexto(m.corpo_html),
      created_at: iso(m.created_at),
    };
  });
}

/** Ids de autor de uma timeline (entrada de `resolverNomes`). */
export function idsDeMensagens(mensagens: MensagemTimeline[]): Array<string | null | undefined> {
  return mensagens.map((m) => m.autor_id);
}

/** O papel é de equipe (operador/admin)? Usado só para mensagens de erro claras. */
export function ehEquipe(papel: Papel): boolean {
  return papel === Papel.operador || papel === Papel.admin;
}
