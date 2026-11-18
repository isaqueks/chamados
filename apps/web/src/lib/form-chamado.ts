import { Natureza, Prioridade, ehEstimativaCusto, type EstimativaCusto } from '@chamados/shared';
import type { DocRico } from '@chamados/db';

/**
 * Lógica PURA do formulário "Novo chamado" do painel (D-040, specs/04 §2):
 * leitura/validação do FormData antes de chamar `criarChamado` e o filtro do
 * seletor de solicitante. Sem dependência de Next/React — coberta por vitest. O
 * serviço continua sendo a fonte da verdade das regras (título, corpo, alvo,
 * solicitante ativo do tenant); aqui só se recusa cedo o que é malformado e se
 * evita mandar ao banco um id que nem é UUID.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entrada já normalizada, pronta para `criarChamado` (com `cliente_id`). */
export interface EntradaFormChamado {
  titulo: string;
  descricao: DocRico;
  natureza: Natureza;
  prioridade?: Prioridade;
  sistema_alvo_id?: string;
  cliente_id: string;
  /** D-043: estimativa de custo opcional já na abertura (só a equipe abre por aqui). */
  estimativa_custo?: EstimativaCusto;
}

export type ResultadoFormChamado =
  { ok: true; entrada: EntradaFormChamado } | { ok: false; erro: string };

/** Subconjunto de `FormData` usado (facilita o teste com um `FormData` real). */
interface LeitorForm {
  get(nome: string): FormDataEntryValue | null;
}

function texto(fd: LeitorForm, nome: string): string {
  const v = fd.get(nome);
  return typeof v === 'string' ? v : '';
}

function ehNatureza(v: string): v is Natureza {
  return (Object.values(Natureza) as string[]).includes(v);
}
function ehPrioridade(v: string): v is Prioridade {
  return (Object.values(Prioridade) as string[]).includes(v);
}

/** Converte o JSON do editor (string) num doc TipTap; `null` se malformado. */
export function parseDocEditor(bruto: string): DocRico | null {
  try {
    const obj = JSON.parse(bruto) as unknown;
    if (obj && typeof obj === 'object' && (obj as { type?: unknown }).type === 'doc') {
      return obj as DocRico;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Lê o formulário do painel. Regras:
 * - `solicitante_id` obrigatório e UUID (o serviço confere papel/ativo/tenant);
 * - `natureza` vazia = "Automático" (D-017): abre como `problema` e a IA
 *   reclassifica na triagem — o mesmo default do portal e da API (D-032);
 * - `prioridade` vazia = default do serviço (`media`);
 * - `sistema_alvo_id` vazio = auto-resolução do serviço (1 sistema → ele;
 *   0 → categoria geral; >1 → `sistema_alvo_obrigatorio`); preenchido, tem de ser UUID;
 * - `estimativa_custo` vazia = sem estimativa (D-043); preenchida, um código A–E/I.
 */
export function lerFormNovoChamado(fd: LeitorForm): ResultadoFormChamado {
  const solicitante = texto(fd, 'solicitante_id').trim();
  if (!solicitante) return { ok: false, erro: 'Selecione o cliente solicitante.' };
  if (!RE_UUID.test(solicitante)) return { ok: false, erro: 'Solicitante inválido.' };

  const naturezaRaw = texto(fd, 'natureza');
  const natureza = naturezaRaw === '' ? Natureza.problema : naturezaRaw;
  if (!ehNatureza(natureza)) return { ok: false, erro: 'Natureza inválida.' };

  const prioridadeRaw = texto(fd, 'prioridade');
  let prioridade: Prioridade | undefined;
  if (prioridadeRaw !== '') {
    if (!ehPrioridade(prioridadeRaw)) return { ok: false, erro: 'Prioridade inválida.' };
    prioridade = prioridadeRaw;
  }

  const sistema = texto(fd, 'sistema_alvo_id').trim();
  if (sistema && !RE_UUID.test(sistema)) return { ok: false, erro: 'Sistema-alvo inválido.' };

  const estimativaRaw = texto(fd, 'estimativa_custo');
  if (estimativaRaw !== '' && !ehEstimativaCusto(estimativaRaw)) {
    return { ok: false, erro: 'Estimativa de custo inválida.' };
  }

  const descricao = parseDocEditor(texto(fd, 'descricao'));
  if (!descricao) return { ok: false, erro: 'Descreva o chamado.' };

  return {
    ok: true,
    entrada: {
      titulo: texto(fd, 'titulo').trim(),
      descricao,
      natureza,
      prioridade,
      sistema_alvo_id: sistema || undefined,
      cliente_id: solicitante.toLowerCase(),
      ...(ehEstimativaCusto(estimativaRaw) ? { estimativa_custo: estimativaRaw } : {}),
    },
  };
}

/** Normaliza para busca: minúsculas, sem acentos, espaços colapsados. */
export function normalizarBusca(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Item do seletor de solicitante (`value`/`label` é o formato do Combobox). */
export interface OpcaoSolicitante {
  value: string;
  label: string;
  email: string;
}

/**
 * Filtro do seletor de solicitante: casa por nome OU e-mail, sem diferenciar
 * acento/maiúscula; cada termo da consulta precisa aparecer (ordem livre —
 * "silva maria" acha "Maria da Silva"). Consulta vazia mostra todos.
 */
export function clienteCasaBusca(opcao: OpcaoSolicitante, consulta: string): boolean {
  const termos = normalizarBusca(consulta).split(' ').filter(Boolean);
  if (termos.length === 0) return true;
  const alvo = normalizarBusca(`${opcao.label} ${opcao.email}`);
  return termos.every((t) => alvo.includes(t));
}
