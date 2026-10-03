import { ehTerminal, type StatusChamado } from '@chamados/shared';
import {
  ErroApi,
  ErroRede,
  type MensagemChamado,
  type RespostaDetalheChamado,
} from '@chamados/cliente-api';
import type { MotivoEstado, PassoOutbox } from '../../comum/estados';
import { calcularCadeia, type AlvoCadeia } from './cadeia-status';
import { ErroConexaoIndisponivel, ErroSemSenha, type EstadoSessao } from './conexao';
import { detectarSegredos, type AchadoSegredo } from './detector-segredos';
import { normalizarCorpo, PREFIXO_COMPARACAO } from './normalizacao';
import { contemMarcador, LIMITE_CORPO_API, type MomentoMarcador } from './notas';
import type { IdentidadeForja, OperacoesChamados } from './tipos';
import {
  avaliarPublicacao,
  validarRespostaPublica,
  type ResultadoValidacaoLinguagem,
  type TipoResposta,
} from './validador-linguagem';

/**
 * Execução de CADA passo do outbox contra a API do Chamados (specs/forja/03
 * §9; 07 §3, §9, §2.4). A máquina do outbox (estados `pendente → enviando →
 * enviado|pulado|bloqueado`, rodadas, backoff, reconciliação no boot) é da R3:
 * ela chama `executarPasso` e grava o resultado tipado.
 *
 * Três regras valem para todos os passos:
 *  1. LER ANTES DE ESCREVER: todo passo começa com `GET` do detalhe em
 *     `?formato=markdown` e decide sobre o estado LIDO, nunca sobre o cache
 *     (07 §1.5) — inclusive na retentativa.
 *  2. IDEMPOTÊNCIA pela checagem "já feito?" de 07 §9, ANTES de enviar e antes
 *     de retentar: a API não é idempotente [V: 02 §4], e um passo que ficou em
 *     `enviando` (timeout, crash) nunca é reenviado às cegas (03 §9.2):
 *      - nota interna: interna da equipe com o marcador
 *        `[forja:<execucao_id>:<momento>]` (o UUID da execução o torna único);
 *      - pública: mesmo `autor_nome`, `created_at ≥ enviado_em − 5 min` e corpo
 *        NORMALIZADO igual — ou, plano B [NV: S7], os primeiros 200 caracteres
 *        normalizados iguais (critica X-4);
 *      - status/L1/L4: o próprio `GET` mostra se a transição aconteceu.
 *  3. ERROS viram resultado tipado (07 §2.4; 03 §9.3): `409 transicao_invalida`
 *     ou `403` em `/status` → relê e recalcula a cadeia 1× (nunca conta como
 *     sucesso às cegas, critica A-5); `409 estado_terminal` → `pulado`;
 *     `401`/`429` → `reconectar`; rede/5xx → `retentar` (backoff da R3);
 *     `404 chamado_inexistente` → `precisa_humano`.
 *
 * Antes de enviar texto, nota e pública passam pelo DETECTOR DE SEGREDOS
 * (05 §8.2) e a pública pelo VALIDADOR DE LINGUAGEM, revalidado sobre o texto
 * final (04 §8.4): violação nova → `bloqueado` até o humano editar/confirmar.
 */

/** Janela da anti-duplicação da pública (07 §9). */
export const JANELA_DUPLICATA_MS = 5 * 60_000;

/** Motivos padrão dos passos de status (07 §3, §9). */
export const MOTIVO_STATUS_PADRAO: Record<AlvoCadeia, string> = {
  aguardando_cliente: 'pergunta_via_forja',
  em_atendimento: 'implementado_via_forja',
  resolvido: 'implementado_via_forja',
  fechado: 'implementado_via_forja',
};

export interface ContextoOutbox {
  api: Pick<
    OperacoesChamados,
    'obterChamado' | 'publicarMensagem' | 'mudarStatus' | 'definirSilencioIa' | 'atribuir'
  >;
  execucaoId: string;
  identidade: IdentidadeForja;
  papel?: 'operador' | 'admin';
  /** D-036 presente (L1/L4 existem no servidor). */
  d036: boolean;
  /** Valores sensíveis conhecidos (token, `.env`) para o detector (05 §8.2). */
  valoresSensiveis?: readonly string[];
  agora?: () => Date;
}

