import type { Complexidade, Natureza, StatusChamado } from '@chamados/shared';
import type { ItemChamado } from '@chamados/cliente-api';
import type { LinkAcaoDto, PreCondicaoDto } from '../../comum/dto';
import type { PrIa } from './notas-ia';
import type { OperacoesChamados } from './tipos';

/**
 * Consulta da fila e pré-condições do G0 (specs/forja/07 §3 "Fila",
 * "Mapeamento", "Pré-condições"; 03 §4.1; 02 §4.3).
 *
 * Fila = `GET /api/v1/chamados` DUAS vezes (uma por natureza: o parâmetro não
 * aceita lista [V: 02 §2]), status `em_atendimento,aguardando_cliente`,
 * paginando até `proximo_cursor = null`. `duvida` fica fora: não muda o sistema.
 *
 * Complexidade: antes da D-036, `?complexidade=` é IGNORADO EM SILÊNCIO [V: D4],
 * então só vai na query com a D-036 detectada; o filtro em memória roda SEMPRE
 * (com a D-036, como defesa). Com filtro presente, complexidade `null` fica fora
 * — a mesma regra da L3 (07 §11.3).
 *
 * D-036 detectada pela PRESENÇA de `ia_silenciada` no item da lista (07 §2.5).
 *
 * Mapeamento sistema → projeto: por `sistema_alvo_id` quando a API traz (L2) e
 * por nome como fallback (frágil a renomear). Na primeira vez que o id aparece
 * para um mapeamento por nome, devolvemos a conversão para a R3 gravar o id.
 */

export const STATUS_FILA: readonly StatusChamado[] = ['em_atendimento', 'aguardando_cliente'];
export const NATUREZAS_FILA: readonly Extract<Natureza, 'alteracao' | 'problema'>[] = [
  'alteracao',
  'problema',
];

/** `true`/`false` = D-036 presente/ausente; `null` = lista vazia (indeterminado). */
export function detectarD036(itens: readonly ItemChamado[]): boolean | null {
  if (itens.length === 0) return null;
  return itens.some((i) => typeof i.ia_silenciada === 'boolean');
}

/** Filtro de complexidade em memória (lista vazia/ausente = sem filtro; `null` fica fora). */
export function filtrarComplexidade(
  itens: readonly ItemChamado[],
  complexidades: readonly Complexidade[] | undefined,
): ItemChamado[] {
  if (!complexidades || complexidades.length === 0) return [...itens];
  const aceitas = new Set(complexidades);
  return itens.filter((i) => i.complexidade != null && aceitas.has(i.complexidade));
}

export interface OpcoesConsultaFila {
  complexidades?: readonly Complexidade[];
  /** Modo D-036 já conhecido (`null`/ausente = não usa `?complexidade=`). */
  d036?: boolean | null;
  sinal?: AbortSignal;
}

export interface ResultadoFila {
  itens: ItemChamado[];
  /** Detectado NESTA leitura (`null` se veio vazia: mantenha o modo anterior). */
  d036: boolean | null;
}

export async function consultarFila(
  api: Pick<OperacoesChamados, 'listarTodosChamados'>,
  opcoes: OpcoesConsultaFila = {},
): Promise<ResultadoFila> {
  const complexidades = opcoes.complexidades?.length ? [...opcoes.complexidades] : undefined;
  const noServidor = opcoes.d036 === true ? complexidades : undefined;
  const listas = await Promise.all(
    NATUREZAS_FILA.map((natureza) =>
      api.listarTodosChamados(
        { status: [...STATUS_FILA], natureza, limite: 100, complexidade: noServidor },
        { sinal: opcoes.sinal },
      ),
    ),
  );
  const porId = new Map<string, ItemChamado>();
  for (const item of listas.flat()) {
    // Defesa: o filtro de natureza/status é do servidor, mas a fila nunca mostra o resto.
    if (!NATUREZAS_FILA.includes(item.natureza as (typeof NATUREZAS_FILA)[number])) continue;
    if (!STATUS_FILA.includes(item.status)) continue;
    porId.set(item.id, item);
  }
  const todos = [...porId.values()];
  return { itens: filtrarComplexidade(todos, complexidades), d036: detectarD036(listas.flat()) };
}

// ---------------------------------------------------------------------------
// Mapeamento sistema-alvo → projeto (02 §4.3)
// ---------------------------------------------------------------------------

export interface MapeamentoSistema {
  id: string;
  projeto_id: string;
  sistema_alvo_id: string | null;
  sistema_nome: string;
}

export type ResolucaoProjeto =
  | {
      projeto_id: string;
      mapeamento_id: string;
      via: 'id' | 'nome';
      /** Mapeamento por nome que deve passar a guardar este id (L2). */
      converter_para_id: string | null;
    }
  | { projeto_id: null; mapeamento_id: null; via: null; motivo: 'sem_sistema' | 'sem_mapeamento' };

