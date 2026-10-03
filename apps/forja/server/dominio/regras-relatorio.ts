import type { RelatorioV1, RespostaV1, Selos, ValidacaoResposta } from '../../comum/contratos';
import type { EvidenciaVisual, NivelVerificacao, PoliticaStatus } from '../../comum/estados';
import { MAX_RECUSAS_CONTEUDO, MAX_REGENERACOES_RELATORIO } from './ciclos';
import type { DecisaoDestino } from './maquina-execucao';
import { normalizarComparacao } from './texto';

/**
 * Validação do `relatorio.v1` (specs/forja/04 §6 linhas de `relatorio.v1`,
 * §7.2 cruzamento com os selos, §8.2 tipo da resposta; FJ-026).
 *
 * "O relatório é o produto" (F-12): o que o modelo DECLARA é confrontado com
 * o que o app MEDIU (selos dos globs, nível de verificação, prints). Três
 * consequências distintas:
 * - `recusas` (forma/coerência interna) → 1 recusa com instrução, depois
 *   `precisa_humano` (`regra_conteudo_violada`);
 * - `incoerencias` (contradiz os fatos do app) → 1 regeração, depois segue ao G2
 *   com AVISO "o relatório diverge do diff" (FJ-034; antes ia a `precisa_humano`
 *   `relatorio_incoerente`, motivo que fica no enum só para linhas antigas);
 * - `incoerencias_resposta` (tipo/linguagem da resposta) → 1 regeração; se
 *   persistir NÃO vai a humano: segue ao G2 marcada para edição (04 §6).
 * `avisos` (amarelo) e `alertas_g2` (vermelho, não bloqueiam) vão para a tela.
 */

/** Selos completos do diff (04 §7.1): o zod de `comum` + `dependencias_novas` do git. */
export interface SelosRelatorio extends Selos {
  dependencias_novas: readonly string[];
}

export interface FatosRelatorio {
  selos: SelosRelatorio;
  /** `plano.schema_banco.altera` da versão oficial. */
  plano_altera_schema: boolean;
  /** CA do plano oficial. */
  ids_criterios: readonly string[];
  nivel_verificacao: NivelVerificacao;
  /**
   * Algum comando e2e relatado pela revisão e visto no stream com exit 0
   * (FJ-032). Só então o texto pode falar em teste ponta a ponta.
   */
  e2e_confirmado?: boolean;
  evidencia_visual: EvidenciaVisual;
  /** Telas dos fatos do app (plano ∪ resumo_impl) — ids aceitos em `telas[].tela_id`. */
  telas_fatos: readonly string[];
  /** Telas com par antes/depois (ou `tela_nova` + depois) no `sha_verificado`. */
  telas_fotografadas: readonly string[];
  /** Refs válidas listadas no prompt do T3 (`artefato:<id>`; sem `log:` desde FJ-032). */
  refs_validas: readonly string[];
  /** Versão que este relatório terá (1, 2, …). */
  versao: number;
  /** `tipoRespostaExigido(...)`. */
  tipo_resposta: RespostaV1['tipo'];
  /** `validarRespostaPublica(corpo, tipo_resposta)` (server/chamados). */
  validacao_resposta: Pick<ValidacaoResposta, 'ok'> & { motivos?: readonly { chave: string }[] };
}

export type CodigoAviso =
  'banco_declarado_nao_detectado' | 'ui_declarada_nao_detectada' | 'evidencia_visual_incompleta';
export type CodigoAlertaG2 = 'schema_fora_do_plano' | 'docs_exigidas';

export interface AvaliacaoRelatorio {
  recusas: string[];
  incoerencias: string[];
  incoerencias_resposta: string[];
  avisos: { codigo: CodigoAviso; mensagem: string }[];
  alertas_g2: { codigo: CodigoAlertaG2; mensagem: string }[];
}

/** Prefixo exigido na declaração quando a captura foi impossível (04 §7.2). */
export const PREFIXO_SEM_PRINTS = 'alteração de interface sem prints:';