/** Uma linha de `outbox_chamado` (02 §4.13), no que importa à execução. */
export interface EntradaPasso {
  passo: PassoOutbox;
  /** UUID remoto do chamado. */
  chamado_ref: string;
  /** Mensagens: o texto final. */
  corpo?: string | null;
  /** Quando o passo foi a `enviando` pela 1ª vez (janela da anti-duplicação). */
  enviado_em?: string | null;
  /** Passos de status: sobrepõe `MOTIVO_STATUS_PADRAO` (ex.: `retomada_via_forja`). */
  motivo?: string | null;
  /** `pergunta_publica`/`mensagem_publica`. */
  tipo_resposta?: TipoResposta;
  publicar_mesmo_assim?: { motivos: readonly string[] } | null;
  /** `atribuir`: o humano confirmou no G0 tirar o chamado de outra pessoa (07 §11.4). */
  confirmar_reatribuir?: boolean;
  /** `desatribuir`: valor anterior gravado pelo passo `atribuir`, e se foi a Forja que mudou. */
  operador_anterior?: string | null;
  forja_atribuiu?: boolean;
  /** `reativar_ia`: foi a Forja que silenciou? (07 §7) */
  forja_silenciou?: boolean;
}

/** O que a R3 grava na execução para os passos de reversão (07 §7, §11.4). */
export interface EfeitosPasso {
  forja_silenciou?: boolean;
  forja_atribuiu?: boolean;
  operador_anterior?: string | null;
  /** Transições efetivamente feitas (passos de status). */
  transicoes?: StatusChamado[];
}

export type MotivoPulado =
  | 'estado_terminal'
  | 'sem_d036'
  | 'nao_aplicavel'
  | 'atribuicao_mudou'
  | 'nao_foi_a_forja'
  | 'atribuido_a_outro';

export type MotivoBloqueio =
  | 'segredo_detectado'
  | 'linguagem'
  | 'sem_permissao'
  | 'atribuido_a_outro'
  | 'corpo_ausente'
  | 'marcador_ausente'
  | 'corpo_grande_demais';

export type MotivoPrecisaHumano =
  'chamado_inacessivel' | 'transicao_recusada' | 'conflito' | 'corpo_invalido';

export type ResultadoPasso =
  | {
      resultado: 'enviado';
      /** `true` = a checagem de idempotência achou o passo já feito; nada foi enviado. */
      ja_feito: boolean;
      id_remoto: string | null;
      status_lido: StatusChamado;
      efeitos: EfeitosPasso;
      ultimo_http: number | null;
    }
  | {
      resultado: 'pulado';
      motivo: MotivoPulado;
      aviso: string;
      status_lido: StatusChamado | null;
      ultimo_http: number | null;
    }
  | {
      resultado: 'bloqueado';
      motivo: MotivoBloqueio;
      detalhe: string;
      ultimo_http: number | null;
      validacao?: ResultadoValidacaoLinguagem;
      motivos_nao_confirmados?: string[];
      segredos?: AchadoSegredo[];
    }
  | {
      resultado: 'retentar';
      motivo: 'rede' | 'servidor';
      detalhe: string;
      ultimo_http: number | null;
    }
  | { resultado: 'reconectar'; motivo: EstadoSessao; detalhe: string; ultimo_http: number | null }
  | {
      resultado: 'precisa_humano';
      motivo: MotivoPrecisaHumano;
      /** Motivo da `execucao` (lista fechada de 02 §2.2). */
      motivo_execucao: MotivoEstado;
      detalhe: string;
      ultimo_http: number | null;
    };

// ---------------------------------------------------------------------------
// Tradução de erros (07 §2.4; 03 §9.3)
// ---------------------------------------------------------------------------

function precisaHumano(
  motivo: MotivoPrecisaHumano,
  detalhe: string,
  ultimo_http: number | null,
): ResultadoPasso {
  const motivo_execucao: MotivoEstado =
    motivo === 'chamado_inacessivel'
      ? 'chamado_mudou_no_servidor'
      : motivo === 'corpo_invalido'
        ? 'regra_conteudo_violada'
        : 'transicao_recusada';
  return { resultado: 'precisa_humano', motivo, motivo_execucao, detalhe, ultimo_http };
}

/**
 * Erro de chamada → resultado. `rotaD036` marca chamadas a L1/L4: antes do
 * deploy da D-036 a rota não existe e responde `http_404` (não `chamado_inexistente`).
 */
