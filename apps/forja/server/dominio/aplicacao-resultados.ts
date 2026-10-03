import type {
  ComandoDoStream,
  CustoTurno,
  PlanoRegistrado,
  PlanoV1,
  RelatorioRegistrado,
  RelatorioV1,
  RespostaRegistrada,
  ResumoImplRegistrado,
  ResumoImplV1,
  Selos,
  TelaAfetada,
  ValidacaoResposta,
  VereditoRegistrado,
  VereditoV1,
} from '../../comum/contratos';
import type { AcaoExecucao } from '../../comum/dto';
import type {
  ClassificacaoProcesso,
  EstadoEtapa,
  EstadoExecucao,
  EvidenciaVisual,
  MotivoEstado,
  NivelVerificacao,
  ResultadoTela,
} from '../../comum/estados';
import type { Etapa } from '../db/entidades/etapa';
import type { CalculoNivel, ParTela } from '../verificacao/niveis';
import type { EventoMaquina } from './maquina-execucao';
import {
  ESTADOS_ANTES_DE_MERGEADO,
  ESTADOS_ASSUMIVEIS,
  ESTADOS_COM_PROCESSO,
  estadoTerminal,
} from './maquina-execucao';

/**
 * Aplicação dos resultados das etapas (specs/forja/03 §2.4, §3, §5, §6; 04 §5–§7;
 * 02 §4): funções PURAS que transformam o que um processo/comando produziu em
 * (a) o FATO para a máquina (`EventoMaquina`), (b) o artefato ⚙ "registrado"
 * que vai para `artefato.conteudo` e (c) os contadores derivados das etapas.
 *
 * POR QUE separado de `etapas.ts`: o I/O (spawn, git, SQLite) fica lá; aqui
 * fica a regra que dá para testar por unidade — inclusive o mapeamento
 * classificação do runner (01 §6.6) → estado (03 §2.3/§6/§11), que a spec
 * deixa para 03 e é o ponto mais fácil de errar.
 */

// ---------------------------------------------------------------------------
// Classificação do runner → fato da máquina (01 §6.6 × 03 §2.3, §6, §7.6, §11)
// ---------------------------------------------------------------------------

export type DesfechoProcesso =
  | { tipo: 'ok' }
  /** Pausa/parada/descarte pedidos pelo humano: o comando humano já transicionou. */
  | { tipo: 'parado' }
  /** `saida_invalida` ainda com tentativa: resume pedindo o schema (03 §6). */
  | { tipo: 'repetir_saida' }
  /** `perfil_divergente` só por agente fora do papel: atualiza a lista e reinicia 1× (01 §6.2). */
  | { tipo: 'reiniciar_perfil' }
  | { tipo: 'fato'; evento: EventoMaquina; alerta?: 'autenticacao' };

export function desfechoDaClassificacao(
  c: ClassificacaoProcesso,
  ctx: {
    tentativasSaidaInvalida: number;
    agentesForaDoPapel: number;
    perfilJaReiniciado: boolean;
    paradaPedida: boolean;
  },
): DesfechoProcesso {
  switch (c) {
    case 'concluido':
      return { tipo: 'ok' };
    case 'pausado':
    case 'cancelado':
      return ctx.paradaPedida
        ? { tipo: 'parado' }
        : { tipo: 'fato', evento: { tipo: 'processo_interrompido' } };
    case 'saida_invalida':
      return ctx.tentativasSaidaInvalida < 1
        ? { tipo: 'repetir_saida' }
        : { tipo: 'fato', evento: { tipo: 'falha_infra', motivo: 'saida_invalida' } };
    case 'limite_orcamento':
      return { tipo: 'fato', evento: { tipo: 'etapa_estourou', causa: 'orcamento' } };
    case 'limite_turnos':
      return { tipo: 'fato', evento: { tipo: 'etapa_estourou', causa: 'orcamento' } };
    case 'timeout':
      return { tipo: 'fato', evento: { tipo: 'etapa_estourou', causa: 'timeout' } };
    case 'cota':
      return { tipo: 'fato', evento: { tipo: 'limite_cota', overage_nao_autorizado: false } };
    case 'perfil_divergente':
      return ctx.agentesForaDoPapel > 0 && !ctx.perfilJaReiniciado
        ? { tipo: 'reiniciar_perfil' }
        : {
            tipo: 'fato',
            evento: {
              tipo: 'falha_infra',
              motivo: 'perfil_divergente',
              texto: 'o init da CLI não bate com o perfil da etapa',
            },
          };
    // Autenticação: não há motivo próprio na lista fechada (02 §2.2). A etapa
    // fica `interrompido` (retomável) e o pipeline recebe `cli.alerta` bloqueante.
    case 'autenticacao':
      return { tipo: 'fato', evento: { tipo: 'processo_interrompido' }, alerta: 'autenticacao' };
    case 'interrompido':
    case 'erro_execucao':
      return { tipo: 'fato', evento: { tipo: 'processo_interrompido' } };
  }
  return { tipo: 'fato', evento: { tipo: 'processo_interrompido' } };
}