/** Texto que o relatório deve trazer (o prompt do T3 recebe pronto). */
export function declaracaoSemPrints(motivo: string): string {
  return `${PREFIXO_SEM_PRINTS} ${motivo}`;
}

function declaraSemPrints(declaracao: string): boolean {
  const d = normalizarComparacao(declaracao);
  const p = normalizarComparacao(PREFIXO_SEM_PRINTS);
  const i = d.indexOf(p);
  return i >= 0 && d.slice(i + p.length).trim().length > 0;
}

/** Léxico de "testado ponta a ponta" (04 §6), com fronteira Unicode. */
const LEXICO_E2E =
  /(?<![\p{L}\p{N}_])(ponta a ponta|e2e|end[- ]to[- ]end|testad[oa]s? no navegador)(?![\p{L}\p{N}_])/giu;
/** Negação logo antes ("não testado ponta a ponta" é a frase CORRETA sem e2e, U-7). */
const NEGACAO = /(?<![\p{L}\p{N}_])(nao|sem|nunca|nenhum|nenhuma)(?![\p{L}\p{N}_])/u;

/** O texto afirma teste ponta a ponta? (ignora ocorrências negadas nas ~4 palavras anteriores). */
export function afirmaE2e(texto: string): boolean {
  const t = normalizarComparacao(texto);
  for (const m of t.matchAll(LEXICO_E2E)) {
    const antes = t.slice(0, m.index).split(' ').slice(-5).join(' ');
    if (!NEGACAO.test(antes)) return true;
  }
  return false;
}

function textosDeclarativos(r: RelatorioV1): string[] {
  return [
    r.titulo,
    r.resumo,
    ...r.o_que_muda_para_quem_usa,
    r.regras_de_negocio_alteradas.declaracao,
    r.alteracoes_no_schema_do_banco.declaracao,
    r.alteracoes_de_interface.declaracao,
    ...r.alteracoes_de_interface.telas.map((t) => t.o_que_mudou_para_quem_usa),
    ...(r.mudou_desde_a_ultima_versao ?? []),
    r.resposta_ao_cliente.corpo_markdown,
  ];
}

/** O pacote aparece (palavra inteira, sem caixa) em alguma linha de `dependencias_novas`? */
function dependenciaDeclarada(pacote: string, linhas: readonly string[]): boolean {
  const p = pacote.toLowerCase();
  return linhas.some((l) => {
    const t = l.toLowerCase();
    let i = t.indexOf(p);
    while (i >= 0) {
      const antes = t[i - 1];
      const depois = t[i + p.length];
      const borda = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}_@/.-]/u.test(c);
      if (borda(antes) && borda(depois)) return true;
      i = t.indexOf(p, i + 1);
    }
    return false;
  });
}

function secaoObrigatoria(
  nome: string,
  secao: { houve: boolean; itens: readonly unknown[] },
  recusas: string[],
): void {
  if (secao.houve && secao.itens.length === 0) recusas.push(`${nome}: houve = true sem itens`);
  if (!secao.houve && secao.itens.length > 0) recusas.push(`${nome}: houve = false com itens`);
}

