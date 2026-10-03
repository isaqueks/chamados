import type { Complexidade } from '@chamados/shared';
import type { EvidenciaVisual, GatePlano } from '../../comum/estados';
import type { PlanoV1 } from '../../comum/contratos';
import type { AvisoAprovacaoDto, PreCondicaoDto } from '../../comum/dto';
import { avaliarG0, type AvaliacaoG0, type EntradaG0 } from '../chamados/fila';
import type { DecisaoDestino } from './maquina-execucao';

/**
 * Gates humanos como regras puras (specs/forja/03 §4; 04 §6; 06 §4.3).
 *
 * O app decide QUANDO um humano precisa olhar; o humano decide O QUÊ. Aqui só
 * há a primeira metade: dado o plano/relatório/contexto, qual gate abre e o
 * que a aprovação exige. Gravar a `aprovacao` e mover o estado é do
 * orquestrador (via `proximoEstado`).
 */

// ---------------------------------------------------------------------------
// G0 — pré-condições (03 §4.1), reconferidas em `preparando`
// ---------------------------------------------------------------------------

export interface EntradaPreCondicoes extends EntradaG0 {
  /** `git rev-parse --verify refs/heads/<destino>` (ou remoto) ok. */
  branch_destino_existe: boolean;
}

/** O que fazer em `preparando` quando a releitura do chamado não passa. */
export type DecisaoPreparo =
  | { ok: true }
  | {
      ok: false;
      acao: 'precisa_humano';
      motivo: 'chamado_mudou_no_servidor';
      texto: string;
    }
  | { ok: false; acao: 'falhou'; motivo: 'setup_falhou'; texto: string }
  /** Transitório (conexão, CLI incompatível): nenhuma etapa nova começa; espera (03 §11). */
  | { ok: false; acao: 'aguardar'; texto: string };

export interface AvaliacaoPreCondicoes extends AvaliacaoG0 {
  branch_destino_ok: boolean;
  decisao_preparo: DecisaoPreparo;
}

const MOTIVO_PRE_CONDICAO: Partial<Record<PreCondicaoDto['codigo'], 'chamado_mudou_no_servidor'>> =
  {
    status: 'chamado_mudou_no_servidor',
    natureza: 'chamado_mudou_no_servidor',
    sistema_mapeado: 'chamado_mudou_no_servidor',
    sem_execucao_ativa: 'chamado_mudou_no_servidor',
  };

/**
 * Pré-condições do G0 — delega a `avaliarG0` (server/chamados/fila.ts, fonte
 * única das regras e dos textos) e acrescenta o que só o repositório sabe
 * (branch de destino existente, 03 §4.1; sem pré-condição de IA, FJ-031). Também traduz a falha para a ação
 * de `preparando`: chamado mudou → `precisa_humano`; branch sumiu →
 * `falhou` (Tentar de novo depois de corrigir); conexão/CLI → aguardar.
 *
 * Em `preparando`, `execucaoAtiva` deve EXCLUIR a própria execução.
 */
export function avaliarPreCondicoesG0(e: EntradaPreCondicoes): AvaliacaoPreCondicoes {
  const g0 = avaliarG0(e);
  const falhas = g0.pre_condicoes.filter((p) => !p.ok);
  let decisao: DecisaoPreparo = { ok: true };
  const humana = falhas.find((p) => MOTIVO_PRE_CONDICAO[p.codigo]);
  if (humana) {
    decisao = {
      ok: false,
      acao: 'precisa_humano',
      motivo: MOTIVO_PRE_CONDICAO[humana.codigo]!,
      texto: humana.motivo ?? humana.codigo,
    };
  } else if (!e.branch_destino_existe) {
    decisao = {
      ok: false,
      acao: 'falhou',
      motivo: 'setup_falhou',
      texto: 'A branch de destino não existe no repositório.',
    };
  } else if (falhas.length > 0) {
    decisao = {
      ok: false,
      acao: 'aguardar',
      texto: falhas.map((p) => p.motivo ?? p.codigo).join(' '),
    };
  }
  return {
    ...g0,
    implementavel: g0.implementavel && e.branch_destino_existe,
    branch_destino_ok: e.branch_destino_existe,
    decisao_preparo: decisao,
  };
}