/** `etapa.estado` ao fim do processo: o que é retomável fica `interrompida` (03 §3.3). */
export function estadoEtapaDaClassificacao(
  c: ClassificacaoProcesso,
): Exclude<EstadoEtapa, 'executando'> {
  switch (c) {
    case 'concluido':
      return 'concluida';
    case 'pausado':
    case 'interrompido':
    case 'cota':
    case 'autenticacao':
    case 'erro_execucao':
      return 'interrompida';
    case 'cancelado':
      return 'cancelada';
    default:
      return 'falhou';
  }
}

/** A última etapa do tipo, no ciclo atual, ficou retomável? (resume com o mesmo schema, 01 §6.7). */
export function etapaParaRetomar(
  etapas: readonly Etapa[],
  tipo: Etapa['tipo'],
  ciclo: number,
): Etapa | null {
  const ultima = [...etapas].reverse().find((e) => e.tipo === tipo);
  if (!ultima || ultima.ciclo !== ciclo || !ultima.session_id) return null;
  return ultima.estado === 'interrompida' ? ultima : null;
}

/** O processo morreu sem ter sido pedido (crash, reboot): o que a retomada AUTOMÁTICA cobre. */
const FIM_POR_CRASH: readonly string[] = ['interrompido', 'erro_execucao'];

/**
 * A etapa interrompida agora JÁ era uma retomada automática de crash? (1× por
 * etapa, 03 §3.3). Conta só a cadeia da etapa interrompida: a última do tipo é
 * uma retomada E a anterior do mesmo tipo terminou por crash. Retomadas depois
 * de `pausado_cota` (03 §7.6), Pausar/Retomar ou desligamento não contam.
 */