export function avaliarRelatorio(r: RelatorioV1, f: FatosRelatorio): AvaliacaoRelatorio {
  const recusas: string[] = [];
  const incoerencias: string[] = [];
  const incoerencias_resposta: string[] = [];
  const avisos: AvaliacaoRelatorio['avisos'] = [];
  const alertas_g2: AvaliacaoRelatorio['alertas_g2'] = [];
  const s = f.selos;
  const ui = r.alteracoes_de_interface;
  const incompleta =
    f.evidencia_visual === 'parcial' || f.evidencia_visual === 'sem_evidencia_visual';

  // --- seções obrigatórias (04 §6) ---------------------------------------------
  secaoObrigatoria('regras_de_negocio_alteradas', r.regras_de_negocio_alteradas, recusas);
  secaoObrigatoria('alteracoes_no_schema_do_banco', r.alteracoes_no_schema_do_banco, recusas);
  if (!ui.houve && ui.telas.length > 0)
    recusas.push('alteracoes_de_interface: houve = false com telas');
  if (ui.houve && ui.telas.length === 0) {
    const vazioPermitido =
      f.evidencia_visual === 'sem_evidencia_visual' && f.telas_fatos.length === 0;
    if (!vazioPermitido) recusas.push('alteracoes_de_interface: houve = true sem telas');
  }
  const idsTelas = ui.telas.map((t) => t.tela_id);
  for (const id of idsTelas) {
    if (!f.telas_fatos.includes(id))
      recusas.push(`alteracoes_de_interface: tela ${id} não está nos fatos do app`);
  }
  if (new Set(idsTelas).size !== idsTelas.length)
    recusas.push('alteracoes_de_interface: tela repetida');

  const cenarios = r.como_foi_testado.cenarios.map((c) => c.criterio);
  for (const id of f.ids_criterios) {
    if (!cenarios.includes(id)) recusas.push(`como_foi_testado: critério ${id} sem cenário`);
  }
  for (const id of cenarios) {
    if (!f.ids_criterios.includes(id))
      recusas.push(`como_foi_testado: critério ${id} não existe no plano`);
  }
  const refs = new Set(f.refs_validas);
  for (const c of r.como_foi_testado.cenarios) {
    if (c.resultado === 'ok' && (c.evidencia_ref === null || !refs.has(c.evidencia_ref))) {
      recusas.push(`como_foi_testado: ${c.criterio} "ok" exige evidencia_ref válida`);
    }
  }
  if (
    f.versao >= 2 &&
    (!r.mudou_desde_a_ultima_versao || r.mudou_desde_a_ultima_versao.length === 0)
  ) {
    recusas.push('versão 2 em diante exige mudou_desde_a_ultima_versao');
  }

  // --- nível × texto (04 §6) -------------------------------------------------------
  // Linhas anteriores a FJ-032 ainda trazem os níveis e2e calculados pelo app.
  const e2eReal =
    f.e2e_confirmado === true ||
    f.nivel_verificacao === 'e2e_automatizado' ||
    f.nivel_verificacao === 'e2e_roteiro';
  if (!e2eReal && textosDeclarativos(r).some(afirmaE2e)) {
    incoerencias.push(
      'o texto afirma teste ponta a ponta, mas nenhum e2e foi relatado e visto no stream da revisão',
    );
  }

  // --- selos × relatório (04 §7.2) -----------------------------------------------
  if (s.altera_banco && !r.alteracoes_no_schema_do_banco.houve) {
    incoerencias.push('o diff altera o banco e o relatório diz que não há alteração no schema');
  }
  if (!s.altera_banco && r.alteracoes_no_schema_do_banco.houve) {
    avisos.push({
      codigo: 'banco_declarado_nao_detectado',
      mensagem: 'alteração de banco declarada pelo modelo, não detectada pelos globs',
    });
  }
  if (s.altera_regra_negocio && !r.regras_de_negocio_alteradas.houve) {
    incoerencias.push('o diff altera regra de negócio e o relatório diz que não');
  }
  const faltando = s.dependencias_novas.filter(
    (d) => !dependenciaDeclarada(d, r.dependencias_novas),
  );
  if (faltando.length > 0) {
    incoerencias.push(`dependências novas ausentes do relatório: ${faltando.join(', ')}`);
  }
  if (s.altera_banco && !f.plano_altera_schema) {
    alertas_g2.push({ codigo: 'schema_fora_do_plano', mensagem: 'schema fora do plano' });
  }
  if (s.docs_exigidas_ok === false) {
    alertas_g2.push({ codigo: 'docs_exigidas', mensagem: 'documentação exigida não foi tocada' });
  }

  // --- interface (FJ-026) ----------------------------------------------------------
  if (s.altera_ui && f.evidencia_visual === 'completa') {
    if (!ui.houve)
      incoerencias.push('telas fotografadas, mas o relatório diz que a interface não mudou');
    const ausentes = f.telas_fotografadas.filter((t) => !idsTelas.includes(t));
    if (ui.houve && ausentes.length > 0) {
      incoerencias.push(`telas fotografadas ausentes do relatório: ${ausentes.join(', ')}`);
    }
  }
  if (s.altera_ui && incompleta) {
    if (!declaraSemPrints(ui.declaracao)) {
      incoerencias.push(`a declaração de interface deve trazer "${PREFIXO_SEM_PRINTS} <motivo>"`);
    }
    avisos.push({
      codigo: 'evidencia_visual_incompleta',
      mensagem: 'alteração de interface sem prints completos (faixa amarela no G2)',
    });
  }
  if (!s.altera_ui && ui.houve) {
    avisos.push({
      codigo: 'ui_declarada_nao_detectada',
      mensagem: 'alteração de interface declarada pelo modelo, não detectada (sem prints)',
    });
  }

  // --- resposta ao cliente (04 §6, §8.2) -------------------------------------------
  if (r.resposta_ao_cliente.tipo !== f.tipo_resposta) {
    incoerencias_resposta.push(
      `resposta_ao_cliente.tipo "${r.resposta_ao_cliente.tipo}" ≠ exigido "${f.tipo_resposta}"`,
    );
  }
  if (!f.validacao_resposta.ok) {
    const chaves = (f.validacao_resposta.motivos ?? []).map((m) => m.chave);
    incoerencias_resposta.push(
      `a resposta ao cliente não passou no validador de linguagem${chaves.length ? `: ${chaves.join(', ')}` : ''}`,
    );
  }

  return { recusas, incoerencias, incoerencias_resposta, avisos, alertas_g2 };
}