// ---------------------------------------------------------------------------
// G1 / Gdec — depois do plano (03 §4, §2.4 linhas de `plano_pronto`; 04 §6)
// ---------------------------------------------------------------------------

export const MotivoG1 = {
  configuracao_sempre: 'configuracao_sempre',
  /** Legado (artefatos anteriores a FJ-033): o lote não força mais o G1. */
  em_lote: 'em_lote',
  confianca_nao_alta: 'confianca_nao_alta',
  altera_schema: 'altera_schema',
  complexidade_dificil: 'complexidade_dificil',
  alertas_seguranca: 'alertas_seguranca',
  sinais_heuristicos: 'sinais_heuristicos',
  trabalho_existente: 'trabalho_existente',
} as const;
export type MotivoG1 = (typeof MotivoG1)[keyof typeof MotivoG1];

export const TEXTO_MOTIVO_G1: Record<MotivoG1, string> = {
  configuracao_sempre: 'o projeto pede aprovação de todo plano',
  em_lote: 'execução em lote (mesa de planos)',
  confianca_nao_alta: 'confiança do planejador não é alta',
  altera_schema: 'o plano altera o schema do banco',
  complexidade_dificil: 'chamado classificado como difícil',
  alertas_seguranca: 'o planejador levantou alertas de segurança',
  sinais_heuristicos:
    'o texto do plano tem sinais de risco (rede, credencial, CI, redirecionamento…)',
  trabalho_existente: 'já existe branch/PR da IA do servidor para este chamado',
};

export interface ContextoG1 {
  /** `projeto.gates.plano` (do `config_snapshot`). */
  gate_plano: GatePlano;
  /** Informativo desde FJ-033: o lote segue a mesma regra por risco (não força G1). */
  em_lote: boolean;
  complexidade: Complexidade | null;
  /** `trabalho_existente` do G0 (branch/PR `ia/chamado-N-*`): força G1 (03 §4.1). */
  trabalho_existente: boolean;
}

export type ResultadoG1 = 'nao_implementavel' | 'aguardando_decisao' | 'gate' | 'sem_gate';

export interface AvaliacaoG1 {
  resultado: ResultadoG1;
  /** Pronto para `proximoEstado(…, { tipo: 'plano_avaliado', decisao })`. */
  decisao: DecisaoDestino;
  /** ⚙ `PlanoRegistrado.gate_g1`. */
  gate_g1: { exigido: boolean; motivos: MotivoG1[] };
  /** `alertas_seguranca`: faixa vermelha no G1, mesmo com `nunca` (04 §6). */
  faixa_vermelha: boolean;
  /** Acertos da heurística de 05 §6.1 (exibidos no G1). */
  sinais: string[];
  gdec: { exigido: boolean; perguntas: number; decisoes: number };
  /** ⚙ `PlanoRegistrado.avisos` (FJ-034). */
  avisos: string[];
}

