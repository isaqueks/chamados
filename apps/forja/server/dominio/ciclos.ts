import type { VereditoV1 } from '../../comum/contratos';
import type { ConfigResolvidaDto } from '../../comum/dto';
import type { MotivoEstado } from '../../comum/estados';
import type { DecisaoDestino } from './maquina-execucao';
import type { ValidacaoVeredito } from './regras-contratos';
import { similaridadeTrigramas } from './texto';

/**
 * Ciclos, limites e pingue-pongue (specs/forja/03 §6; 04 §6 "decisão do app").
 *
 * POR QUE contadores separados: `max_ciclos_auto` mede se a REVISÃO converge;
 * `max_ciclos_total` é o teto de tudo o que gera um novo T1 (auto + ajustes +
 * Devolver + reverificação reprovada + "mais um ciclo"). O pingue-pongue escala
 * ANTES do limite: repetir o mesmo achado é sinal de que mais um ciclo só
 * queima cota. Desde FJ-032 não há `max_correcoes_verificacao` nem o
 * pingue-pongue (b) de comandos: a Forja não executa comandos do projeto — o
 * próprio implementador roda os checks e corrige o que quebrar.
 */

export type LimitesCiclo = ConfigResolvidaDto['limites']['ciclos'];

export interface ContadoresCiclo {
  ciclo_auto: number;
  ciclo_total: number;
}

/** Limiar de similaridade das descrições de achado (03 §6). */
export const LIMIAR_PINGUE_PONGUE = 0.8;

const SEVERIDADES_PINGUE_PONGUE: readonly VereditoV1['achados'][number]['severidade'][] = [
  'bloqueante',
  'importante',
];

// ---------------------------------------------------------------------------
// Pingue-pongue
// ---------------------------------------------------------------------------

export interface ParRepetido {
  atual: string;
  anterior: string;
  similaridade: number;
}

/**
 * (a) achado `bloqueante`/`importante` com a mesma `(categoria, arquivo)` e
 * descrição com similaridade ≥ 0,8 em dois vereditos CONSECUTIVOS (03 §6).
 * Devolve os ids do veredito atual em repetição (⚙ `VereditoRegistrado.repetidos`).
 */
export function achadosRepetidos(
  anterior: Pick<VereditoV1, 'achados'> | null,
  atual: Pick<VereditoV1, 'achados'>,
  limiar: number = LIMIAR_PINGUE_PONGUE,
): ParRepetido[] {
  if (!anterior) return [];
  const relevantes = (v: Pick<VereditoV1, 'achados'>) =>
    v.achados.filter((a) => SEVERIDADES_PINGUE_PONGUE.includes(a.severidade));
  const pares: ParRepetido[] = [];
  for (const a of relevantes(atual)) {
    let melhor: ParRepetido | null = null;
    for (const b of relevantes(anterior)) {
      if (a.categoria !== b.categoria || a.arquivo !== b.arquivo) continue;
      const s = similaridadeTrigramas(a.descricao, b.descricao);
      if (s >= limiar && (!melhor || s > melhor.similaridade)) {
        melhor = { atual: a.id, anterior: b.id, similaridade: s };
      }
    }
    if (melhor) pares.push(melhor);
  }
  return pares;
}

// ---------------------------------------------------------------------------
// Recusa com instrução e saída inválida (03 §6; 04 §6 "Ordem")
// ---------------------------------------------------------------------------

/** Regra de conteúdo violada: 1 recusa com instrução, depois `precisa_humano`. */
export const MAX_RECUSAS_CONTEUDO = 1;
/** Saída que não passa no zod: 1 nova tentativa, depois `falhou`. */
export const MAX_TENTATIVAS_SAIDA_INVALIDA = 1;
/** Regeração do relatório por incoerência com os selos. */
export const MAX_REGENERACOES_RELATORIO = 1;
/** Veredito inválido (`sha_avaliado` errado): T2 roda de novo 1×. */
export const MAX_REPETICOES_T2 = 1;

export type DecisaoRecusa =
  | { acao: 'aceitar' }
  | { acao: 'recusar'; erros: string[] }
  | { acao: 'precisa_humano'; motivo: MotivoEstado; erros: string[] };