// ---------------------------------------------------------------------------
// Decisão: recusar, regerar, alertar ou seguir (04 §6, §7.2; 03 §2.4, §6)
// ---------------------------------------------------------------------------

export type DecisaoRelatorio =
  | { acao: 'recusar'; erros: string[] }
  | { acao: 'regerar'; apontamentos: string[] }
  | {
      acao: 'transicao';
      decisao: DecisaoDestino;
      /** Resposta segue ao G2 marcada para edição (violação persistente da resposta). */
      resposta_marcada_para_g2: boolean;
      /** ⚙ `RelatorioRegistrado.incoerencias`. */
      incoerencias: string[];
    };

export function decidirRelatorio(
  a: AvaliacaoRelatorio,
  contadores: { recusas_feitas: number; regeneracoes_feitas: number },
): DecisaoRelatorio {
  if (a.recusas.length > 0) {
    return contadores.recusas_feitas < MAX_RECUSAS_CONTEUDO
      ? { acao: 'recusar', erros: [...a.recusas] }
      : {
          acao: 'transicao',
          decisao: {
            para: 'precisa_humano',
            motivo: 'regra_conteudo_violada',
            texto: a.recusas.join('; '),
          },
          resposta_marcada_para_g2: false,
          incoerencias: [...a.incoerencias, ...a.incoerencias_resposta],
        };
  }
  const podeRegerar = contadores.regeneracoes_feitas < MAX_REGENERACOES_RELATORIO;
  const todas = [...a.incoerencias, ...a.incoerencias_resposta];
  if (todas.length > 0 && podeRegerar) return { acao: 'regerar', apontamentos: todas };
  // FJ-034: depois da regeração, a validação cruzada vira AVISO no G2 (as
  // incoerências vão em `RelatorioRegistrado.incoerencias`), nunca `precisa_humano`.
  return {
    acao: 'transicao',
    decisao: { para: 'aguardando_aprovacao' },
    resposta_marcada_para_g2: a.incoerencias_resposta.length > 0,
    incoerencias: todas,
  };
}

// ---------------------------------------------------------------------------
// `tipo` da resposta exigido pelo app (04 §8.2)
// ---------------------------------------------------------------------------

export function tipoRespostaExigido(entrada: {
  momento: 'gdec' | 'conclusao';
  merge_publica: boolean;
  ao_concluir: PoliticaStatus;
}): RespostaV1['tipo'] {
  if (entrada.momento === 'gdec') return 'pergunta';
  return entrada.merge_publica || entrada.ao_concluir === 'aguardar_deploy'
    ? 'disponivel'
    : 'aguardando_publicacao';
}