/** Sem acento, minúsculo, sem espaço nas pontas — para casar marcadores como "sem suposição". */
function semAcento(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Teto de `plano.v1.suposicoes` (04 §5). */
const MAX_SUPOSICOES = 15;

/**
 * FJ-033 — "o planejador decide; suposições vão ao relatório". Normaliza o plano
 * ANTES do Gdec, independente do que o prompt conseguiu: toda pergunta ao
 * cliente com `suposicao_padrao` e toda decisão com `recomendacao` são
 * ASSUMIDAS (saem da lista e entram em `suposicoes`). Só ficam as que o modelo
 * marcou explicitamente com "sem suposição"/"sem recomendação" — essas param no
 * Gdec. Se `suposicoes` lotar (15), a pergunta/decisão excedente continua como
 * está (pergunta, não some). Pura: o chamador persiste o plano devolvido.
 */
export function assumirDecisoes<P extends PlanoV1>(plano: P): { plano: P; assumidas: string[] } {
  const suposicoes = [...(plano.suposicoes ?? [])];
  const assumidas: string[] = [];
  const cabe = () => suposicoes.length < MAX_SUPOSICOES;
  const perguntas = plano.perguntas_ao_cliente.filter((p) => {
    if (semAcento(p.suposicao_padrao).startsWith('sem suposicao') || !cabe()) return true;
    const texto = `Pergunta ao cliente não feita: ${p.pergunta} — assumido: ${p.suposicao_padrao}`;
    suposicoes.push(texto);
    assumidas.push(texto);
    return false;
  });
  const decisoes = plano.decisoes_do_operador.filter((d) => {
    if (semAcento(d.recomendacao).startsWith('sem recomendacao') || !cabe()) return true;
    const texto = `Decisão: ${d.questao} — adotado: ${d.recomendacao}`;
    suposicoes.push(texto);
    assumidas.push(texto);
    return false;
  });
  if (assumidas.length === 0 && plano.suposicoes !== undefined) return { plano, assumidas };
  return {
    plano: {
      ...plano,
      suposicoes,
      perguntas_ao_cliente: perguntas,
      decisoes_do_operador: decisoes,
    },
    assumidas,
  };
}

/**
 * Gdec: perguntas ao cliente ou decisões do operador → "nunca implementa" (04 §6).
 * Desde FJ-033 recebe o plano já passado por `assumirDecisoes`: só sobra o que o
 * planejador marcou como "sem suposição"/"sem recomendação".
 */
export function avaliarGdec(plano: Pick<PlanoV1, 'perguntas_ao_cliente' | 'decisoes_do_operador'>) {
  const perguntas = plano.perguntas_ao_cliente.length;
  const decisoes = plano.decisoes_do_operador.length;
  return { exigido: perguntas + decisoes > 0, perguntas, decisoes };
}

/**
 * Sinais heuristicos do texto do plano (05 §6.1): o app NÃO confia só na
 * autoavaliação do planejador — o papel exposto à injeção. Heurística barata,
 * não garantia: em `por_risco`/`sempre` qualquer acerto força G1; em `nunca`
 * (padrão desde FJ-034) vira aviso no plano registrado.
 */
const SINAIS_PLANO: readonly { sinal: string; regex: RegExp }[] = [
  {
    sinal: 'URL ou domínio externo',
    regex: /\b(?:https?|ftp|wss?):\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$))[^\s"'`)]+/i,
  },
  { sinal: 'caminho sob ~ ou /etc', regex: /(?:^|[\s"'`(=])(?:~\/|\$HOME\/|\/etc\/|\/root\/)/m },
  {
    sinal: 'ferramenta de rede (curl/wget/nc/ssh/scp)',
    regex: /\b(?:curl|wget|netcat|nc|ssh|scp)\b/i,
  },
  { sinal: 'base64', regex: /\bbase64\b|\batob\s*\(|\bbtoa\s*\(/i },
  { sinal: 'eval', regex: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  {
    sinal: 'credencial, token ou chave',
    regex:
      /\b(?:credenciai?s?|credentials?|tokens?|senhas?|passwords?|secrets?|segredos?|api[_ -]?keys?|chaves? (?:de api|de acesso|privadas?|ssh))\b/i,
  },
  {
    sinal: 'CI, hooks ou scripts de instalação',
    regex:
      /\.github\/workflows|\.gitlab-ci|\.circleci|jenkinsfile|\.husky|\.git\/hooks|pre-commit|\b(?:post|pre)install\b|package\.json[^\n]{0,40}scripts|\.claude\//i,
  },
  {
    sinal: 'frase de redirecionamento',
    regex:
      /\bignor(?:e|ar|a)\b[^\n]{0,40}\b(?:instru|previous|anteriores|acima|above)|instruções anteriores|previous instructions|disregard|system prompt|prompt do sistema/i,
  },
];

/** Sinais encontrados no texto serializado do plano (resumo, passos, arquivos, critérios…). */
export function sinaisPlano(plano: PlanoV1): string[] {
  const texto = JSON.stringify(plano);
  return SINAIS_PLANO.filter((s) => s.regex.test(texto)).map((s) => s.sinal);
}

/** Áreas do plano que exigem a lente de segurança no T2 (04 §4.6). */
const AREAS_SEGURANCA = ['autenticacao', 'permissoes', 'config', 'build', 'integracao'] as const;

/**
 * Gatilho de `revisao_seguranca: obrigatoria` (04 §4.6 ⚙): selo `sensivel`,
 * `alertas_seguranca` no plano, áreas sensíveis ou dependência nova pelo diff
 * do lockfile. O MESMO valor vai ao prompt do T2 e ao `validarVeredito`.
 */
export function revisaoSegurancaObrigatoria(e: {
  sensiveis: readonly string[];
  dependencias_novas: readonly string[];
  plano: Pick<PlanoV1, 'alertas_seguranca' | 'areas'> | null;
}): boolean {
  return (
    e.sensiveis.length > 0 ||
    e.dependencias_novas.length > 0 ||
    (e.plano?.alertas_seguranca.length ?? 0) > 0 ||
    (e.plano?.areas ?? []).some((a) => (AREAS_SEGURANCA as readonly string[]).includes(a))
  );
}

/**
 * Motivos de G1 (03 §4). Lote não é motivo desde FJ-033. FJ-034 (default
 * `nunca`): em `nunca` SÓ `alertas_seguranca` para; sinais heurísticos,
 * confiança, schema, `dificil` e trabalho existente viram avisos (`avisosPlano`).
 * Em `por_risco`/`sempre` o comportamento anterior continua.
 */
export function motivosG1(plano: PlanoV1, ctx: ContextoG1): MotivoG1[] {
  const m: MotivoG1[] = [];
  if (ctx.gate_plano === 'sempre') m.push('configuracao_sempre');
  if (ctx.gate_plano !== 'nunca') {
    if (plano.confianca !== 'alta') m.push('confianca_nao_alta');
    if (plano.schema_banco.altera) m.push('altera_schema');
    if (ctx.complexidade === 'dificil') m.push('complexidade_dificil');
  }
  if (plano.alertas_seguranca.length > 0) m.push('alertas_seguranca');
  if (ctx.gate_plano !== 'nunca') {
    if (sinaisPlano(plano).length > 0) m.push('sinais_heuristicos');
    if (ctx.trabalho_existente) m.push('trabalho_existente');
  }
  return m;
}

/**
 * ⚙ `plano.avisos` (FJ-034): os riscos do plano em texto, carregados até a
 * Aprovação. Calculados em qualquer modo de gate (informativos); em `nunca`
 * são a única marca desses riscos, porque não param nada.
 */
export function avisosPlano(plano: PlanoV1, ctx: ContextoG1): string[] {
  const avisos: string[] = [];
  const sinais = sinaisPlano(plano);
  if (sinais.length > 0) avisos.push(`O plano tem sinais de risco: ${sinais.join(', ')}.`);
  if (plano.confianca !== 'alta') {
    avisos.push(`Confiança do planejador ${plano.confianca === 'media' ? 'média' : 'baixa'}.`);
  }
  if (plano.schema_banco.altera) avisos.push('O plano altera o schema do banco.');
  if (ctx.complexidade === 'dificil') avisos.push('Chamado classificado como difícil.');
  if (ctx.trabalho_existente) {
    avisos.push('Já existe branch/PR da IA do servidor para este chamado.');
  }
  return avisos;
}

/**
 * Decisão de `plano_pronto` na ordem da tabela 03 §2.4: não implementável →
 * `precisa_humano`; perguntas/decisões → Gdec (precede G1); regra G1 →
 * `aguardando_plano`; senão `implementando`. Espera um plano JÁ validado
 * (`validarPlano` sem erros).
 */
export function avaliarG1(plano: PlanoV1, ctx: ContextoG1): AvaliacaoG1 {
  const motivos = motivosG1(plano, ctx);
  const gate_g1 = { exigido: motivos.length > 0, motivos };
  const gdec = avaliarGdec(plano);
  const faixa_vermelha = plano.alertas_seguranca.length > 0;
  const sinais = sinaisPlano(plano);
  const avisos = avisosPlano(plano, ctx);
  if (plano.natureza_confirmada === 'nao_implementavel') {
    return {
      resultado: 'nao_implementavel',
      decisao: {
        para: 'precisa_humano',
        motivo: 'nao_implementavel',
        texto: plano.motivo_nao_implementavel,
      },
      gate_g1,
      faixa_vermelha,
      sinais,
      gdec,
      avisos,
    };
  }
  if (gdec.exigido) {
    return {
      resultado: 'aguardando_decisao',
      decisao: { para: 'aguardando_decisao' },
      gate_g1,
      faixa_vermelha,
      sinais,
      gdec,
      avisos,
    };
  }
  return gate_g1.exigido
    ? {
        resultado: 'gate',
        decisao: { para: 'aguardando_plano' },
        gate_g1,
        faixa_vermelha,
        sinais,
        gdec,
        avisos,
      }
    : {
        resultado: 'sem_gate',
        decisao: { para: 'implementando' },
        gate_g1,
        faixa_vermelha,
        sinais,
        gdec,
        avisos,
      };
}

// ---------------------------------------------------------------------------
// G2 / G2' — aprovação final (03 §2.4 linha de `aguardando_aprovacao`, §4; 06 §4.3)
// ---------------------------------------------------------------------------

/** Evidência visual incompleta (FJ-026): vira aviso no G2 (FJ-034), nunca exigência. */
export function evidenciaIncompleta(ev: EvidenciaVisual | null): boolean {
  return ev === 'parcial' || ev === 'sem_evidencia_visual';
}

export interface ContextoG2 {
  /** Versão N do relatório apresentada e o que ela amarra. */
  relatorio: { artefato_id: string; versao: number; patch_id: string; sha: string };
  altera_ui: boolean;
  evidencia_visual: EvidenciaVisual | null;
  /** Motivo do agente/app para prints incompletos (texto do aviso). */
  evidencia_visual_motivo?: string | null;
  /** Arquivos do diff com selo (banco/regra/sensível/frontend): destaque no Diff. */
  arquivos_selo: readonly string[];
  /** Arquivos sensíveis tocados (selo `sensivel`). */
  sensiveis?: readonly string[];
  /** Última mensagem pública NOVA do cliente desde o início da execução (null = nenhuma). */
  mensagem_nova_cliente_id: string | null;
  achados_em_aberto: number;
  /** G2': já houve aprovação e o `patch-id` mudou depois. */
  reaprovacao: boolean;
  /** Arquivos em conflito com a ponta do destino (pré-checagem; vazio = sem conflito previsto). */
  conflito_arquivos?: readonly string[];
  /** `relatorio.incoerencias` (validação cruzada que seguiu com aviso, FJ-034). */
  incoerencias?: readonly string[];
  /** `plano.avisos` ⚙ (riscos que não pararam no G1, FJ-034). */
  avisos_plano?: readonly string[];
}

/**
 * Avisos do G2 (FJ-034, 2026-10-03 — "dois cliques"): tudo o que antes era
 * exigência (ler a mensagem nova, prints, achados, abrir Diff/Evidências,
 * confirmar o patch-id) vira AVISO visível acima do botão. Nenhum bloqueia:
 * "Aprovar e mergear" fica sempre habilitado em `aguardando_aprovacao`.
 */
export function avisosG2(ctx: ContextoG2): AvisoAprovacaoDto[] {
  const avisos: AvisoAprovacaoDto[] = [];
  if (ctx.mensagem_nova_cliente_id !== null) {
    avisos.push({
      tipo: 'mensagem_nova_cliente',
      mensagem: 'O cliente escreveu depois do início da implementação (veja acima).',
    });
  }
  if ((ctx.incoerencias ?? []).length > 0) {
    avisos.push({
      tipo: 'relatorio_contradiz',
      mensagem: `O relatório diverge do diff em ${ctx.incoerencias!.length} ponto(s): confira o Diff.`,
    });
  }
  if (ctx.altera_ui && evidenciaIncompleta(ctx.evidencia_visual)) {
    avisos.push({
      tipo: 'sem_prints',
      mensagem: `A interface muda e os prints estão incompletos${ctx.evidencia_visual_motivo ? `: ${ctx.evidencia_visual_motivo}` : ''}.`,
    });
  }
  if (ctx.achados_em_aberto > 0) {
    avisos.push({
      tipo: 'achados_abertos',
      mensagem: `${ctx.achados_em_aberto} ${ctx.achados_em_aberto === 1 ? 'achado' : 'achados'} da revisão em aberto.`,
    });
  }
  const conflito = ctx.conflito_arquivos ?? [];
  if (conflito.length > 0) {
    avisos.push({
      tipo: 'conflito_previsto',
      mensagem: `Conflito previsto com o destino em ${conflito.join(', ')}: na fila de merge vira "precisa de você".`,
    });
  }
  const sensiveis = ctx.sensiveis ?? [];
  if (sensiveis.length > 0) {
    avisos.push({
      tipo: 'arquivos_sensiveis',
      mensagem: `Mexe em arquivo sensível: ${sensiveis.join(', ')}.`,
    });
  }
  for (const aviso of ctx.avisos_plano ?? []) avisos.push({ tipo: 'plano', mensagem: aviso });
  if (ctx.reaprovacao) {
    avisos.push({
      tipo: 'reaprovacao',
      mensagem: 'O patch mudou depois da aprovação anterior: o Interdiff mostra o que mudou.',
    });
  }
  avisos.push({
    tipo: 'patch',
    mensagem: `patch ${ctx.relatorio.patch_id.slice(0, 6) || '—'} (versão ${ctx.relatorio.versao})`,
  });
  return avisos;
}

/** Pedido de aprovação como chega do `AprovarDto`, já com a decisão de publicação. */
export interface PedidoG2 {
  relatorio_artefato_id: string;
  patch_id: string;
  sha: string;
  /** Última mensagem nova do cliente que a tela mostrava (null = nenhuma). */
  ciente_mensagem_id: string | null;
  /** `avaliarPublicacao(validarRespostaPublica(texto, tipo), publicarMesmoAssim)` (04 §8.4). */
  publicacao: { permitido: boolean; motivos_nao_confirmados: readonly string[] };
}

/**
 * Erros do G2. Desde FJ-034 só existem os de DADO VELHO (a tela aprovaria
 * outra coisa que não a mostrada) e a resposta pública inválida (F-16) —
 * nenhum por exigência de processo.
 */
export const CodigoErroG2 = {
  relatorio_desatualizado: 'relatorio_desatualizado',
  patch_id_divergente: 'patch_id_divergente',
  sha_divergente: 'sha_divergente',
  mensagem_nova_depois: 'mensagem_nova_depois',
  resposta_invalida: 'resposta_invalida',
} as const;
export type CodigoErroG2 = (typeof CodigoErroG2)[keyof typeof CodigoErroG2];

export interface AvaliacaoG2 {
  ok: boolean;
  erros: { codigo: CodigoErroG2; mensagem: string }[];
  /** `aprovacao.tipo` a gravar. */
  tipo: 'final' | 'reaprovacao';
  /**
   * `aprovacao.aprovado_sem_prints` (auditoria, FJ-034): o FATO de ter aprovado
   * com a interface mudando e prints incompletos — não depende de checkbox.
   */
  aprovado_sem_prints: boolean;
  /** Mensagem nova que a aprovação dá por vista (`ultima_mensagem_ciente_id`). */
  ciente_mensagem_id: string | null;
  avisos: AvisoAprovacaoDto[];
}

/**
 * Confere no SERVIDOR o G2 (05 §7.1: ação destrutiva). FJ-034: nunca recusa por
 * exigência; recusa só se a tela estava velha (relatório, patch, sha ou uma
 * mensagem do cliente chegou depois de abrir) ou a resposta tem violação não
 * confirmada.
 */
export function avaliarG2(ctx: ContextoG2, pedido: PedidoG2): AvaliacaoG2 {
  const erros: AvaliacaoG2['erros'] = [];
  if (pedido.relatorio_artefato_id !== ctx.relatorio.artefato_id) {
    erros.push({
      codigo: 'relatorio_desatualizado',
      mensagem: 'Há uma versão mais nova do relatório: reabra a aprovação.',
    });
  }
  if (pedido.patch_id !== ctx.relatorio.patch_id) {
    erros.push({
      codigo: 'patch_id_divergente',
      mensagem: 'O patch mudou desde que a tela abriu (a aprovação vale só para o patch-id visto).',
    });
  }
  if (pedido.sha !== ctx.relatorio.sha) {
    erros.push({ codigo: 'sha_divergente', mensagem: 'O commit mudou desde que a tela abriu.' });
  }
  if (
    ctx.mensagem_nova_cliente_id !== null &&
    pedido.ciente_mensagem_id !== ctx.mensagem_nova_cliente_id
  ) {
    erros.push({
      codigo: 'mensagem_nova_depois',
      mensagem: 'O cliente escreveu enquanto a tela estava aberta: a aprovação foi recarregada.',
    });
  }
  if (!pedido.publicacao.permitido) {
    erros.push({
      codigo: 'resposta_invalida',
      mensagem: `A resposta ao cliente tem violações não confirmadas: ${pedido.publicacao.motivos_nao_confirmados.join(', ')}.`,
    });
  }
  return {
    ok: erros.length === 0,
    erros,
    tipo: ctx.reaprovacao ? 'reaprovacao' : 'final',
    aprovado_sem_prints: ctx.altera_ui && evidenciaIncompleta(ctx.evidencia_visual),
    ciente_mensagem_id: ctx.mensagem_nova_cliente_id,
    avisos: avisosG2(ctx),
  };
}

/**
 * G2': a aprovação vale só para o `patch-id` aprovado (03 §2.5). Igualdade
 * estrita — o `patch-id --stable` já é insensível a linha/contexto [NV S9].
 */
export function exigeReaprovacao(patchAprovado: string, patchIntegrado: string): boolean {
  return patchAprovado.trim() !== patchIntegrado.trim();
}

// ---------------------------------------------------------------------------
// Gdeploy (03 §4, §9.4)
// ---------------------------------------------------------------------------

/** "Publicado em produção" aceita vários chamados: só os que estão em `aguardando_deploy`. */
export function elegiveisGdeploy<T extends { id: string; estado: string }>(
  execucoes: readonly T[],
  selecionados: readonly string[],
): { aceitos: string[]; recusados: string[] } {
  const em = new Set(execucoes.filter((x) => x.estado === 'aguardando_deploy').map((x) => x.id));
  const unicos = [...new Set(selecionados)];
  return {
    aceitos: unicos.filter((id) => em.has(id)),
    recusados: unicos.filter((id) => !em.has(id)),
  };
}