export function traduzirErro(e: unknown, opcoes: { rotaD036?: boolean } = {}): ResultadoPasso {
  if (e instanceof ErroConexaoIndisponivel) {
    return { resultado: 'reconectar', motivo: e.estado, detalhe: e.message, ultimo_http: null };
  }
  if (e instanceof ErroSemSenha) {
    return { resultado: 'reconectar', motivo: 'sem_senha', detalhe: e.message, ultimo_http: null };
  }
  if (e instanceof ErroRede) {
    return { resultado: 'retentar', motivo: 'rede', detalhe: e.message, ultimo_http: null };
  }
  if (!(e instanceof ErroApi)) throw e;
  const h = e.status;
  if (h === 401) {
    const motivo: EstadoSessao =
      e.codigo === 'credenciais_invalidas' ? 'credencial_invalida' : 'sessao_recusada';
    return { resultado: 'reconectar', motivo, detalhe: e.message, ultimo_http: h };
  }
  if (h === 429)
    return { resultado: 'reconectar', motivo: 'limite_login', detalhe: e.message, ultimo_http: h };
  if (h === 409 && e.codigo === 'estado_terminal') {
    return {
      resultado: 'pulado',
      motivo: 'estado_terminal',
      aviso: 'O chamado foi encerrado no Chamados: nada mais é escrito.',
      status_lido: null,
      ultimo_http: h,
    };
  }
  if (h === 409 && e.codigo === 'transicao_invalida') {
    return precisaHumano('transicao_recusada', e.message, h);
  }
  if (h === 409) return precisaHumano('conflito', e.message, h);
  if (h === 403) {
    return {
      resultado: 'bloqueado',
      motivo: 'sem_permissao',
      detalhe:
        'O usuário da Forja não tem permissão para esta ação: confira a identidade da conexão.',
      ultimo_http: h,
    };
  }
  if (h === 404 && e.codigo === 'chamado_inexistente') {
    return precisaHumano('chamado_inacessivel', 'O chamado ficou inacessível no Chamados.', h);
  }
  if (h === 404 && e.codigo === 'tenant_desconhecido') {
    return {
      resultado: 'reconectar',
      motivo: 'tenant_inexistente',
      detalhe: e.message,
      ultimo_http: h,
    };
  }
  if (h === 404 && opcoes.rotaD036) {
    return {
      resultado: 'pulado',
      motivo: 'sem_d036',
      aviso: 'O Chamados ainda não tem esta extensão (D-036).',
      status_lido: null,
      ultimo_http: h,
    };
  }
  if (h === 400) return precisaHumano('corpo_invalido', e.message, h);
  if (h >= 500 || e.codigo === 'resposta_invalida') {
    return { resultado: 'retentar', motivo: 'servidor', detalhe: e.message, ultimo_http: h };
  }
  return precisaHumano('conflito', `${h} ${e.codigo}: ${e.message}`, h);
}

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

function enviado(
  detalhe: RespostaDetalheChamado,
  ja_feito: boolean,
  extras: {
    id_remoto?: string | null;
    efeitos?: EfeitosPasso;
    ultimo_http?: number | null;
    status_lido?: StatusChamado;
  } = {},
): ResultadoPasso {
  return {
    resultado: 'enviado',
    ja_feito,
    id_remoto: extras.id_remoto ?? null,
    status_lido: extras.status_lido ?? detalhe.chamado.status,
    efeitos: extras.efeitos ?? {},
    ultimo_http: extras.ultimo_http ?? (ja_feito ? 200 : null),
  };
}

function pulado(
  motivo: MotivoPulado,
  aviso: string,
  status: StatusChamado | null,
  ultimo_http: number | null = 200,
): ResultadoPasso {
  return { resultado: 'pulado', motivo, aviso, status_lido: status, ultimo_http };
}

const AVISO_TERMINAL = 'O chamado está encerrado no Chamados: o passo não foi enviado.';

/** `GET` do detalhe; falha já traduzida. */
async function ler(
  ctx: ContextoOutbox,
  ref: string,
): Promise<{ ok: true; detalhe: RespostaDetalheChamado } | { ok: false; r: ResultadoPasso }> {
  try {
    return { ok: true, detalhe: await ctx.api.obterChamado(ref, { formato: 'markdown' }) };
  } catch (e) {
    return { ok: false, r: traduzirErro(e) };
  }
}

function ehDaEquipe(m: MensagemChamado): boolean {
  return m.autor_papel === 'operador' || m.autor_papel === 'admin';
}