export function retomadasAutomaticas(etapas: readonly Etapa[], tipo: Etapa['tipo']): number {
  const doTipo = etapas.filter((e) => e.tipo === tipo);
  const ultima = doTipo.at(-1);
  const anterior = doTipo.at(-2);
  if (!ultima?.retomada || !anterior) return 0;
  return FIM_POR_CRASH.includes(anterior.motivo_fim ?? '') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Texto dos fatos do app para os prompts (04 §4; FJ-032)
// ---------------------------------------------------------------------------

export const sha8 = (sha: string): string => sha.slice(0, 8);

const MARCA_STREAM: Record<ComandoDoStream['resultado'], string> = {
  exit_0: 'exit 0',
  erro: 'com erro',
  sem_resultado: 'sem resultado',
};

/**
 * Comandos que o T1 rodou, lidos do stream (FJ-032): o que vai ao T2 como fato
 * (informativo — o revisor roda os checks de novo) e ao relatório.
 */
export function textoComandosDoStream(comandos: readonly ComandoDoStream[]): string {
  if (comandos.length === 0) {
    return '(o implementador não rodou nenhum comando de verificação visível no stream)';
  }
  return comandos.map((c) => `- \`${c.comando}\` → ${MARCA_STREAM[c.resultado]}`).join('\n');
}

/**
 * Bloco "Como foi verificado" (T3): nível ⚙ + comandos relatados × stream.
 * Com `sha`, cada comando confirmado ganha a ref `comando:<n>@<sha8>`.
 */
export function textoComoFoiVerificado(
  n: Pick<CalculoNivel, 'nivel' | 'motivo' | 'comandos'>,
  sha?: string,
): string {
  const marca = {
    exit_0: 'visto no stream, exit 0',
    erro: 'visto no stream, com erro',
    nao_visto: 'não visto no stream',
  } as const;
  const linhas = n.comandos.map((c, i) => {
    const ref =
      sha && c.no_stream === 'exit_0' && c.exit_code === 0
        ? ` — ref \`comando:${i + 1}@${sha8(sha)}\``
        : '';
    return `- \`${c.comando}\` (relatado exit ${c.exit_code ?? '?'}; ${marca[c.no_stream]})${ref}`;
  });
  return [
    `Nível de verificação (calculado pelo app): ${n.nivel} — ${n.motivo}`,
    ...(linhas.length ? linhas : ['(a revisão não relatou comandos)']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Evidência visual (FJ-026, 03 §5.4)
// ---------------------------------------------------------------------------

export interface CapturaRegistrada {
  tela_id: string;
  rota: string;
  resultado: ResultadoTela;
  artefato_id: string | null;
}

/** Telas a fotografar: `plano.telas_afetadas` ∪ `resumo_impl.telas_afetadas` (por `tela_id`). */
export function telasDaExecucao(
  plano: Pick<PlanoV1, 'telas_afetadas'> | null,
  resumo: Pick<ResumoImplV1, 'telas_afetadas'> | null,
): TelaAfetada[] {
  const porId = new Map<string, TelaAfetada>();
  for (const t of [...(plano?.telas_afetadas ?? []), ...(resumo?.telas_afetadas ?? [])]) {
    if (!porId.has(t.id)) porId.set(t.id, t);
  }
  return [...porId.values()];
}

/** Pares antes/depois por tela para `calcularEvidenciaVisual`. */
export function paresTelas(
  telas: readonly Pick<TelaAfetada, 'id'>[],
  antes: readonly CapturaRegistrada[],
  depois: readonly CapturaRegistrada[],
): ParTela[] {
  return telas.map((t) => ({
    tela_id: t.id,
    antes: antes.find((c) => c.tela_id === t.id)?.resultado ?? null,
    depois: depois.find((c) => c.tela_id === t.id)?.resultado ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Artefatos ⚙ registrados (04 §5, `comum/contratos/registrados.ts`)
// ---------------------------------------------------------------------------

export function custoVazio(): CustoTurno {
  return {
    custo_usd: 0,
    model_usage_delta: {},
    subagent_stats: null,
    num_turns: 0,
    duracao_ms: 0,
    permission_denials: [],
  };
}

export function planoRegistrado(e: {
  plano: PlanoV1;
  arquivos_previstos: readonly string[];
  sha_base: string;
  gate_g1: { exigido: boolean; motivos: readonly string[] };
  /** ⚙ FJ-034 (`avaliarG1(...).avisos`). */
  avisos: readonly string[];
  editado: boolean;
  prompt_versao: string;
  custo: CustoTurno | null;
}): PlanoRegistrado {
  return {
    ...e.plano,
    arquivos_previstos: [...e.arquivos_previstos],
    sha_base: e.sha_base,
    gate_g1: { exigido: e.gate_g1.exigido, motivos: [...e.gate_g1.motivos] },
    avisos: [...e.avisos],
    editado_pelo_operador: e.editado,
    prompt_versao: e.prompt_versao,
    custo_turno: e.custo ?? custoVazio(),
  };
}

export interface DiffStat {
  arquivos: number;
  adicoes: number;
  remocoes: number;
}

/** `git diff --numstat` → totais (binário conta 0 linhas). */
export function somarNumstat(saida: string): DiffStat {
  let arquivos = 0;
  let adicoes = 0;
  let remocoes = 0;
  for (const linha of saida.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(linha);
    if (!m) continue;
    arquivos += 1;
    adicoes += m[1] === '-' ? 0 : Number(m[1]);
    remocoes += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { arquivos, adicoes, remocoes };
}

export function resumoImplRegistrado(e: {
  resumo: ResumoImplV1;
  sha_checkpoints: readonly string[];
  sha_final: string;
  arquivos_reais: readonly string[];
  diff_stat: DiffStat;
  condutor_editou: boolean;
  modelo_subagentes: string;
  custo: CustoTurno;
  /**
   * O que o app MEDIU no stream (04 §9): `agente.fora_do_papel` e `Agent` por
   * `subagent_type`. Presente, vale sobre o que o modelo declarou em `executor`.
   */
  medido?: {
    fora_do_papel: readonly { ferramenta: 'Edit' | 'Write' | 'Bash'; alvo: string }[];
    subagentes: Readonly<Record<string, number>>;
  };
  /** Comandos de verificação/instalação vistos no stream do T1 (FJ-032). */
  comandos_stream?: readonly ComandoDoStream[];
}): ResumoImplRegistrado {
  const implementadores = e.resumo.passos.filter((p) => p.executor === 'implementador').length;
  const declarado = e.condutor_editou
    ? e.resumo.passos
        .filter((p) => p.executor === 'condutor')
        .flatMap((p) => p.arquivos_alterados.map((alvo) => ({ ferramenta: 'Edit' as const, alvo })))
    : [];
  const medidas = e.medido?.fora_do_papel ?? [];
  const condutorEditou = [...medidas, ...declarado].filter(
    (x, i, todos) =>
      todos.findIndex((y) => y.ferramenta === x.ferramenta && y.alvo === x.alvo) === i,
  );
  const subagentes = e.medido
    ? Object.entries(e.medido.subagentes)
        .filter(([, chamadas]) => chamadas > 0)
        .map(([tipo, chamadas]) => ({ tipo, modelo: e.modelo_subagentes, chamadas }))
    : implementadores > 0
      ? [{ tipo: 'implementador', modelo: e.modelo_subagentes, chamadas: implementadores }]
      : [];
  return {
    ...e.resumo,
    sha_checkpoints: [...e.sha_checkpoints],
    sha_final: e.sha_final,
    arquivos_reais: [...e.arquivos_reais],
    diff_stat: e.diff_stat,
    condutor_editou: condutorEditou,
    subagentes,
    custo_turno: e.custo,
    ...(e.comandos_stream ? { comandos_stream: [...e.comandos_stream] } : {}),
  };
}

export function vereditoRegistrado(e: {
  veredito: VereditoV1;
  /** Nível ⚙ calculado do relatado × stream do T2 (FJ-032). */
  nivel: Pick<CalculoNivel, 'nivel' | 'motivo' | 'comandos'>;
  sha_verificado: string;
  valido: boolean;
  motivo_invalido: string | null;
  repetidos: readonly string[];
  decisao_do_app: VereditoRegistrado['decisao_do_app'];
  custo: CustoTurno;
}): VereditoRegistrado {
  return {
    ...e.veredito,
    verificacao: {
      nivel: e.nivel.nivel,
      motivo: e.nivel.motivo,
      sha_verificado: e.sha_verificado,
      comandos: [...e.nivel.comandos],
    },
    valido: e.valido,
    ...(e.motivo_invalido ? { motivo_invalido: e.motivo_invalido } : {}),
    repetidos: [...e.repetidos],
    decisao_do_app: e.decisao_do_app,
    custo_turno: e.custo,
  };
}

/** Achados que ficam em aberto (bloqueante/importante) — confirmação explícita no G2. */
export function achadosEmAberto(veredito: Pick<VereditoV1, 'achados'> | null): string[] {
  if (!veredito) return [];
  return veredito.achados
    .filter((a) => a.severidade === 'bloqueante' || a.severidade === 'importante')
    .map((a) => `${a.id} (${a.severidade}): ${a.descricao}`);
}

export function respostaRegistrada(e: {
  resposta: RelatorioV1['resposta_ao_cliente'];
  validacao: ValidacaoResposta;
  corpo_hash: string;
  editada: boolean;
  publicar_mesmo_assim: RespostaRegistrada['publicar_mesmo_assim'];
}): RespostaRegistrada {
  return {
    ...e.resposta,
    validacao: {
      tecnico: [...e.validacao.tecnico],
      promessa: [...e.validacao.promessa],
      lexico: [...e.validacao.lexico],
      disponibilidade: [...e.validacao.disponibilidade],
      ok: e.validacao.ok,
    },
    publicar_mesmo_assim: e.publicar_mesmo_assim,
    editada_pelo_operador: e.editada,
    corpo_hash: e.corpo_hash,
  };
}

/**
 * FJ-033: as suposições do plano chegam à aprovação mesmo que o relator as
 * omita — vazio no relatório com suposições no plano ⇒ copia as do plano.
 */
export function suposicoesDoRelatorio(
  relatorio: Pick<RelatorioV1, 'suposicoes_assumidas'>,
  suposicoesPlano: readonly string[],
): string[] {
  const doRelator = relatorio.suposicoes_assumidas as string[] | undefined;
  return doRelator && doRelator.length > 0 ? [...doRelator] : [...suposicoesPlano];
}

export function relatorioRegistrado(e: {
  relatorio: RelatorioV1;
  telas: readonly {
    tela_id: string;
    rota: string;
    antes_ref: string | null;
    depois_ref: string | null;
  }[];
  selos: Selos;
  nivel: NivelVerificacao;
  ciclos: number;
  custo_micro_usd: number;
  diff_stat: DiffStat;
  sha: string;
  patch_id: string;
  achados_em_aberto: readonly string[];
  condutor_editou: boolean;
  incoerencias: readonly string[];
  regenerado: boolean;
  evidencia_visual: EvidenciaVisual;
  evidencia_visual_motivo: string | null;
  /** `plano.suposicoes` (FJ-033): o relator as lista; se deixou vazio, o app copia. */
  suposicoes_plano: readonly string[];
}): RelatorioRegistrado {
  const porId = new Map(e.telas.map((t) => [t.tela_id, t]));
  return {
    ...e.relatorio,
    suposicoes_assumidas: suposicoesDoRelatorio(e.relatorio, e.suposicoes_plano),
    alteracoes_de_interface: {
      ...e.relatorio.alteracoes_de_interface,
      telas: e.relatorio.alteracoes_de_interface.telas.map((t) => ({
        ...t,
        rota: porId.get(t.tela_id)?.rota ?? '',
        antes_ref: porId.get(t.tela_id)?.antes_ref ?? null,
        depois_ref: porId.get(t.tela_id)?.depois_ref ?? null,
      })),
    },
    selos: e.selos,
    nivel_verificacao: e.nivel,
    ciclos: e.ciclos,
    custo_equivalente_usd: e.custo_micro_usd / 1_000_000,
    arquivos: e.diff_stat.arquivos,
    linhas: { adicoes: e.diff_stat.adicoes, remocoes: e.diff_stat.remocoes },
    sha: e.sha,
    patch_id: e.patch_id,
    sensiveis: [...e.selos.sensivel],
    achados_em_aberto: [...e.achados_em_aberto],
    condutor_editou: e.condutor_editou,
    incoerencias: [...e.incoerencias],
    regenerado: e.regenerado,
    evidencia_visual: e.evidencia_visual,
    evidencia_visual_motivo: e.evidencia_visual_motivo,
  };
}

// ---------------------------------------------------------------------------
// Ações válidas por estado/motivo (06 §4.2; 03 §2.4 "precisa_humano → vários")
// ---------------------------------------------------------------------------

export interface ContextoAcoes {
  estado: EstadoExecucao;
  estado_anterior: EstadoExecucao | null;
  motivo: MotivoEstado | null;
  /** Há processo de agente rodando agora. */
  processo_vivo: boolean;
  /** A sessão está assumida no terminal (PTY aberto). */
  assumida: boolean;
  /** Já existe commit além do `sha_base` (replanejar só antes, 03 §3.1). */
  existe_commit: boolean;
  /** Sessão condutora ou do planejador existe (conversar/assumir precisam). */
  tem_sessao: boolean;
  cliente_respondeu: boolean;
  sentinela_pendente: boolean;
  altera_ui: boolean;
  /** Já houve T1 (plano aprovado): "mais um ciclo" só então (03 §2.4). Ausente = sem restrição. */
  teve_implementacao?: boolean;
  /** Há veredito do T2 no `sha_verificado` = HEAD: "seguir com achados" só então. Ausente = `existe_commit`. */
  seguir_com_achados_ok?: boolean;
}

/** Motivos de `precisa_humano` que NUNCA voltam ao T1 por "mais um ciclo". */
const SEM_MAIS_UM_CICLO: readonly MotivoEstado[] = [
  'nao_implementavel',
  'base_vermelha', // só linhas antigas (FJ-032): não houve T1
  'push_recusado',
];

/**
 * "Mais um ciclo" (03 §2.4, "conforme motivo_estado"): só com plano aprovado
 * (já houve T1) ou commit — nunca pula o G1 nem implementa um plano
 * `nao_implementavel`.
 */
export function maisUmCicloPermitido(
  motivo: MotivoEstado | null,
  existeCommit: boolean,
  etapas: readonly Pick<Etapa, 'tipo'>[],
): boolean {
  if (motivo && SEM_MAIS_UM_CICLO.includes(motivo)) return false;
  return existeCommit || etapas.some((e) => e.tipo === 'implementar');
}

/**
 * "Seguir com achados" (03 §2.4): o T3 relata sobre `sha_verificado`, então
 * ele tem de ser o HEAD atual e ter veredito do T2 (nunca um sha velho ou nulo).
 */
export function seguirComAchadosPermitido(
  e: { sha_verificado: string | null; sha_atual: string | null },
  etapas: readonly Pick<Etapa, 'tipo' | 'estado' | 'sha_inicio'>[],
): boolean {
  if (!e.sha_verificado || e.sha_verificado !== e.sha_atual) return false;
  return etapas.some(
    (x) => x.tipo === 'revisar' && x.estado === 'concluida' && x.sha_inicio === e.sha_verificado,
  );
}

/**
 * `ExecucaoDto.acoes`: a UI mostra cada botão só se a ação vier aqui — a regra
 * fica no servidor, não na tela (web-a). Espelha as linhas humanas de 03 §2.4.
 */
export function acoesDisponiveis(c: ContextoAcoes): AcaoExecucao[] {
  const acoes: AcaoExecucao[] = [];
  const add = (...a: AcaoExecucao[]) => acoes.push(...a);
  if (estadoTerminal(c.estado)) {
    // Divergência numa execução terminal ainda trava o projeto: o "Reconhecer" segue disponível.
    if (c.sentinela_pendente) add('reconhecer_sentinela');
    return acoes;
  }
  if (ESTADOS_COM_PROCESSO.includes(c.estado)) add('pausar');
  if (c.processo_vivo) add('parar');
  switch (c.estado) {
    case 'pausado_usuario':
      add('retomar');
      if (c.tem_sessao) add('conversar');
      break;
    case 'pausado_cota':
      add('retomar_mesmo_assim');
      break;
    case 'aguardando_plano':
      add('aprovar_plano', 'comentar_plano');
      break;
    case 'aguardando_decisao':
      add('decidir');
      break;
    case 'aguardando_cliente_resposta':
      if (c.cliente_respondeu) add('replanejar');
      break;
    case 'aguardando_aprovacao':
      add('abrir_aprovacao');
      if (c.altera_ui) add('recapturar_prints');
      break;
    case 'assumido_manual':
      add('devolver');
      break;
    case 'falhou':
    case 'interrompido':
      add('tentar_novamente');
      break;
    case 'mergeado_pendente_chamado':
      add('tentar_novamente');
      break;
    case 'precisa_humano':
      // "Tentar de novo" vale SEMPRE em precisa_humano (pedido do usuário):
      // replaneja ou reimplementa conforme exista commit.
      add('tentar_novamente');
      if (c.motivo !== 'push_recusado') {
        if (!(c.motivo && SEM_MAIS_UM_CICLO.includes(c.motivo)) && (c.teve_implementacao ?? true)) {
          add('mais_um_ciclo');
        }
        if (c.seguir_com_achados_ok ?? c.existe_commit) add('seguir_com_achados');
      }
      if (!c.existe_commit) add('replanejar');
      break;
  }
  if (ESTADOS_ASSUMIVEIS.includes(c.estado) && c.tem_sessao && !c.assumida) add('assumir');
  if (c.sentinela_pendente) add('reconhecer_sentinela');
  if (ESTADOS_ANTES_DE_MERGEADO.includes(c.estado)) {
    add('descartar');
    if (!c.existe_commit) add('encerrar');
  }
  return [...new Set(acoes)];
}