export function decidirRecusa(erros: readonly string[], recusasFeitas: number): DecisaoRecusa {
  if (erros.length === 0) return { acao: 'aceitar' };
  return recusasFeitas < MAX_RECUSAS_CONTEUDO
    ? { acao: 'recusar', erros: [...erros] }
    : { acao: 'precisa_humano', motivo: 'regra_conteudo_violada', erros: [...erros] };
}

export function decidirSaidaInvalida(
  tentativasFeitas: number,
): { acao: 'repetir' } | { acao: 'falhou'; motivo: 'saida_invalida' } {
  return tentativasFeitas < MAX_TENTATIVAS_SAIDA_INVALIDA
    ? { acao: 'repetir' }
    : { acao: 'falhou', motivo: 'saida_invalida' };
}

// ---------------------------------------------------------------------------
// Decisão depois do veredito (03 §2.4 linhas de `revisando`; 04 §6)
// ---------------------------------------------------------------------------

export interface EntradaDecisaoVeredito {
  veredito: VereditoV1;
  validacao: ValidacaoVeredito;
  veredito_anterior: Pick<VereditoV1, 'achados'> | null;
  /** HEAD == sha_verificado depois do T2 (o T2 é só leitura). */
  head_igual_sha_verificado: boolean;
  worktree_limpa: boolean;
  contadores: ContadoresCiclo;
  limites: LimitesCiclo;
  /** Quantas vezes este T2 já foi repetido por veredito inválido / recusado por regra. */
  repeticoes_invalido: number;
  recusas_feitas: number;
}

export type DecisaoDoApp = 'relatando' | 'retrabalho' | 'precisa_humano';

export type DecisaoVeredito =
  | { acao: 'repetir_t2'; motivo_invalido: string }
  | { acao: 'recusar'; erros: string[] }
  | {
      acao: 'transicao';
      decisao: DecisaoDestino;
      /** ⚙ `VereditoRegistrado.decisao_do_app`. */
      decisao_do_app: DecisaoDoApp;
      /** ⚙ `VereditoRegistrado.repetidos`. */
      repetidos: string[];
      incoerencias: string[];
    };

function precisaHumano(
  motivo: MotivoEstado,
  texto: string,
  extra: { repetidos?: string[]; incoerencias?: string[] } = {},
): DecisaoVeredito {
  return {
    acao: 'transicao',
    decisao: { para: 'precisa_humano', motivo, texto },
    decisao_do_app: 'precisa_humano',
    repetidos: extra.repetidos ?? [],
    incoerencias: extra.incoerencias ?? [],
  };
}

/**
 * O app decide; o modelo nunca força avanço (04 §6). Ordem:
 * 1. a revisão alterou a worktree (HEAD ≠ sha_verificado ou suja) → humano;
 * 2. veredito inválido (eco do sha errado) → T2 de novo 1×, depois humano;
 * 3. regra de conteúdo violada → 1 recusa com instrução, depois humano;
 * 4. `bloqueado` (não dá para avaliar) ou `recomendacao: escalar` → humano;
 * 5. aprovado ∧ 0 bloqueantes ∧ CA ok ∧ não pede retrabalho → `relatando`
 *    (o nível ⚙ de verificação é informação, não bloqueia — FJ-032);
 * 6. senão retrabalho: pingue-pongue → humano; dentro dos limites →
 *    `implementando`; fora → humano ("não convergiu").
 */