/** Nota interna da Forja com o marcador desta execução/momento (07 §9 passo 1). */
export function acharNotaComMarcador(
  mensagens: readonly MensagemChamado[],
  execucaoId: string,
  momento: MomentoMarcador,
): MensagemChamado | null {
  return (
    mensagens.find(
      (m) =>
        m.visibilidade === 'interna' &&
        ehDaEquipe(m) &&
        contemMarcador(m.corpo ?? '', execucaoId, momento),
    ) ?? null
  );
}

/** Pública já publicada pela Forja (07 §9 passo 2; plano B incluído). */
export function acharPublicaDuplicada(
  mensagens: readonly MensagemChamado[],
  corpo: string,
  autorNome: string,
  desde: Date,
): MensagemChamado | null {
  const alvo = normalizarCorpo(corpo);
  const prefixo = alvo.slice(0, PREFIXO_COMPARACAO);
  return (
    mensagens.find((m) => {
      if ((m.visibilidade ?? 'publica') !== 'publica' || m.autor_nome !== autorNome) return false;
      if (!m.created_at || Date.parse(m.created_at) < desde.getTime()) return false;
      const n = normalizarCorpo(m.corpo ?? '');
      return n === alvo || (prefixo.length > 0 && n.slice(0, PREFIXO_COMPARACAO) === prefixo);
    }) ?? null
  );
}

function checarSegredos(ctx: ContextoOutbox, corpo: string): ResultadoPasso | null {
  const r = detectarSegredos(corpo, { valoresConhecidos: ctx.valoresSensiveis });
  if (r.ok) return null;
  return {
    resultado: 'bloqueado',
    motivo: 'segredo_detectado',
    detalhe: `O texto parece conter segredo (${[...new Set(r.achados.map((a) => a.tipo))].join(', ')}): edite antes de enviar.`,
    ultimo_http: null,
    segredos: r.achados,
  };
}

// ---------------------------------------------------------------------------
// Passos de mensagem
// ---------------------------------------------------------------------------

const MOMENTO_DA_NOTA: Partial<Record<PassoOutbox, MomentoMarcador>> = {
  nota_inicio: 'inicio',
  nota_interna: 'conclusao',
  nota_descarte: 'descarte',
};

/** `nota_inicio` · `nota_interna` (conclusão) · `nota_descarte`. */
export async function passoNotaInterna(
  ctx: ContextoOutbox,
  e: EntradaPasso,
): Promise<ResultadoPasso> {
  const momento = MOMENTO_DA_NOTA[e.passo];
  const corpo = e.corpo ?? '';
  if (!momento) throw new Error(`passo ${e.passo} não é nota interna`);
  if (!corpo.trim())
    return {
      resultado: 'bloqueado',
      motivo: 'corpo_ausente',
      detalhe: 'Nota sem texto.',
      ultimo_http: null,
    };
  if (!contemMarcador(corpo, ctx.execucaoId, momento)) {
    return {
      resultado: 'bloqueado',
      motivo: 'marcador_ausente',
      detalhe: `A nota não tem o marcador [forja:${ctx.execucaoId}:${momento}]: sem ele não há como evitar duplicata.`,
      ultimo_http: null,
    };
  }
  if (corpo.length > LIMITE_CORPO_API) {
    return {
      resultado: 'bloqueado',
      motivo: 'corpo_grande_demais',
      detalhe: `A nota tem ${corpo.length} caracteres; o limite da API é ${LIMITE_CORPO_API}.`,
      ultimo_http: null,
    };
  }
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const { detalhe } = l;
  const existente = acharNotaComMarcador(detalhe.mensagens, ctx.execucaoId, momento);
  if (existente) return enviado(detalhe, true, { id_remoto: existente.id });
  if (ehTerminal(detalhe.chamado.status))
    return pulado('estado_terminal', AVISO_TERMINAL, detalhe.chamado.status);
  const bloqueio = checarSegredos(ctx, corpo);
  if (bloqueio) return bloqueio;
  try {
    const r = await ctx.api.publicarMensagem(e.chamado_ref, { visibilidade: 'interna', corpo });
    return enviado(detalhe, false, { id_remoto: r.id, ultimo_http: 201 });
  } catch (erro) {
    return traduzirErro(erro);
  }
}