export function normalizarNomeSistema(nome: string): string {
  return nome.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

export function resolverProjeto(
  item: Pick<ItemChamado, 'sistema_nome' | 'sistema_alvo_id'>,
  mapeamentos: readonly MapeamentoSistema[],
): ResolucaoProjeto {
  const id = item.sistema_alvo_id ?? null;
  if (id) {
    const porId = mapeamentos.find((m) => m.sistema_alvo_id === id);
    if (porId) {
      return {
        projeto_id: porId.projeto_id,
        mapeamento_id: porId.id,
        via: 'id',
        converter_para_id: null,
      };
    }
  }
  if (!item.sistema_nome && !id) {
    return { projeto_id: null, mapeamento_id: null, via: null, motivo: 'sem_sistema' };
  }
  if (item.sistema_nome) {
    const nome = normalizarNomeSistema(item.sistema_nome);
    // Um mapeamento que já guarda OUTRO id não casa por nome (renomeação cruzada).
    const porNome = mapeamentos.find(
      (m) =>
        normalizarNomeSistema(m.sistema_nome) === nome &&
        (m.sistema_alvo_id === null || id === null),
    );
    if (porNome) {
      return {
        projeto_id: porNome.projeto_id,
        mapeamento_id: porNome.id,
        via: 'nome',
        converter_para_id: porNome.sistema_alvo_id === null && id ? id : null,
      };
    }
  }
  return { projeto_id: null, mapeamento_id: null, via: null, motivo: 'sem_mapeamento' };
}

// ---------------------------------------------------------------------------
// Pré-condições do G0 (03 §4.1; 07 §3, §5)
// ---------------------------------------------------------------------------

// FJ-031: a IA do servidor (triagem) é irrelevante para a Forja — quem
// implementa é o Claude local. `ia_silenciada` NÃO é pré-condição (nem
// bloqueio, nem "não se sabe", nem confirmação); o sinal é só informativo.

export interface EntradaG0 {
  chamado: {
    status: StatusChamado;
    natureza: Natureza;
  };
  projeto: ResolucaoProjeto;
  execucaoAtiva: boolean;
  conexaoOk: boolean;
  /** Bloqueio do pipeline (CLI incompatível, auth…) — calculado pela R3. */
  pipelineDesbloqueado?: boolean;
  /** PR/branch `ia/chamado-N-*` do chamado, se detectado (sinais). */
  prIa?: PrIa | null;
}

export interface AvaliacaoG0 {
  pre_condicoes: PreCondicaoDto[];
  implementavel: boolean;
  /** Algum ok exige confirmação/ciente explícito no G0. */
  exige_confirmacao: boolean;
  /** PR da IA vira `trabalho_existente` para o planejador e força o G1 (03 §4.1). */
  trabalho_existente: PrIa | null;
  forca_g1: boolean;
}

function pc(
  codigo: PreCondicaoDto['codigo'],
  ok: boolean,
  motivo: string | null = null,
  acao: LinkAcaoDto | null = null,
  exige_confirmacao?: boolean,
): PreCondicaoDto {
  return { codigo, ok, motivo, acao, ...(exige_confirmacao ? { exige_confirmacao } : {}) };
}

const MOTIVO_STATUS: Partial<Record<StatusChamado, string>> = {
  novo: 'O chamado ainda está "novo": a triagem do servidor nem começou.',
  em_triagem:
    'O chamado está em triagem: a IA do servidor pode estar rodando. Aguarde "em atendimento".',
  resolvido: 'O chamado já está resolvido.',
  fechado: 'O chamado está fechado.',
  cancelado: 'O chamado foi cancelado.',
};

export function avaliarG0(e: EntradaG0): AvaliacaoG0 {
  const lista: PreCondicaoDto[] = [];
  const { status, natureza } = e.chamado;
  if (status === 'em_atendimento') lista.push(pc('status', true));
  else if (status === 'aguardando_cliente') {
    lista.push(
      pc(
        'status',
        true,
        'O chamado aguarda o cliente: confirme que quer implementar mesmo assim.',
        null,
        true,
      ),
    );
  } else
    lista.push(
      pc('status', false, MOTIVO_STATUS[status] ?? `Status "${status}" não implementável.`),
    );

  lista.push(
    natureza === 'problema' || natureza === 'alteracao'
      ? pc('natureza', true)
      : pc('natureza', false, 'Dúvidas não mudam o sistema: não há o que implementar.'),
  );

  lista.push(
    e.projeto.projeto_id !== null
      ? pc('sistema_mapeado', true)
      : pc(
          'sistema_mapeado',
          false,
          e.projeto.motivo === 'sem_sistema'
            ? 'O chamado não tem sistema-alvo.'
            : 'O sistema-alvo deste chamado não está ligado a nenhum projeto.',
          { rotulo: 'Mapear sistema', href: '/projetos' },
        ),
  );

  lista.push(
    e.execucaoAtiva
      ? pc(
          'sem_execucao_ativa',
          false,
          'Já existe uma execução da Forja em andamento para este chamado.',
        )
      : pc('sem_execucao_ativa', true),
  );
  lista.push(
    e.conexaoOk
      ? pc('conexao_ok', true)
      : pc('conexao_ok', false, 'A conexão com o Chamados não está válida.', {
          rotulo: 'Conexão',
          href: '/conexao',
        }),
  );
  lista.push(
    e.pipelineDesbloqueado === false
      ? pc('pipeline_desbloqueado', false, 'O pipeline está bloqueado: veja o Diagnóstico.', {
          rotulo: 'Diagnóstico',
          href: '/diagnostico',
        })
      : pc('pipeline_desbloqueado', true),
  );

  const prIa = e.prIa ?? null;
  return {
    pre_condicoes: lista,
    implementavel: lista.every((p) => p.ok),
    exige_confirmacao: lista.some((p) => p.ok && p.exige_confirmacao),
    trabalho_existente: prIa,
    forca_g1: prIa !== null,
  };
}