export function decidirAposVeredito(e: EntradaDecisaoVeredito): DecisaoVeredito {
  const v = e.veredito;
  if (!e.head_igual_sha_verificado || !e.worktree_limpa) {
    return precisaHumano(
      'regra_conteudo_violada',
      'a revisão alterou a worktree (o T2 é só leitura)',
    );
  }
  if (!e.validacao.valido) {
    return e.repeticoes_invalido < MAX_REPETICOES_T2
      ? { acao: 'repetir_t2', motivo_invalido: e.validacao.motivo_invalido ?? 'veredito inválido' }
      : precisaHumano(
          'regra_conteudo_violada',
          `veredito inválido de novo: ${e.validacao.motivo_invalido ?? ''}`.trim(),
        );
  }
  const recusa = decidirRecusa(e.validacao.erros, e.recusas_feitas);
  if (recusa.acao === 'recusar') return { acao: 'recusar', erros: recusa.erros };
  if (recusa.acao === 'precisa_humano') {
    return precisaHumano(recusa.motivo, recusa.erros.join('; '));
  }

  const decisao = e.validacao.decisao_efetiva;
  const incoerencias = [...e.validacao.incoerencias];
  // FJ-035 (pedido do usuário: "é só implementar"): revisor que NÃO CONSEGUIU
  // avaliar (`bloqueado`) ou que pediu humano (`escalar`) não para o pipeline —
  // o relatório leva o motivo como aviso e o humano decide na aprovação, com
  // um clique, já vendo o diff. Caso real do #62: "sem .env não apliquei a
  // migration nem abri telas; falta um humano".
  if (decisao === 'bloqueado' || v.recomendacao === 'escalar') {
    return {
      acao: 'transicao',
      decisao: { para: 'relatando' },
      decisao_do_app: 'relatando',
      repetidos: [],
      incoerencias: [
        ...incoerencias,
        decisao === 'bloqueado'
          ? `revisão não conseguiu avaliar: ${v.motivo_recomendacao || 'sem motivo informado'}`
          : `revisão pediu um humano: ${v.motivo_recomendacao}`,
      ],
    };
  }

  const criteriosOk = v.criterios.every(
    (c) =>
      c.status === 'atendido' || (c.status === 'nao_verificavel' && c.evidencia.trim().length > 0),
  );
  const semBloqueantes = v.achados.every((a) => a.severidade !== 'bloqueante');
  if (decisao === 'aprovado' && semBloqueantes && criteriosOk && v.recomendacao !== 'retrabalhar') {
    return {
      acao: 'transicao',
      decisao: { para: 'relatando' },
      decisao_do_app: 'relatando',
      repetidos: [],
      incoerencias,
    };
  }

  const repetidos = achadosRepetidos(e.veredito_anterior, v).map((p) => p.atual);
  if (repetidos.length > 0) {
    return precisaHumano('pingue_pongue', `achado repetido entre ciclos: ${repetidos.join(', ')}`, {
      repetidos,
      incoerencias,
    });
  }
  const { ciclo_auto, ciclo_total } = e.contadores;
  if (ciclo_auto >= e.limites.max_auto) {
    return precisaHumano('ciclos_esgotados', 'revisão não convergiu', { incoerencias });
  }
  if (ciclo_total >= e.limites.max_total) {
    return precisaHumano('ciclos_esgotados', 'não está convergindo', { incoerencias });
  }
  return {
    acao: 'transicao',
    decisao: { para: 'implementando' },
    decisao_do_app: 'retrabalho',
    repetidos: [],
    incoerencias,
  };
}

// ---------------------------------------------------------------------------
// Outros limites de 03 §6
// ---------------------------------------------------------------------------

/** "Mais um ciclo" acima de `max_total` exige confirmação (03 §6). */
export function maisUmCicloExigeConfirmacao(
  contadores: Pick<ContadoresCiclo, 'ciclo_total'>,
  limites: Pick<LimitesCiclo, 'max_total'>,
): boolean {
  return contadores.ciclo_total >= limites.max_total;
}

/** Teto por chamado: com a soma das etapas ≥ teto, nenhuma etapa nova começa (03 §6). */
export function tetoPorChamadoAtingido(custoMicroUsd: number, tetoUsd: number): boolean {
  return custoMicroUsd >= Math.round(tetoUsd * 1_000_000);
}

/** 15 min sem evento = só aviso "possivelmente travado"; nunca kill (03 §6; 06 §4.2). */
export function semAtividade(
  ultimoEventoEm: string | null,
  agora: Date,
  avisoMinutos: number,
): boolean {
  if (!ultimoEventoEm) return false;
  const t = Date.parse(ultimoEventoEm);
  return Number.isFinite(t) && agora.getTime() - t >= avisoMinutos * 60_000;
}