/** `pergunta_publica` (Gdec) · `mensagem_publica` (encerramento). */
export async function passoMensagemPublica(
  ctx: ContextoOutbox,
  e: EntradaPasso,
): Promise<ResultadoPasso> {
  const corpo = e.corpo ?? '';
  if (!corpo.trim())
    return {
      resultado: 'bloqueado',
      motivo: 'corpo_ausente',
      detalhe: 'Mensagem sem texto.',
      ultimo_http: null,
    };
  const tipo: TipoResposta =
    e.tipo_resposta ?? (e.passo === 'pergunta_publica' ? 'pergunta' : 'aguardando_publicacao');
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const { detalhe } = l;

  const agora = (ctx.agora ?? (() => new Date()))();
  const base = e.enviado_em ? new Date(e.enviado_em) : agora;
  const desde = new Date(base.getTime() - JANELA_DUPLICATA_MS);
  const existente = acharPublicaDuplicada(detalhe.mensagens, corpo, ctx.identidade.nome, desde);
  if (existente) return enviado(detalhe, true, { id_remoto: existente.id });

  if (ehTerminal(detalhe.chamado.status)) {
    return pulado(
      'estado_terminal',
      'O chamado foi encerrado no Chamados: a resposta NÃO foi publicada.',
      detalhe.chamado.status,
    );
  }
  const validacao = validarRespostaPublica(corpo, tipo);
  const decisao = avaliarPublicacao(validacao, e.publicar_mesmo_assim ?? null);
  if (!decisao.permitido) {
    return {
      resultado: 'bloqueado',
      motivo: 'linguagem',
      detalhe:
        'O texto aprovado não passa mais no validador de linguagem: edite ou confirme "publicar mesmo assim".',
      ultimo_http: null,
      validacao,
      motivos_nao_confirmados: decisao.motivos_nao_confirmados,
    };
  }
  const bloqueio = checarSegredos(ctx, corpo);
  if (bloqueio) return bloqueio;
  try {
    const r = await ctx.api.publicarMensagem(e.chamado_ref, { visibilidade: 'publica', corpo });
    return enviado(detalhe, false, { id_remoto: r.id, ultimo_http: 201 });
  } catch (erro) {
    return traduzirErro(erro);
  }
}

// ---------------------------------------------------------------------------
// Passos de status (07 §5, §9; 03 §9.3)
// ---------------------------------------------------------------------------

/**
 * Leva o chamado do status LIDO até `alvo` pela cadeia calculada. Em `409
 * transicao_invalida` ou `403` (papel fora da aresta, 07 §2.4 D1) relê e
 * recalcula UMA vez; persistindo, `precisa_humano` (409) ou `bloqueado` (403).
 */
async function transicionarAte(
  ctx: ContextoOutbox,
  e: EntradaPasso,
  alvo: AlvoCadeia,
  inicial: RespostaDetalheChamado,
): Promise<ResultadoPasso> {
  const motivo = e.motivo ?? MOTIVO_STATUS_PADRAO[alvo];
  const feitas: StatusChamado[] = [];
  let detalhe = inicial;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (tentativa > 0) {
      const l = await ler(ctx, e.chamado_ref);
      if (!l.ok) return l.r;
      detalhe = l.detalhe;
    }
    const cadeia = calcularCadeia(detalhe.chamado.status, alvo, { papel: ctx.papel ?? 'operador' });
    if (cadeia.tipo === 'ja_esta') {
      return enviado(detalhe, feitas.length === 0, {
        efeitos: { transicoes: feitas },
        ultimo_http: 200,
      });
    }
    if (cadeia.tipo === 'impossivel') {
      if (cadeia.motivo === 'estado_terminal')
        return pulado('estado_terminal', AVISO_TERMINAL, cadeia.de);
      return precisaHumano(
        'transicao_recusada',
        cadeia.motivo === 'exige_reabrir'
          ? `O chamado está "${cadeia.de}": chegar a "${alvo}" exigiria reabri-lo — decisão humana.`
          : `Não há caminho de "${cadeia.de}" até "${alvo}" para o papel da Forja.`,
        null,
      );
    }
    let recalcular = false;
    for (const status of cadeia.passos) {
      try {
        await ctx.api.mudarStatus(e.chamado_ref, { status, motivo });
        feitas.push(status);
      } catch (erro) {
        const ehRecalculavel =
          erro instanceof ErroApi &&
          ((erro.status === 409 && erro.codigo === 'transicao_invalida') || erro.status === 403);
        if (ehRecalculavel && tentativa === 0) {
          recalcular = true;
          break;
        }
        return traduzirErro(erro);
      }
    }
    if (!recalcular) {
      return enviado(detalhe, false, {
        efeitos: { transicoes: feitas },
        ultimo_http: 200,
        status_lido: alvo,
      });
    }
  }
  return precisaHumano(
    'transicao_recusada',
    'O Chamados recusou a transição mesmo após reler o chamado.',
    409,
  );
}

