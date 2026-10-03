/**
 * Entrada das rotas JSON (specs/forja/01 §4.1; `comum/dto.ts` "GET recebe a
 * entrada como query string; POST/PUT como corpo JSON").
 *
 * POR QUE normalizar a query: `montarQuery` (comum) serializa listas como
 * chaves repetidas e números/booleanos como texto; o Fastify devolve string
 * para uma ocorrência e array para várias. Sem esta volta, `status=novo`
 * chegaria à fachada como `'novo'` em vez de `['novo']` e `limite=50` como
 * texto. Os campos são poucos e de nome único em todo o contrato, então uma
 * tabela por NOME de campo basta (sem schema por rota). Número inválido é 400
 * — nunca `NaN` silencioso no SQL.
 */

/** Campos de filtro que são listas (`FiltrosFilaDto`, `FiltrosHistoricoDto`, …). */
const LISTAS: ReadonlySet<string> = new Set([
  'status',
  'natureza',
  'prioridade',
  'complexidade',
  'resultado',
  'nomes',
]);
/** Inteiros não negativos (`FiltrosFeedDto`, `FiltrosTranscriptDto`, `FiltrosDiffDto`). */
const NUMEROS: ReadonlySet<string> = new Set([
  'depois_de_seq',
  'antes_de_seq',
  'limite',
  'pagina',
  'versao',
]);
const BOOLEANOS: ReadonlySet<string> = new Set(['so_implementaveis', 'mesmo_assim']);
/** Parâmetros do transporte, não da rota: o token da abertura e o replay do SSE. */
const IGNORADOS: ReadonlySet<string> = new Set(['t', 'ultimo_seq']);

export type ResultadoEntrada =
  { ok: true; entrada: Record<string, unknown> } | { ok: false; mensagem: string };

function comoTexto(valor: unknown): string[] {
  const lista = Array.isArray(valor) ? valor : [valor];
  return lista.filter((v): v is string => typeof v === 'string');
}

export function normalizarQuery(query: unknown): ResultadoEntrada {
  const entrada: Record<string, unknown> = {};
  if (query === null || query === undefined) return { ok: true, entrada };
  if (typeof query !== 'object') return { ok: false, mensagem: 'query inválida' };
  for (const [chave, bruto] of Object.entries(query as Record<string, unknown>)) {
    if (IGNORADOS.has(chave)) continue;
    const valores = comoTexto(bruto);
    if (valores.length === 0) continue;
    if (LISTAS.has(chave)) {
      // `status=novo,em_triagem` também é aceito (mesma forma da API do Chamados).
      entrada[chave] = valores.flatMap((v) => v.split(',')).filter((v) => v !== '');
      continue;
    }
    const ultimo = valores[valores.length - 1]!;
    if (NUMEROS.has(chave)) {
      if (!/^\d{1,15}$/.test(ultimo)) {
        return { ok: false, mensagem: `${chave} precisa ser um inteiro não negativo` };
      }
      entrada[chave] = Number(ultimo);
      continue;
    }
    if (BOOLEANOS.has(chave)) {
      if (ultimo !== 'true' && ultimo !== 'false') {
        return { ok: false, mensagem: `${chave} precisa ser true ou false` };
      }
      entrada[chave] = ultimo === 'true';
      continue;
    }
    entrada[chave] = ultimo;
  }
  return { ok: true, entrada };
}

/** Corpo de POST/PUT: objeto JSON (ausente = `{}`); lista ou escalar é 400. */
export function normalizarCorpo(corpo: unknown): ResultadoEntrada {
  if (corpo === null || corpo === undefined || corpo === '') return { ok: true, entrada: {} };
  if (typeof corpo !== 'object' || Array.isArray(corpo)) {
    return { ok: false, mensagem: 'o corpo precisa ser um objeto JSON' };
  }
  return { ok: true, entrada: corpo as Record<string, unknown> };
}