/**
 * `status_aguardando_cliente` (Gdec), `status_resolvido`, `status_fechado`: o
 * `GET` mostra se já está no alvo; senão, a cadeia a partir do lido.
 */
async function passoStatusGenerico(
  ctx: ContextoOutbox,
  e: EntradaPasso,
  alvo: AlvoCadeia,
): Promise<ResultadoPasso> {
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  return transicionarAte(ctx, e, alvo, l.detalhe);
}

/**
 * `status_em_atendimento`: só a partir de `aguardando_cliente`/`em_triagem`
 * (07 §9 passo 3; retomada §8.2). Qualquer outro status lido = nada a fazer.
 */
export async function passoStatusEmAtendimento(
  ctx: ContextoOutbox,
  e: EntradaPasso,
): Promise<ResultadoPasso> {
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const s = l.detalhe.chamado.status;
  if (s === 'aguardando_cliente' || s === 'em_triagem') {
    return transicionarAte(ctx, e, 'em_atendimento', l.detalhe);
  }
  if (ehTerminal(s)) return pulado('estado_terminal', AVISO_TERMINAL, s);
  if (s === 'em_atendimento') return enviado(l.detalhe, true);
  return pulado(
    'nao_aplicavel',
    `O chamado está "${s}": não há o que mover para "em atendimento".`,
    s,
  );
}

// ---------------------------------------------------------------------------
// Passos D-036 (L1 silêncio da IA, L4 atribuição)
// ---------------------------------------------------------------------------

const AVISO_SEM_D036 = 'Sem a D-036 no Chamados: passo manual (silêncio/atribuição pelo painel).';

/**
 * `silenciar_ia` (L1). Registra se FOI A FORJA que silenciou (07 §7).
 * FJ-031: a Forja não enfileira mais este passo nem `reativar_ia`; os
 * executores ficam só para linhas antigas do outbox.
 */
export async function passoSilenciarIa(
  ctx: ContextoOutbox,
  e: EntradaPasso,
): Promise<ResultadoPasso> {
  if (!ctx.d036) return pulado('sem_d036', AVISO_SEM_D036, null, null);
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const { detalhe } = l;
  if (ehTerminal(detalhe.chamado.status))
    return pulado('estado_terminal', AVISO_TERMINAL, detalhe.chamado.status);
  if (detalhe.chamado.ia_silenciada === true)
    return enviado(detalhe, true, { efeitos: { forja_silenciou: false } });
  try {
    await ctx.api.definirSilencioIa(e.chamado_ref, true);
    return enviado(detalhe, false, { efeitos: { forja_silenciou: true }, ultimo_http: 200 });
  } catch (erro) {
    return traduzirErro(erro, { rotaD036: true });
  }
}

/**
 * `reativar_ia` (L1): só se foi a Forja que silenciou, e só depois do último
 * passo público (a R3 ordena). Ignorado com o chamado terminal.
 */
export async function passoReativarIa(
  ctx: ContextoOutbox,
  e: EntradaPasso,
): Promise<ResultadoPasso> {
  if (!ctx.d036) return pulado('sem_d036', AVISO_SEM_D036, null, null);
  if (!e.forja_silenciou) {
    return pulado(
      'nao_foi_a_forja',
      'A IA foi silenciada por um humano: a Forja deixa como está.',
      null,
      null,
    );
  }
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const { detalhe } = l;
  if (ehTerminal(detalhe.chamado.status))
    return pulado('estado_terminal', AVISO_TERMINAL, detalhe.chamado.status);
  if (detalhe.chamado.ia_silenciada === false) return enviado(detalhe, true);
  try {
    await ctx.api.definirSilencioIa(e.chamado_ref, false);
    return enviado(detalhe, false, { ultimo_http: 200 });
  } catch (erro) {
    return traduzirErro(erro, { rotaD036: true });
  }
}

/**
 * `atribuir` (L4) a si mesma. O service NÃO é idempotente (cada chamada gera
 * evento e notificação): só chama quando o valor muda. Atribuído a OUTRA pessoa
 * → só com a confirmação do G0 (07 §11.4).
 */
export async function passoAtribuir(ctx: ContextoOutbox, e: EntradaPasso): Promise<ResultadoPasso> {
  if (!ctx.d036) return pulado('sem_d036', AVISO_SEM_D036, null, null);
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const { detalhe } = l;
  if (ehTerminal(detalhe.chamado.status))
    return pulado('estado_terminal', AVISO_TERMINAL, detalhe.chamado.status);
  const atual = detalhe.chamado.operador_id ?? null;
  if (atual === ctx.identidade.usuarioId)
    return enviado(detalhe, true, { efeitos: { forja_atribuiu: false } });
  if (atual !== null && !e.confirmar_reatribuir) {
    // Sem confirmação explícita de reatribuir (07, G0), a Forja NÃO tira o
    // chamado de quem o tem — e o passo é pulado com aviso, para não prender a
    // `nota_inicio` atrás dele (a rodada só anda pela cabeça).
    return pulado(
      'atribuido_a_outro',
      `O chamado segue atribuído a ${detalhe.chamado.operador_nome ?? 'outra pessoa'}: a Forja não reatribuiu (sem confirmação no G0).`,
      detalhe.chamado.status,
    );
  }
  try {
    await ctx.api.atribuir(e.chamado_ref, ctx.identidade.usuarioId);
    return enviado(detalhe, false, {
      efeitos: { forja_atribuiu: true, operador_anterior: atual },
      ultimo_http: 200,
    });
  } catch (erro) {
    return traduzirErro(erro, { rotaD036: true });
  }
}

/**
 * `desatribuir` (L4, rodada de descarte): restaura o valor anterior se foi a
 * Forja que mudou e se ninguém mexeu depois (um humano que reatribuiu ganha).
 */
export async function passoDesatribuir(
  ctx: ContextoOutbox,
  e: EntradaPasso,
): Promise<ResultadoPasso> {
  if (!ctx.d036) return pulado('sem_d036', AVISO_SEM_D036, null, null);
  if (!e.forja_atribuiu) {
    return pulado(
      'nao_foi_a_forja',
      'A atribuição não foi feita pela Forja: fica como está.',
      null,
      null,
    );
  }
  const l = await ler(ctx, e.chamado_ref);
  if (!l.ok) return l.r;
  const { detalhe } = l;
  if (ehTerminal(detalhe.chamado.status))
    return pulado('estado_terminal', AVISO_TERMINAL, detalhe.chamado.status);
  const alvo = e.operador_anterior ?? null;
  const atual = detalhe.chamado.operador_id ?? null;
  if (atual === alvo) return enviado(detalhe, true);
  if (atual !== ctx.identidade.usuarioId) {
    return pulado(
      'atribuicao_mudou',
      'Alguém reatribuiu o chamado depois da Forja: fica como está.',
      detalhe.chamado.status,
    );
  }
  try {
    await ctx.api.atribuir(e.chamado_ref, alvo);
    return enviado(detalhe, false, { ultimo_http: 200 });
  } catch (erro) {
    return traduzirErro(erro, { rotaD036: true });
  }
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

type Executor = (ctx: ContextoOutbox, e: EntradaPasso) => Promise<ResultadoPasso>;

export const EXECUTORES_PASSO: Record<PassoOutbox, Executor> = {
  silenciar_ia: passoSilenciarIa,
  atribuir: passoAtribuir,
  nota_inicio: passoNotaInterna,
  pergunta_publica: passoMensagemPublica,
  status_aguardando_cliente: (ctx, e) => passoStatusGenerico(ctx, e, 'aguardando_cliente'),
  status_em_atendimento: passoStatusEmAtendimento,
  nota_interna: passoNotaInterna,
  mensagem_publica: passoMensagemPublica,
  status_resolvido: (ctx, e) => passoStatusGenerico(ctx, e, 'resolvido'),
  status_fechado: (ctx, e) => passoStatusGenerico(ctx, e, 'fechado'),
  desatribuir: passoDesatribuir,
  reativar_ia: passoReativarIa,
  nota_descarte: passoNotaInterna,
};

/** Executa um passo do outbox. Erros desconhecidos (bug) sobem. */
export function executarPasso(ctx: ContextoOutbox, e: EntradaPasso): Promise<ResultadoPasso> {
  return EXECUTORES_PASSO[e.passo](ctx, e);
}
