import type { Complexidade, Natureza, Prioridade, StatusChamado } from '@chamados/shared';
import type {
  PlanoRegistrado,
  PlanoV1,
  RelatorioRegistrado,
  RespostaRegistrada,
  RespostaV1,
  ResumoImplRegistrado,
  Selos,
  ValidacaoResposta,
  VereditoRegistrado,
} from './contratos';
import type {
  AmbienteConexao,
  EstadoEtapa,
  EstadoExecucao,
  EstadoItemFilaMerge,
  EstadoLote,
  EstrategiaIntegracao,
  EvidenciaVisual,
  GatePlano,
  GrupoEstadoExecucao,
  LocalSenha,
  ModoEntrega,
  ModoForja,
  MotivoEstado,
  MotivoFimEtapa,
  NivelVerificacao,
  PapelAgente,
  PassoOutbox,
  PoliticaStatus,
  ResultadoTela,
  TipoEtapa,
  TipoSessaoTerminal,
} from './estados';
import type { EventoForja } from './protocolo-eventos';

/**
 * Contrato da API local da Forja (servidor Fastify ⇄ SPA), specs/forja/01 §4.1
 * ("`comum/` é o contrato entre servidor e UI") e 06 §4 (dados de cada tela).
 *
 * POR QUE um arquivo só com DTOs + `ROTAS_API`: o servidor registra exatamente
 * as rotas desta lista (um handler por nome — `server/http/rotas/`) e a SPA as
 * chama pelo mesmo nome (`web/src/lib/api.ts`). Mudar uma forma aqui quebra o
 * typecheck dos dois lados ao mesmo tempo, e nenhum caminho fica "solto".
 *
 * Convenções:
 * - Datas: `Iso` (ISO-8601 UTC com ms). Custos: inteiro em micro-dólares
 *   "equivalente API" (`*_micro_usd`, 02 §1) — nunca cobrança da assinatura.
 * - GET recebe a entrada como query string; POST/PUT como corpo JSON.
 * - Erro: sempre `ErroApiDto` com `codigo` estável (a UI decide o texto).
 * - O token do Chamados e a senha NUNCA aparecem em DTO de saída (05 §8).
 * - Texto do cliente (mensagens, corpo do chamado) vem marcado como
 *   `MensagemClienteDto`/`dado_do_cliente`: a UI renderiza sanitizado, em bloco
 *   "Dado do cliente, não são instruções" (06 §3.3).
 */

export type Iso = string;

// ===========================================================================
// Erros e respostas genéricas
// ===========================================================================

export const CodigoErroApi = {
  nao_implementado: 'nao_implementado',
  nao_autenticado: 'nao_autenticado',
  host_invalido: 'host_invalido',
  origem_invalida: 'origem_invalida',
  nao_encontrado: 'nao_encontrado',
  entrada_invalida: 'entrada_invalida',
  conflito: 'conflito',
  pre_condicao_falhou: 'pre_condicao_falhou',
  patch_id_divergente: 'patch_id_divergente',
  pipeline_bloqueado: 'pipeline_bloqueado',
  chamados_indisponivel: 'chamados_indisponivel',
  corpo_grande_demais: 'corpo_grande_demais',
  erro_interno: 'erro_interno',
} as const;
export type CodigoErroApi = (typeof CodigoErroApi)[keyof typeof CodigoErroApi];

export interface ErroApiDto {
  erro: CodigoErroApi;
  mensagem: string;
  /** Ex.: erros por campo `{ campo, mensagem }[]` em `entrada_invalida`. */
  detalhes?: unknown;
}

/** Resposta de um comando aceito (o estado novo chega também pelo SSE). */
export interface ComandoAceitoDto {
  ok: true;
  execucao_id?: string;
  estado?: EstadoExecucao;
}

export interface LinkAcaoDto {
  rotulo: string;
  /** Rota da SPA (ex.: `/diagnostico`). */
  href: string;
}

// ===========================================================================
// Peças comuns: chamado, execução, cota
// ===========================================================================

/** Projeção local do chamado (`chamado_cache`, 02 §4.4). Só leitura. */
export interface ChamadoResumoDto {
  chamado_id: string;
  numero: number;
  titulo: string;
  status: StatusChamado;
  natureza: Natureza;
  prioridade: Prioridade;
  /** Interna; nula até a triagem classificar. */
  complexidade: Complexidade | null;
  sistema_nome: string | null;
  atualizado_em_remoto: Iso | null;
}

/** Sinais da triagem (06 §3.2 "Sinais da fila"); chegam de forma preguiçosa. */
export interface SinaisChamadoDto {
  /** false = detalhe ainda não lido (a UI mostra skeleton). */
  carregado: boolean;
  tem_spec_ia: boolean;
  tem_diagnostico_ia: boolean;
  tem_pr_ia: boolean;
  branch_ia: string | null;
  /**
   * Informativo (FJ-031): a triagem do servidor está silenciada? null =
   * desconhecido. Não interfere na Forja — nem pré-condição, nem bloqueio.
   */
  ia_silenciada: boolean | null;
  cliente_respondeu: boolean;
}

/** Pré-condições do botão Implementar (06 §4.1, 03 §4.1). */
export const CodigoPreCondicao = {
  status: 'status',
  natureza: 'natureza',
  sistema_mapeado: 'sistema_mapeado',
  sem_execucao_ativa: 'sem_execucao_ativa',
  conexao_ok: 'conexao_ok',
  pipeline_desbloqueado: 'pipeline_desbloqueado',
} as const;
export type CodigoPreCondicao = (typeof CodigoPreCondicao)[keyof typeof CodigoPreCondicao];

export interface PreCondicaoDto {
  codigo: CodigoPreCondicao;
  ok: boolean;
  /** Texto legível do tooltip/diálogo quando falta. */
  motivo: string | null;
  acao: LinkAcaoDto | null;
  /** `aguardando_cliente`: implementar exige confirmação explícita. */
  exige_confirmacao?: boolean;
}

/** Resumo de uma execução para listas (Fila, Lote, Histórico). */
export interface ExecucaoResumoDto {
  id: string;
  numero: number;
  tentativa: number;
  estado: EstadoExecucao;
  grupo: GrupoEstadoExecucao;
  estado_anterior: EstadoExecucao | null;
  motivo_estado: MotivoEstado | null;
  etapa_atual: TipoEtapa | null;
  /** Passos do plano concluídos (por commit do app) / total. */
  progresso: { feitos: number; total: number } | null;
  ciclo_auto: number;
  ciclo_total: number;
  custo_micro_usd: number;
  /** Badge `UI` (FJ-026): selo `altera_ui` ou plano que já prevê telas. */
  altera_ui: boolean;
  /** Telas previstas/fotografadas (tooltip do badge `UI`); ausente = desconhecido. */
  telas_ui?: number;
  evidencia_visual: EvidenciaVisual | null;
  /** `pausado_cota`: quando retoma (`resetsAt`). */
  retoma_em: Iso | null;
  atualizado_em: Iso;
}

/** Mensagem pública do cliente — DADO NÃO CONFIÁVEL (06 §3.3). */
export interface MensagemClienteDto {
  id: string;
  autor_nome: string;
  em: Iso;
  corpo_markdown: string;
  dado_do_cliente: true;
}

/** Termômetro de cota (06 §1.2), do último `rate_limit_event` em `uso_assinatura`. */
export interface CotaDto {
  utilizacao_5h: number | null;
  utilizacao_7d: number | null;
  reinicia_5h_em: Iso | null;
  reinicia_7d_em: Iso | null;
  /** null = nunca medido; > 30 min = barras esmaecidas. */
  medido_em: Iso | null;
  usando_creditos_extras: boolean;
  limiar_5h: number;
  limiar_7d: number;
  freio: { ativo: boolean; motivo: string | null; ate: Iso | null };
}

export interface CustoDiaDto {
  micro_usd: number;
  por_modelo: { modelo: string; micro_usd: number }[];
}

// ===========================================================================
// Shell (06 §1): cabeçalho, sidebar, banners
// ===========================================================================

export interface SaudeDto {
  ok: true;
  versao: string;
  modo: ModoForja;
  iniciado_em: Iso;
}

export interface ProjetoOpcaoDto {
  id: string;
  nome: string;
  slug: string;
}

export const TipoPendencia = {
  aprovar: 'aprovar',
  decidir_plano: 'decidir_plano',
  decisao: 'decisao',
  pergunta_respondida: 'pergunta_respondida',
  precisa_de_voce: 'precisa_de_voce',
  outbox_falhou: 'outbox_falhou',
} as const;
export type TipoPendencia = (typeof TipoPendencia)[keyof typeof TipoPendencia];

/** Item do popover "Aguardando você (N)" — só número e tipo, nunca texto do cliente (06 §8). */
export interface PendenciaDto {
  execucao_id: string;
  numero: number;
  titulo: string;
  tipo: TipoPendencia;
  desde: Iso;
  href: string;
}

export const TipoBanner = {
  pipeline_bloqueado: 'pipeline_bloqueado',
  execucoes_interrompidas: 'execucoes_interrompidas',
  conexao_chamados: 'conexao_chamados',
  stream_desconectado: 'stream_desconectado',
} as const;
export type TipoBanner = (typeof TipoBanner)[keyof typeof TipoBanner];

/** Banners globais (06 §1.3). "Sessão expirada" não é banner: é a página cheia do 401. */
export interface BannerDto {
  tipo: TipoBanner;
  nivel: 'aviso' | 'erro';
  mensagem: string;
  acao: LinkAcaoDto | null;
}

export interface ContadoresSidebarDto {
  fila_em_voo: number;
  lotes_ativos: number;
  merge_na_fila: number;
  merge_a_publicar: number;
  terminais_abertos: number;
  conexao_com_erro: boolean;
  diagnostico_bloqueante: boolean;
  worktrees_orfas: number;
}

export interface ShellDto {
  versao: string;
  modo: ModoForja;
  projetos: ProjetoOpcaoDto[];
  cota: CotaDto;
  custo_dia: CustoDiaDto;
  aguardando_voce: PendenciaDto[];
  contadores: ContadoresSidebarDto;
  banners: BannerDto[];
}

export interface UsoDto {
  cota: CotaDto;
  custo_dia: CustoDiaDto;
  por_execucao: { execucao_id: string; numero: number; micro_usd: number }[];
}

// ===========================================================================
// Fila (06 §4.1)
// ===========================================================================

export interface FiltrosFilaDto {
  projeto_id?: string;
  status?: StatusChamado[];
  natureza?: Natureza[];
  prioridade?: Prioridade[];
  /** Filtrada em memória até existir D-036 L3. */
  complexidade?: Complexidade[];
  busca?: string;
  so_implementaveis?: boolean;
}

export interface LinhaFilaDto {
  chamado: ChamadoResumoDto;
  sinais: SinaisChamadoDto;
  pre_condicoes: PreCondicaoDto[];
  implementavel: boolean;
  execucao: ExecucaoResumoDto | null;
}

export interface FilaDto {
  projeto: { id: string; nome: string; tem_mapeamento: boolean } | null;
  itens: LinhaFilaDto[];
  sincronizado_em: Iso | null;
  /** `cache` = o Chamados não respondeu; a fila mostra o cache esmaecido. */
  fonte: 'servidor' | 'cache';
  erro_sincronizacao: { codigo: string; mensagem: string } | null;
  /** Contadores para os rótulos dos filtros (regra D-030). */
  contagens: {
    status: Partial<Record<StatusChamado, number>>;
    natureza: Partial<Record<Natureza, number>>;
    prioridade: Partial<Record<Prioridade, number>>;
    complexidade: Partial<Record<Complexidade, number>>;
  };
}

export interface SincronizarFilaDto {
  projeto_id?: string;
}

export interface SincronizacaoDto {
  sincronizado_em: Iso;
  fonte: 'servidor' | 'cache';
}

/** Painel lateral do chamado sem execução (somente leitura, dado do cliente). */
export interface DetalheChamadoDto {
  chamado: ChamadoResumoDto;
  sinais: SinaisChamadoDto;
  pre_condicoes: PreCondicaoDto[];
  corpo_markdown: string;
  mensagens: MensagemClienteDto[];
  url_no_chamados: string;
  dado_do_cliente: true;
}

export interface CriarExecucaoDto {
  projeto_id: string;
  chamado_id: string;
  /** Obrigatório quando o chamado está `aguardando_cliente`. */
  confirmar_aguardando_cliente?: boolean;
  /** `PR IA ⚠`: no MVP só "ignorar" (registrado na execução). */
  ignorar_pr_ia?: boolean;
}

export interface ExecucaoCriadaDto {
  execucao_id: string;
  estado: EstadoExecucao;
}

// ===========================================================================
// Execução (06 §4.2)
// ===========================================================================

export const ChaveNoTrilha = {
  preparar: 'preparar',
  planejar: 'planejar',
  decisao: 'decisao',
  implementar: 'implementar',
  verificar: 'verificar',
  revisar: 'revisar',
  relatar: 'relatar',
  aprovacao: 'aprovacao',
  merge: 'merge',
  chamados: 'chamados',
} as const;
export type ChaveNoTrilha = (typeof ChaveNoTrilha)[keyof typeof ChaveNoTrilha];

export type EstadoNoTrilha = 'pendente' | 'atual' | 'feito' | 'falhou' | 'pulado';

export interface NoTrilhaDto {
  chave: ChaveNoTrilha;
  estado: EstadoNoTrilha;
  duracao_ms: number | null;
  custo_micro_usd: number | null;
  modelo: string | null;
  /**
   * "prints antes"/"prints depois" com o badge `UI` (FJ-026); no Merge,
   * "Resolvendo conflito com <destino>" (FJ-036; texto em `detalhe`).
   */
  subnos: {
    chave: 'prints_antes' | 'prints_depois' | 'resolver_conflito';
    estado: EstadoNoTrilha;
    detalhe: string | null;
  }[];
  /** Selo lateral sobre o nó atual (pausado, cota, assumido). */
  lateral: EstadoExecucao | null;
}

export interface EtapaDto {
  id: string;
  n: number;
  ciclo: number;
  tipo: TipoEtapa;
  papel: PapelAgente | null;
  estado: EstadoEtapa;
  motivo_fim: MotivoFimEtapa | null;
  session_id: string | null;
  retomada: boolean;
  modelo: string | null;
  inicio: Iso;
  fim: Iso | null;
  custo_micro_usd: number | null;
  negacoes: number;
  condutor_editou: boolean;
}

export interface PassoPlanoDto {
  id: string;
  descricao: string;
  estado: 'pendente' | 'em_andamento' | 'feito';
  sha_commit: string | null;
}

export interface PlanoExecucaoDto {
  artefato_id: string;
  versao: number;
  plano: PlanoRegistrado;
  editado_por_humano: boolean;
  aprovado_em: Iso | null;
  passos: PassoPlanoDto[];
}

/** Cartão "Decisão necessária" (06 §5.3). */
export interface DecisaoNecessariaDto {
  perguntas: PlanoV1['perguntas_ao_cliente'];
  decisoes: PlanoV1['decisoes_do_operador'];
  rascunho_pergunta: RespostaRegistrada | null;
  pergunta_publicada_em: Iso | null;
  resposta_cliente: MensagemClienteDto | null;
}

export interface MensagemConversaDto {
  id: string;
  autor: 'humano' | 'condutor';
  texto: string;
  em: Iso;
  etapa_id: string;
}

export const AcaoExecucao = {
  pausar: 'pausar',
  retomar: 'retomar',
  conversar: 'conversar',
  assumir: 'assumir',
  devolver: 'devolver',
  parar: 'parar',
  descartar: 'descartar',
  encerrar: 'encerrar',
  tentar_novamente: 'tentar_novamente',
  aprovar_plano: 'aprovar_plano',
  comentar_plano: 'comentar_plano',
  decidir: 'decidir',
  replanejar: 'replanejar',
  mais_um_ciclo: 'mais_um_ciclo',
  seguir_com_achados: 'seguir_com_achados',
  abrir_aprovacao: 'abrir_aprovacao',
  recapturar_prints: 'recapturar_prints',
  reconhecer_sentinela: 'reconhecer_sentinela',
  retomar_mesmo_assim: 'retomar_mesmo_assim',
} as const;
export type AcaoExecucao = (typeof AcaoExecucao)[keyof typeof AcaoExecucao];

export interface SentinelaDto {
  divergencias: string[];
  detectada_em: Iso | null;
  reconhecida_em: Iso | null;
}

export interface ExecucaoDto {
  id: string;
  chamado: ChamadoResumoDto;
  projeto: ProjetoOpcaoDto;
  lote_id: string | null;
  tentativa: number;
  estado: EstadoExecucao;
  grupo: GrupoEstadoExecucao;
  estado_anterior: EstadoExecucao | null;
  motivo_estado: MotivoEstado | null;
  /** Texto pt-BR do motivo (06; cada código tem ações válidas). */
  motivo_texto: string | null;
  branch: string | null;
  branch_destino: string;
  worktree_dir: string | null;
  sha_base: string | null;
  sha_atual: string | null;
  sha_verificado: string | null;
  nivel_verificacao: NivelVerificacao | null;
  ciclo_auto: number;
  ciclo_total: number;
  limites_ciclo: { max_auto: number; max_total: number };
  custo_micro_usd: number;
  iniciado_em: Iso | null;
  concluido_em: Iso | null;
  selos: Selos | null;
  altera_ui: boolean;
  evidencia_visual: EvidenciaVisual | null;
  evidencia_visual_motivo: string | null;
  trilha: NoTrilhaDto[];
  etapas: EtapaDto[];
  plano: PlanoExecucaoDto | null;
  decisao: DecisaoNecessariaDto | null;
  conversa: MensagemConversaDto[];
  /** Motivo de a caixa de conversa estar desabilitada (ex.: sessão assumida). */
  conversa_bloqueada: string | null;
  acoes: AcaoExecucao[];
  /** "Possivelmente travado": último evento há ≥ 15 min (sem kill automático). */
  sem_atividade_desde: Iso | null;
  retoma_em: Iso | null;
  mensagens_novas_cliente: MensagemClienteDto[];
  sessao_assumida: { sessao_terminal_id: string } | null;
  sentinela: SentinelaDto | null;
}

export interface FiltrosFeedDto {
  depois_de_seq?: number;
  antes_de_seq?: number;
  limite?: number;
  modo?: 'marcos' | 'tudo';
  etapa_id?: string;
}

export interface FeedDto {
  eventos: EventoForja[];
  /** Último `seq` entregue: a UI abre o SSE com `Last-Event-ID` = este valor. */
  ultimo_seq: number;
  ha_mais_antigos: boolean;
}

export interface FiltrosTranscriptDto {
  pagina?: number;
}

/** `eventos.jsonl` da etapa, paginado e sem parse "inteligente" (06 §4.2). */
export interface TranscriptDto {
  etapa_id: string;
  pagina: number;
  total_paginas: number;
  linhas: string[];
}

export interface PlanoVersoesDto {
  atual: PlanoExecucaoDto;
  versoes: { artefato_id: string; versao: number; editado_por_humano: boolean; criado_em: Iso }[];
}

export interface AprovarPlanoDto {
  artefato_id: string;
  /** "Editar e aprovar": o plano editado vira o oficial (F-11). */
  plano_editado?: PlanoV1;
}

export interface ComentarPlanoDto {
  texto: string;
}

/** Gdec (06 §5.3): perguntar ao cliente OU o operador decide. */
export type DecidirDto =
  | { modo: 'perguntar_cliente'; texto_pergunta: string; publicar_mesmo_assim?: boolean }
  | {
      modo: 'eu_decido';
      respostas: { tipo: 'pergunta' | 'decisao'; indice: number; resposta: string }[];
    };

export interface ConversarDto {
  texto: string;
}

export interface DescartarDto {
  motivo: string;
  nota_interna: string | null;
  remover_worktree: boolean;
}

export interface EncerrarDto {
  motivo: string;
}

/** Ações de `precisa_humano` conforme o `motivo_estado` (03 §2.4). */
export interface ResolverPendenciaDto {
  acao: 'mais_um_ciclo' | 'seguir_com_achados' | 'replanejar';
  instrucao?: string;
  /** Mais um ciclo após timeout/orçamento exige confirmar o orçamento novo. */
  confirmar_orcamento?: boolean;
}

export interface CienteMensagemDto {
  mensagem_id: string;
}

export interface AssumidoDto {
  sessao_terminal_id: string;
  session_id: string;
}

// ===========================================================================
// Aprovação G2 (06 §4.3)
// ===========================================================================

export const TipoAlertaAprovacao = {
  sentinela: 'sentinela',
  negacoes_permissao: 'negacoes_permissao',
  cliente_escreveu: 'cliente_escreveu',
  conflito_destino: 'conflito_destino',
  relatorio_contradiz: 'relatorio_contradiz',
  ui_sem_prints: 'ui_sem_prints',
  reaprovacao: 'reaprovacao',
  achados_abertos: 'achados_abertos',
  pr_ia: 'pr_ia',
} as const;
export type TipoAlertaAprovacao = (typeof TipoAlertaAprovacao)[keyof typeof TipoAlertaAprovacao];

/** Alertas acima das abas, na ordem fixa de 05 §6.4. */
export interface AlertaAprovacaoDto {
  tipo: TipoAlertaAprovacao;
  nivel: 'aviso' | 'erro';
  mensagem: string;
  detalhes: string[];
}

export interface OpcaoStatusDto {
  valor: PoliticaStatus;
  rotulo: string;
  consequencia: string;
  habilitada: boolean;
}

/** Tipos de aviso do G2 (FJ-034): nenhum bloqueia a aprovação. */
export const TipoAvisoAprovacao = {
  mensagem_nova_cliente: 'mensagem_nova_cliente',
  relatorio_contradiz: 'relatorio_contradiz',
  sem_prints: 'sem_prints',
  achados_abertos: 'achados_abertos',
  conflito_previsto: 'conflito_previsto',
  arquivos_sensiveis: 'arquivos_sensiveis',
  plano: 'plano',
  reaprovacao: 'reaprovacao',
  patch: 'patch',
} as const;
export type TipoAvisoAprovacao = (typeof TipoAvisoAprovacao)[keyof typeof TipoAvisoAprovacao];

/** Aviso empilhado acima de "Aprovar e mergear" (06 §4.3, FJ-034). `patch` é só informativo. */
export interface AvisoAprovacaoDto {
  tipo: TipoAvisoAprovacao;
  mensagem: string;
}

export interface AprovacaoDto {
  execucao_id: string;
  chamado: ChamadoResumoDto;
  /** Versão N do relatório apresentada. */
  versao: number;
  relatorio_artefato_id: string;
  relatorio: RelatorioRegistrado;
  resposta: RespostaRegistrada;
  /** Nome do operador dedicado, autor da mensagem pública (F-20). */
  autor_publico: string | null;
  patch_id: string;
  sha: string;
  branch_destino: string;
  remoto: string | null;
  modo_entrega: ModoEntrega;
  /** Texto fixo, ex.: "merge na main e push para origin" (06 §4.3). */
  descricao_entrega: string;
  revisao: { decisao: string; bloqueantes: number; achados_abertos: number };
  ciclos: { auto: number; humano: number };
  custo_micro_usd: number;
  alertas: AlertaAprovacaoDto[];
  mensagens_novas_cliente: MensagemClienteDto[];
  conflito: { conflita: boolean; sha_destino: string; arquivos: string[] } | null;
  opcoes_status: OpcaoStatusDto[];
  politica_padrao: PoliticaStatus;
  /** FJ-034: avisos (nunca exigências) acima do botão Aprovar e mergear. */
  avisos: AvisoAprovacaoDto[];
  reaprovacao: {
    patch_anterior: string;
    patch_atual: string;
    /** FJ-036: o destino avançou e o agente resolveu o conflito (null = outro motivo). */
    conflito: { destino: string; sha_destino: string; arquivos: string[] } | null;
  } | null;
}

export type SeloArquivo = 'banco' | 'regra_negocio' | 'sensivel' | 'frontend';

export interface DiffArquivoDto {
  caminho: string;
  caminho_anterior: string | null;
  status: 'A' | 'M' | 'D' | 'R';
  adicoes: number;
  remocoes: number;
  selos: SeloArquivo[];
  binario: boolean;
  /** Diff unificado do arquivo (o componente de diff faz o parse). */
  patch: string;
}

export interface FiltrosDiffDto {
  /** Versão do relatório; ausente = atual. */
  versao?: number;
}

export interface DiffDto {
  sha_de: string;
  sha_para: string;
  patch_id: string | null;
  /** Arquivos com selo primeiro (06 §4.3). */
  arquivos: DiffArquivoDto[];
  truncado: boolean;
}

export interface ImagemEvidenciaDto {
  artefato_id: string;
  /** Caminho da rota binária `evidencia_imagem`. */
  url: string;
  largura: number;
  altura: number;
  sha_git: string;
  expirada: boolean;
}

export interface EvidenciaTelaDto {
  tela_id: string;
  descricao: string;
  rota: string;
  /** `o_que_mudou_para_quem_usa` do relatório (escrito pelo agente). */
  o_que_mudou: string | null;
  antes: ImagemEvidenciaDto | null;
  depois: ImagemEvidenciaDto | null;
  resultado_antes: ResultadoTela | null;
  resultado_depois: ResultadoTela | null;
  /** Aviso no lugar da imagem (tela sem par, captura impossível). */
  aviso: string | null;
  /**
   * O `antes/*.png` tem mtime POSTERIOR ao primeiro checkpoint: pode não ser
   * do `sha_base` (FJ-030 §3; 03 §5.4).
   */
  antes_suspeito: boolean;
  /** Por que o agente não fotografou o antes (`telas.json`; ex.: "tela nova"). */
  motivo_sem_antes: string | null;
}

export interface LogComandoDto {
  nome: string;
  exit_code: number | null;
  duracao_ms: number;
  artefato_id: string;
  url: string;
}

export interface EvidenciasDto {
  sha_antes: string | null;
  sha_depois: string | null;
  /**
   * Quem fotografa é o agente (FJ-030 §3): o viewport vem da primeira imagem
   * "depois" (ausente sem imagem); o tema não é controlado pela Forja.
   */
  viewport?: { largura: number; altura: number };
  tema?: 'claro' | 'escuro';
  evidencia_visual: EvidenciaVisual;
  motivo: string | null;
  /** O agente não conseguiu subir o app ou logar (`telas.json.motivo_geral`). */
  motivo_geral: string | null;
  telas: EvidenciaTelaDto[];
  logs: LogComandoDto[];
}

export interface ValidarRespostaDto {
  texto: string;
  tipo: RespostaV1['tipo'];
}

export interface AprovarDto {
  relatorio_artefato_id: string;
  /** Conferido com o atual no servidor (05 §7.1: ação destrutiva). */
  patch_id: string;
  sha: string;
  texto_resposta: string;
  politica_status: PoliticaStatus;
  publicar_mesmo_assim: boolean;
  /**
   * Última mensagem nova do cliente que a tela MOSTRAVA (null = nenhuma). Não é
   * checkbox (FJ-034): só detecta mensagem chegada depois de abrir (→ 409, recarrega).
   */
  ciente_mensagem_id: string | null;
}

export interface PedirAjustesDto {
  comentario: string;
  arquivos?: string[];
}

export interface NegacaoPermissaoDto {
  etapa_n: number;
  ferramenta: string;
  resumo: string;
  em: Iso;
}

/** Aba Técnico (06 §4.3). */
export interface TecnicoDto {
  veredito: VereditoRegistrado | null;
  resumo_impl: ResumoImplRegistrado | null;
  negacoes: NegacaoPermissaoDto[];
  etapas: EtapaDto[];
  branch: string | null;
  sha_base: string | null;
  sha_atual: string | null;
  patch_id: string | null;
  /** Preview da nota interna que o outbox vai publicar. */
  nota_interna_preview: string;
  sentinela: SentinelaDto | null;
}

// ===========================================================================
// Lote e mesa de planos (06 §4.4, §4.5)
// ===========================================================================

export interface CriarLoteDto {
  projeto_id: string;
  chamado_ids: string[];
}

export interface PreviaLoteDto {
  incluidos: ChamadoResumoDto[];
  excluidos: { chamado: ChamadoResumoDto; motivos: string[] }[];
  concorrencia_planos: number;
  concorrencia_impl: number;
}

export interface LoteCriadoDto {
  lote_id: string;
  execucao_ids: string[];
}

export interface LoteResumoDto {
  id: string;
  nome: string;
  projeto_id: string;
  estado: EstadoLote;
  criado_em: Iso;
  encerrado_em: Iso | null;
  total: number;
  por_grupo: Partial<Record<GrupoEstadoExecucao, number>>;
}

export interface LotesDto {
  lotes: LoteResumoDto[];
}

export interface LinhaLoteDto {
  chamado: ChamadoResumoDto;
  execucao: ExecucaoResumoDto;
  mini_trilha: NoTrilhaDto[];
  observacao: string | null;
  acao: LinkAcaoDto | null;
}

export interface LoteDto {
  lote: LoteResumoDto & { concorrencia_planos: number; concorrencia_impl: number };
  linhas: LinhaLoteDto[];
  schema_em_voo: { execucao_id: string; numero: number } | null;
  freio: CotaDto['freio'];
  /** "5h 23% → 61% (freio 80%)". */
  projecao_5h: { atual: number; estimada: number; limiar: number } | null;
}

export type ClasseCartaoPlano =
  'limpo' | 'decisao' | 'schema' | 'alerta_seguranca' | 'precisa_revisao' | 'planejando' | 'erro';

export interface CartaoPlanoDto {
  execucao_id: string;
  chamado: ChamadoResumoDto;
  estado: EstadoExecucao;
  classe: ClasseCartaoPlano;
  plano: PlanoRegistrado | null;
  /** Uma linha para o diálogo "Aprovar limpos". */
  resumo_linha: string | null;
  planejando_desde: Iso | null;
  erro: string | null;
  /** Posição na espera do token de schema (só 1 em voo). */
  posicao_schema: number | null;
  /**
   * Artefato do plano exibido (entrada de `execucao_aprovar_plano`). Opcional
   * por compatibilidade: ausente, a mesa consulta `execucao_plano` antes de aprovar.
   */
  plano_artefato_id?: string | null;
}

export interface MesaPlanosDto {
  lote_id: string;
  nome: string;
  total: number;
  prontos: number;
  planejando: number;
  concorrencia_planos: number;
  cartoes: CartaoPlanoDto[];
  /** Interseção de `arquivos_previstos` (informativo no MVP). */
  arquivos_em_comum: { arquivo: string; numeros: number[] }[];
}

export interface AprovarLimposDto {
  execucao_ids: string[];
}

export interface CancelarPendentesDto {
  execucao_ids: string[];
}

// ===========================================================================
// Fila de merge (06 §4.6)
// ===========================================================================

export type ChavePassoIntegracao =
  'integrar' | 'reverificar' | 'conferir_patch' | 'avancar_ref' | 'push';

export interface ItemFilaMergeDto {
  id: string;
  ordem: number;
  execucao_id: string;
  numero: number;
  titulo: string;
  patch_id: string;
  estado: EstadoItemFilaMerge;
  motivo: string | null;
  passos: { chave: ChavePassoIntegracao; estado: EstadoNoTrilha; detalhe: string | null }[];
  sha_destino_antes: string | null;
  copia_local_atras: boolean;
}

export interface FilaMergeDestinoDto {
  projeto_id: string;
  projeto_nome: string;
  branch_destino: string;
  remoto: string | null;
  modo_entrega: ModoEntrega;
  itens: ItemFilaMergeDto[];
  /** "Sua cópia local está na main e com alterações…" (X-3). */
  aviso_copia_local: string | null;
}

export interface PendenciaChamadosDto {
  execucao_id: string;
  numero: number;
  sha_merge: string | null;
  passo: PassoOutbox;
  erro: string;
  ultimo_http: number | null;
  proxima_em: Iso | null;
}

export interface APublicarDto {
  execucao_id: string;
  numero: number;
  titulo: string;
  sha_merge: string;
}

export interface ConcluidoRecenteDto {
  execucao_id: string;
  numero: number;
  titulo: string;
  status_final: StatusChamado;
  concluido_em: Iso;
  url_no_chamados: string;
}

export interface FilaMergeDto {
  filas: FilaMergeDestinoDto[];
  pendencias_chamados: PendenciaChamadosDto[];
  a_publicar: APublicarDto[];
  concluidos_recentes: ConcluidoRecenteDto[];
  /** "#N segura o token de schema" (03 §7.3). */
  token_schema: { projeto_id: string; execucao_id: string; numero: number; preso: boolean } | null;
  sentinelas: { projeto_id: string; execucao_id: string; numero: number; divergencias: string[] }[];
}

export interface FiltrosFilaMergeDto {
  projeto_id?: string;
}

export interface ReordenarItemDto {
  nova_ordem: number;
}

export interface PublicadoProducaoDto {
  execucao_ids: string[];
}

export interface LiberarTokenSchemaDto {
  projeto_id: string;
}

// ===========================================================================
// Projeto (06 §4.8; 02 §4.2; FJ-030 §1, §2)
// ===========================================================================

/**
 * Script do projeto (detectado ou do Avançado). Desde FJ-032 é só DICA ao
 * agente ("scripts encontrados"): a Forja nunca o executa.
 */
export interface ComandoProjetoDto {
  nome: string;
  comando: string;
  timeout_s: number;
}

export interface ComandoSimplesDto {
  comando: string;
  timeout_s: number;
}

export interface ModeloEsforcoDto {
  modelo: string;
  esforco: string;
}

/** Dicas para o agente (FJ-032): nada aqui é executado pelo app. */
export interface ComandosProjetoDto {
  dependencias: 'instalar';
  /** Instalação de dependências (autodetectada pelo lockfile, FJ-030 §1). Dica. */
  setup: ComandoSimplesDto | null;
  verificacao: ComandoProjetoDto[];
  e2e: ComandoSimplesDto | null;
  /** Só DICA ao agente (FJ-030 §3): quem sobe o app para os prints é ele. */
  app_subir: ComandoSimplesDto | null;
  healthcheck: { caminho: string; status: number; timeout_s: number } | null;
}

export interface DetectoresProjetoDto {
  banco: string[];
  regra_negocio: string[];
  sensivel: string[];
  docs_exigidas: string[];
  frontend: string[];
}

export interface ArquivoLocalDto {
  origem: string;
  destino: string;
  modo: 'copiar';
}

export interface EntregaProjetoDto {
  modo: ModoEntrega;
  estrategia: EstrategiaIntegracao;
  /** Merge = deploy? (U-5, default false → resposta "aguardando_publicacao"). */
  merge_publica: boolean;
  avanco_com_copia_suja: 'push_direto' | 'bloquear';
}

export interface PoliticaStatusProjetoDto {
  ao_concluir: PoliticaStatus;
  motivo: string;
}

export interface LimitesProjetoDto {
  concorrencia: {
    agentes: number;
    planejadores: number;
    schema_em_voo: number;
  };
  ciclos: { max_auto: number; max_total: number };
  orcamento_usd: {
    planejar: number;
    implementar: number;
    revisar: number;
    relatar: number;
    por_chamado: number;
  };
  timeout_min: {
    planejar: number;
    implementar: number;
    revisar: number;
    relatar: number;
    aviso_inatividade: number;
  };
  freio_cota: { five_hour: number; seven_day: number; permitir_creditos_extras: boolean };
}

/** FJ-034: só o gate do plano; o G2 não tem exigências configuráveis. */
export interface GatesProjetoDto {
  plano: GatePlano;
}

export interface ModoReforcadoDto {
  ligado: boolean;
  sandbox: { allow_read_extra: string[] };
  rede_agente: string[];
  verificacao_bwrap: boolean;
}

export interface RetencaoProjetoDto {
  worktree_descartada_dias: number;
  worktree_falha_dias: number;
  eventos_brutos_dias: number;
  evidencias_dias: number;
}

/**
 * Configuração RESOLVIDA (FJ-030 §1): projeto (v2) + configurações globais +
 * autodetecção. É o `execucao.config_snapshot` (F-05) e o bloco "Detectado"
 * da tela Projeto. Nunca é editada inteira: o que o humano muda vai em
 * `ConfigProjetoDto` (básico) ou `avancado`.
 */
export interface ConfigResolvidaDto {
  repo: { dir: string; remoto: string | null; branch_destino: string; prefixo_branch: string };
  entrega: EntregaProjetoDto;
  politica_status: PoliticaStatusProjetoDto;
  comandos: ComandosProjetoDto;
  arquivos_locais: ArquivoLocalDto[];
  detectores: DetectoresProjetoDto;
  modelos: {
    planejador: ModeloEsforcoDto;
    condutor: ModeloEsforcoDto;
    subagentes: { modelo: string; esforco_implementador: string; esforco_revisor: string };
  };
  limites: LimitesProjetoDto;
  gates: GatesProjetoDto;
  modo_reforcado: ModoReforcadoDto;
  retencao: RetencaoProjetoDto;
}

/**
 * "Avançado" do projeto (FJ-030 §1): tudo opcional; ausência = autodetecção ou
 * configuração global. Editado como texto (JSON) na tela Projeto e validado
 * pelo zod `AvancadoProjetoSchema` (estrito: chave desconhecida é erro).
 * Listas (`verificacao`, globs, `arquivos_locais`) SUBSTITUEM a detectada.
 */
export interface AvancadoProjetoDto {
  repo?: { remoto?: string | null; prefixo_branch?: string };
  comandos?: Partial<ComandosProjetoDto>;
  detectores?: Partial<DetectoresProjetoDto>;
  arquivos_locais?: ArquivoLocalDto[];
  entrega?: Partial<EntregaProjetoDto>;
  politica_status?: Partial<PoliticaStatusProjetoDto>;
  gates?: Partial<GatesProjetoDto>;
  limites?: {
    concorrencia?: Partial<LimitesProjetoDto['concorrencia']>;
    ciclos?: Partial<LimitesProjetoDto['ciclos']>;
    orcamento_usd?: Partial<LimitesProjetoDto['orcamento_usd']>;
    timeout_min?: Partial<LimitesProjetoDto['timeout_min']>;
    freio_cota?: Partial<LimitesProjetoDto['freio_cota']>;
  };
  modo_reforcado?: {
    ligado?: boolean;
    sandbox?: { allow_read_extra?: string[] };
    rede_agente?: string[];
    verificacao_bwrap?: boolean;
  };
  retencao?: Partial<RetencaoProjetoDto>;
}

/** Configuração do projeto v2 (FJ-030 §1): só `repo_dir` é obrigatório de fato. */
export interface ConfigProjetoDto {
  versao: 2;
  /** Default: basename de `repo_dir`. */
  nome: string;
  repo_dir: string;
  /** Ausente = autodetectada (origin/HEAD → main → master → branch atual). */
  branch_destino?: string;
  /**
   * Sistemas-alvo do Chamados (ids; nome quando o servidor não expõe id).
   * Ausente = casamento automático por nome normalizado (`casamento_sistemas`).
   */
  sistemas?: string[];
  avancado?: AvancadoProjetoDto;
}

/** Resultado da autodetecção sobre o repositório (FJ-030 §1). Somente leitura na UI. */
export interface ProjetoDetectadoDto {
  detectado_em: Iso;
  /** `git rev-parse --show-toplevel` (o `repo_dir` normalizado). */
  repo_dir: string;
  branch_destino: string | null;
  origem_branch: 'origin_head' | 'main' | 'master' | 'atual' | null;
  remoto: string | null;
  gerenciador: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  lockfile: string | null;
  workspaces: boolean;
  comandos: ComandosProjetoDto;
  detectores: DetectoresProjetoDto;
  arquivos_locais: ArquivoLocalDto[];
  /** O que não deu para detectar (sem `package.json`, sem branch…). */
  avisos: string[];
}

/** Um sistema-alvo do Chamados e se ele aponta para este projeto (toggles da tela). */
export interface SistemaCasadoDto {
  sistema_nome: string;
  sistema_alvo_id: string | null;
  /** Mapeado para este projeto agora. */
  ligado: boolean;
  /** O casamento por nome sugere este sistema (FJ-030 §1). */
  sugerido: boolean;
  /** Mapeado para OUTRO projeto da mesma conexão (não pode ligar aqui). */
  outro_projeto: string | null;
}

export interface ProjetoResumoDto {
  id: string;
  nome: string;
  slug: string;
  conexao_id: string;
  conexao_nome: string;
  ativo: boolean;
  /** Efetiva (configurada ou detectada). */
  branch_destino: string;
  sistemas: string[];
}

export interface ProjetosDto {
  projetos: ProjetoResumoDto[];
}

export interface ProjetoDto extends ProjetoResumoDto {
  config_versao: number;
  config: ConfigProjetoDto;
  /** Autodetecção mais recente (refeita ao abrir a tela). */
  detectado: ProjetoDetectadoDto;
  /** O que uma execução nova usaria agora (`config_snapshot`). */
  resolvida: ConfigResolvidaDto;
  casamento_sistemas: SistemaCasadoDto[];
  versao_cli_fixada: string | null;
  mapeamentos: { id: string; sistema_nome: string; sistema_alvo_id: string | null }[];
  /** Sistemas-alvo vistos na fila, para mapear. */
  sistemas_vistos: string[];
  /** Só leitura: `<dados>/worktrees/<slug>` (02 §7). */
  pasta_worktrees: string;
}

export interface SalvarProjetoDto {
  config: ConfigProjetoDto;
  /** Default: a única conexão (ou a primeira). */
  conexao_id?: string;
  /** Default: `true`. */
  ativo?: boolean;
  /** Default: derivado do nome. */
  slug?: string;
  versao_cli_fixada?: string | null;
}

export interface ProjetoSalvoDto {
  id: string;
}

/** Onboarding / "Escolher pasta…": valida o repositório e mostra o detectado (FJ-030 §5). */
export interface DetectarProjetoDto {
  repo_dir: string;
  /** Para o casamento de sistemas (default: a única conexão). */
  conexao_id?: string;
}

export interface DeteccaoProjetoDto {
  valido: boolean;
  /** Mensagem legível quando `valido = false` (não é repositório git, pasta inexistente…). */
  erro: string | null;
  nome_sugerido: string;
  detectado: ProjetoDetectadoDto | null;
  casamento_sistemas: SistemaCasadoDto[];
}

export interface TestarDetectoresDto {
  sha: string;
}

export interface ResultadoDetectoresDto {
  selos: Selos;
  por_arquivo: { caminho: string; selos: SeloArquivo[] }[];
}

// ===========================================================================
// Configurações globais (FJ-030 §2) — `<dados>/configuracoes.json`
// ===========================================================================

export interface ConfiguracoesGlobaisDto {
  versao: 1;
  modelos: {
    /** Planejador e condutor. */
    orquestrador: ModeloEsforcoDto;
    /** Implementadores e revisores. */
    subagentes: ModeloEsforcoDto;
  };
  cota: { five_hour: number; seven_day: number; permitir_creditos_extras: boolean };
  concorrencia: { implementacoes: number; planejadores: number };
  limites: {
    ciclos: LimitesProjetoDto['ciclos'];
    orcamento_usd: LimitesProjetoDto['orcamento_usd'];
    timeout_min: LimitesProjetoDto['timeout_min'];
  };
  gates: GatesProjetoDto;
}

export interface ConfiguracoesDto {
  configuracoes: ConfiguracoesGlobaisDto;
  /** Os padrões (o "Restaurar padrões" volta a eles). */
  padrao: ConfiguracoesGlobaisDto;
  /** Caminho do arquivo (só exibição). */
  arquivo: string;
}

// ===========================================================================
// Conexão (06 §4.9) — o token nunca aparece aqui
// ===========================================================================

export interface UsuarioConexaoDto {
  id: string;
  nome: string;
  papel: string;
}

export const CodigoErroConexao = {
  credencial_invalida: 'credencial_invalida',
  limite_login: 'limite_login',
  rede: 'rede',
  tls: 'tls',
  tenant_inexistente: 'tenant_inexistente',
  papel_recusado: 'papel_recusado',
  url_loopback_ip: 'url_loopback_ip',
  outro: 'outro',
} as const;
export type CodigoErroConexao = (typeof CodigoErroConexao)[keyof typeof CodigoErroConexao];

export interface ConexaoDto {
  id: string;
  nome: string;
  url_base: string;
  tenant_slug: string | null;
  ambiente: AmbienteConexao;
  email: string;
  usuario: UsuarioConexaoDto | null;
  local_senha: LocalSenha;
  token_valido_ate: Iso | null;
  ultimo_login_em: Iso | null;
  estado: 'ok' | 'sem_login' | 'erro';
  erro: { codigo: CodigoErroConexao; mensagem: string } | null;
  avisos: string[];
}

export interface ConexoesDto {
  conexoes: ConexaoDto[];
}

export interface SalvarConexaoDto {
  nome: string;
  url_base: string;
  tenant_slug: string | null;
  ambiente: AmbienteConexao;
  email: string;
  /** Vai direto ao keyring (ou arquivo 0600); nunca volta em DTO. */
  senha?: string;
  local_senha: LocalSenha;
}

export interface ConexaoSalvaDto {
  id: string;
}

export interface TesteConexaoDto {
  ok: boolean;
  usuario: UsuarioConexaoDto | null;
  papel_aceito: boolean;
  aviso: string | null;
  token_valido_ate: Iso | null;
  erro: { codigo: CodigoErroConexao; mensagem: string } | null;
}

export interface RelogarDto {
  senha?: string;
}

// ===========================================================================
// Diagnóstico (06 §4.10)
// ===========================================================================

export interface ItemDiagnosticoDto {
  codigo: string;
  titulo: string;
  estado: 'ok' | 'aviso' | 'erro' | 'pendente';
  detalhe: string;
  bloqueia: 'pipeline' | 'execucoes' | 'terminal' | 'modo_reforcado' | null;
  acao: LinkAcaoDto | null;
}

export interface DiagnosticoDto {
  verificado_em: Iso | null;
  itens: ItemDiagnosticoDto[];
  pipeline_bloqueado: boolean;
  /** Faixa permanente "Os agentes rodam sem sandbox…" ou "modo reforçado ativo em…". */
  faixa: string;
  versao_cli: { encontrada: string | null; fixada: string; smoke_aprovado: boolean };
}

export interface AceitarVersaoCliDto {
  versao: string;
}

// ===========================================================================
// Histórico e Worktrees (06 §4.11; métricas de 00 §10)
// ===========================================================================

export interface FiltrosHistoricoDto {
  projeto_id?: string;
  de?: Iso;
  ate?: Iso;
  resultado?: ('concluido' | 'descartado' | 'cancelado')[];
}

export interface LinhaHistoricoDto {
  execucao_id: string;
  numero: number;
  titulo: string;
  projeto_nome: string;
  estado: EstadoExecucao;
  iniciado_em: Iso | null;
  concluido_em: Iso | null;
  custo_micro_usd: number;
  ciclo_total: number;
  patch_id: string | null;
  sha_merge: string | null;
  prints_expirados: boolean;
}

export interface MetricasHistoricoDto {
  taxa_aprovacao_sem_ajuste: number | null;
  ciclos_medios: { auto: number; humano: number } | null;
  custo_medio_micro_usd: number | null;
  tempo_ate_aguardando_ms: number | null;
  taxa_pergunta_cliente: number | null;
  taxa_conclusao: number | null;
  taxa_incoerencia_relatorio: number | null;
  taxa_condutor_editou: number | null;
  taxa_mensagem_barrada: number | null;
}

export interface HistoricoDto {
  itens: LinhaHistoricoDto[];
  metricas: MetricasHistoricoDto;
}

export interface WorktreeDto {
  caminho: string;
  branch: string | null;
  execucao_id: string | null;
  numero: number | null;
  estado_execucao: EstadoExecucao | null;
  tamanho_bytes: number | null;
  ultima_atividade: Iso | null;
  orfa: boolean;
  prunable: boolean;
  /** Projeto da worktree: "Abrir no terminal" e "Novo chat na worktree" precisam dele (06 §4.7, §4.11). */
  projeto_id?: string | null;
}

export interface WorktreesDto {
  worktrees: WorktreeDto[];
  total_bytes: number;
}

export interface LimparWorktreeDto {
  caminho: string;
  apagar_branch: boolean;
}

/** "Apagar dados deste chamado…" (05 §11): confirmação pelo número. */
export interface ApagarDadosDto {
  confirmar_numero: number;
}

export interface DadosApagadosDto {
  apagados: string[];
}

// ===========================================================================
// Terminal (06 §4.7, 01 §11)
// ===========================================================================

export interface SessaoTerminalDto {
  id: string;
  tipo: TipoSessaoTerminal;
  /** "#120 · implementar (assumida)". */
  titulo: string;
  cwd: string;
  execucao_id: string | null;
  numero: number | null;
  etapa_tipo: TipoEtapa | null;
  session_id_claude: string | null;
  viva: boolean;
  aberta_em: Iso;
  encerrada_em: Iso | null;
}

export interface SessoesTerminalDto {
  sessoes: SessaoTerminalDto[];
  /** Teto de PTYs simultâneos (padrão 4). */
  limite: number;
}

export interface AbrirTerminalDto {
  projeto_id: string;
  /** Ausente = repositório do projeto; presente = worktree da execução. */
  execucao_id?: string;
}

export interface TerminalAbertoDto {
  sessao_id: string;
}

/**
 * Mensagens de controle do WebSocket do PTY (01 §8.1). Bytes do terminal vão
 * crus (frames binários); controle vai como frame de texto JSON.
 */
export type ControleTerminalCliente = { tipo: 'redimensionar'; colunas: number; linhas: number };
export type ControleTerminalServidor =
  | { tipo: 'encerrado'; codigo: number | null; sinal: string | null }
  | { tipo: 'scrollback_inicio' }
  | { tipo: 'scrollback_fim' };

// ===========================================================================
// ROTAS_API: lista canônica (método + caminho + DTO de entrada/saída)
// ===========================================================================

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** `json` = requisição/resposta JSON; `sse` = stream de eventos; `ws` = WebSocket do PTY; `binario` = arquivo. */
export type TransporteRota = 'json' | 'sse' | 'ws' | 'binario';

/** Telas de 06 §2 (+ `shell` para o que é global). */
export const TelaForja = {
  shell: 'shell',
  fila: 'fila',
  execucao: 'execucao',
  aprovacao: 'aprovacao',
  mesa_planos: 'mesa_planos',
  lotes: 'lotes',
  lote: 'lote',
  fila_merge: 'fila_merge',
  terminal: 'terminal',
  projetos: 'projetos',
  projeto: 'projeto',
  conexao: 'conexao',
  configuracoes: 'configuracoes',
  diagnostico: 'diagnostico',
  historico: 'historico',
  worktrees: 'worktrees',
} as const;
export type TelaForja = (typeof TelaForja)[keyof typeof TelaForja];

export interface DefRota {
  metodo: MetodoHttp;
  /** Padrão Fastify/React Router: `:param`. Sempre sob `/api`. */
  caminho: `/api${string}`;
  transporte: TransporteRota;
  tela: TelaForja;
  descricao: string;
}

/** Sem entrada. */
export type SemEntrada = Record<string, never>;

/**
 * Tipos de cada rota. A chave é o NOME da rota (usado pelo servidor para
 * registrar o handler e pela SPA para chamar). `ROTAS_API` abaixo precisa ter
 * exatamente as mesmas chaves (garantido pelo `satisfies`).
 */
export interface ContratoRotas {
  // --- shell / global
  saude: { entrada: SemEntrada; saida: SaudeDto };
  shell_obter: { entrada: SemEntrada; saida: ShellDto };
  uso_obter: { entrada: SemEntrada; saida: UsoDto };
  eventos_global: { entrada: SemEntrada; saida: EventoForja };
  // --- fila
  fila_listar: { entrada: FiltrosFilaDto; saida: FilaDto };
  fila_sincronizar: { entrada: SincronizarFilaDto; saida: SincronizacaoDto };
  chamado_obter: { entrada: SemEntrada; saida: DetalheChamadoDto };
  execucao_criar: { entrada: CriarExecucaoDto; saida: ExecucaoCriadaDto };
  // --- execução
  execucao_obter: { entrada: SemEntrada; saida: ExecucaoDto };
  execucao_feed: { entrada: FiltrosFeedDto; saida: FeedDto };
  execucao_eventos: { entrada: SemEntrada; saida: EventoForja };
  execucao_transcript: { entrada: FiltrosTranscriptDto; saida: TranscriptDto };
  execucao_plano: { entrada: SemEntrada; saida: PlanoVersoesDto };
  execucao_aprovar_plano: { entrada: AprovarPlanoDto; saida: ComandoAceitoDto };
  execucao_comentar_plano: { entrada: ComentarPlanoDto; saida: ComandoAceitoDto };
  execucao_decidir: { entrada: DecidirDto; saida: ComandoAceitoDto };
  execucao_replanejar: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_pausar: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_retomar: { entrada: { mesmo_assim?: boolean }; saida: ComandoAceitoDto };
  execucao_parar: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_conversar: { entrada: ConversarDto; saida: ComandoAceitoDto };
  execucao_assumir: { entrada: SemEntrada; saida: AssumidoDto };
  execucao_devolver: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_descartar: { entrada: DescartarDto; saida: ComandoAceitoDto };
  execucao_encerrar: { entrada: EncerrarDto; saida: ComandoAceitoDto };
  execucao_tentar_novamente: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_resolver_pendencia: { entrada: ResolverPendenciaDto; saida: ComandoAceitoDto };
  execucao_ciente_mensagem: { entrada: CienteMensagemDto; saida: ComandoAceitoDto };
  execucao_recapturar_prints: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_reconhecer_sentinela: { entrada: SemEntrada; saida: ComandoAceitoDto };
  execucao_apagar_dados: { entrada: ApagarDadosDto; saida: DadosApagadosDto };
  // --- aprovação (G2)
  aprovacao_obter: { entrada: SemEntrada; saida: AprovacaoDto };
  aprovacao_diff: { entrada: FiltrosDiffDto; saida: DiffDto };
  aprovacao_interdiff: { entrada: SemEntrada; saida: DiffDto };
  aprovacao_evidencias: { entrada: SemEntrada; saida: EvidenciasDto };
  aprovacao_tecnico: { entrada: SemEntrada; saida: TecnicoDto };
  evidencia_imagem: { entrada: SemEntrada; saida: Blob };
  artefato_log: { entrada: SemEntrada; saida: Blob };
  aprovacao_validar_resposta: { entrada: ValidarRespostaDto; saida: ValidacaoResposta };
  aprovacao_aprovar: { entrada: AprovarDto; saida: ComandoAceitoDto };
  aprovacao_pedir_ajustes: { entrada: PedirAjustesDto; saida: ComandoAceitoDto };
  // --- lotes e mesa de planos
  lotes_listar: { entrada: SemEntrada; saida: LotesDto };
  lote_previa: { entrada: CriarLoteDto; saida: PreviaLoteDto };
  lote_criar: { entrada: CriarLoteDto; saida: LoteCriadoDto };
  lote_obter: { entrada: SemEntrada; saida: LoteDto };
  lote_planos: { entrada: SemEntrada; saida: MesaPlanosDto };
  lote_aprovar_limpos: { entrada: AprovarLimposDto; saida: ComandoAceitoDto };
  lote_pausar: { entrada: SemEntrada; saida: ComandoAceitoDto };
  lote_cancelar_pendentes: { entrada: CancelarPendentesDto; saida: ComandoAceitoDto };
  // --- fila de merge e outbox
  merge_obter: { entrada: FiltrosFilaMergeDto; saida: FilaMergeDto };
  merge_reordenar: { entrada: ReordenarItemDto; saida: ComandoAceitoDto };
  merge_publicado_producao: { entrada: PublicadoProducaoDto; saida: ComandoAceitoDto };
  merge_liberar_token_schema: { entrada: LiberarTokenSchemaDto; saida: ComandoAceitoDto };
  outbox_tentar_agora: { entrada: SemEntrada; saida: ComandoAceitoDto };
  // --- projetos
  projetos_listar: { entrada: SemEntrada; saida: ProjetosDto };
  projeto_obter: { entrada: SemEntrada; saida: ProjetoDto };
  projeto_criar: { entrada: SalvarProjetoDto; saida: ProjetoSalvoDto };
  projeto_atualizar: { entrada: SalvarProjetoDto; saida: ProjetoSalvoDto };
  projeto_testar_detectores: { entrada: TestarDetectoresDto; saida: ResultadoDetectoresDto };
  projeto_detectar: { entrada: DetectarProjetoDto; saida: DeteccaoProjetoDto };
  // --- configurações globais (FJ-030 §2)
  configuracoes_obter: { entrada: SemEntrada; saida: ConfiguracoesDto };
  configuracoes_gravar: { entrada: ConfiguracoesGlobaisDto; saida: ConfiguracoesDto };
  configuracoes_restaurar: { entrada: SemEntrada; saida: ConfiguracoesDto };
  // --- conexão
  conexoes_listar: { entrada: SemEntrada; saida: ConexoesDto };
  conexao_criar: { entrada: SalvarConexaoDto; saida: ConexaoSalvaDto };
  conexao_atualizar: { entrada: SalvarConexaoDto; saida: ConexaoSalvaDto };
  conexao_testar: { entrada: SemEntrada; saida: TesteConexaoDto };
  conexao_relogar: { entrada: RelogarDto; saida: TesteConexaoDto };
  conexao_esquecer: { entrada: SemEntrada; saida: ComandoAceitoDto };
  // --- diagnóstico
  diagnostico_obter: { entrada: SemEntrada; saida: DiagnosticoDto };
  diagnostico_rodar: { entrada: SemEntrada; saida: DiagnosticoDto };
  diagnostico_aceitar_versao_cli: { entrada: AceitarVersaoCliDto; saida: DiagnosticoDto };
  // --- histórico e worktrees
  historico_listar: { entrada: FiltrosHistoricoDto; saida: HistoricoDto };
  worktrees_listar: { entrada: SemEntrada; saida: WorktreesDto };
  worktree_limpar: { entrada: LimparWorktreeDto; saida: ComandoAceitoDto };
  // --- terminal
  terminal_sessoes: { entrada: SemEntrada; saida: SessoesTerminalDto };
  terminal_abrir: { entrada: AbrirTerminalDto; saida: TerminalAbertoDto };
  terminal_encerrar: { entrada: SemEntrada; saida: ComandoAceitoDto };
  terminal_reabrir: { entrada: SemEntrada; saida: TerminalAbertoDto };
  terminal_ws: { entrada: SemEntrada; saida: ControleTerminalServidor };
}

export const ROTAS_API = {
  // --- shell / global
  saude: {
    metodo: 'GET',
    caminho: '/api/saude',
    transporte: 'json',
    tela: 'shell',
    descricao: 'Servidor de pé (sem dados; só exige Host válido)',
  },
  shell_obter: {
    metodo: 'GET',
    caminho: '/api/shell',
    transporte: 'json',
    tela: 'shell',
    descricao: 'Cabeçalho, sidebar e banners (06 §1)',
  },
  uso_obter: {
    metodo: 'GET',
    caminho: '/api/uso',
    transporte: 'json',
    tela: 'shell',
    descricao: 'Detalhe de cota e custo do dia por execução e modelo',
  },
  eventos_global: {
    metodo: 'GET',
    caminho: '/api/eventos',
    transporte: 'sse',
    tela: 'shell',
    descricao: 'SSE global: estados, cota, sinais, alertas, fila de merge (01 §8.1)',
  },
  // --- fila
  fila_listar: {
    metodo: 'GET',
    caminho: '/api/fila',
    transporte: 'json',
    tela: 'fila',
    descricao: 'Chamados implementáveis do projeto, com sinais e pré-condições',
  },
  fila_sincronizar: {
    metodo: 'POST',
    caminho: '/api/fila/sincronizar',
    transporte: 'json',
    tela: 'fila',
    descricao: 'Relê a lista do Chamados agora',
  },
  chamado_obter: {
    metodo: 'GET',
    caminho: '/api/chamados/:chamado_id',
    transporte: 'json',
    tela: 'fila',
    descricao: 'Detalhe do chamado (painel lateral, dado do cliente)',
  },
  execucao_criar: {
    metodo: 'POST',
    caminho: '/api/execucoes',
    transporte: 'json',
    tela: 'fila',
    descricao: 'Implementar (G0): cria a execução em na_fila',
  },
  // --- execução
  execucao_obter: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Trilha, plano, etapas, conversa e ações disponíveis',
  },
  execucao_feed: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/feed',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Página do feed persistido (antes de abrir o SSE)',
  },
  execucao_eventos: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/eventos',
    transporte: 'sse',
    tela: 'execucao',
    descricao: 'SSE do feed completo da execução (01 §8.1)',
  },
  execucao_transcript: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/etapas/:etapa_id/transcript',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'eventos.jsonl bruto da etapa, paginado',
  },
  execucao_plano: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/plano',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Plano atual e versões (sheet "Plano completo")',
  },
  execucao_aprovar_plano: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/plano/aprovar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'G1: aprovar (ou editar e aprovar) o plano',
  },
  execucao_comentar_plano: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/plano/comentar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'G1: comentar e replanejar',
  },
  execucao_decidir: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/decisao',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Gdec: perguntar ao cliente ou o operador decide',
  },
  execucao_replanejar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/replanejar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Cliente respondeu: move para em_atendimento e retoma o planejador',
  },
  execucao_pausar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/pausar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Pausar (SIGINT) e habilitar a conversa',
  },
  execucao_retomar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/retomar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Retomar a etapa (reenvia o prompt com o schema)',
  },
  execucao_parar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/parar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Parar: escada de sinais no grupo → pausado_usuario',
  },
  execucao_conversar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/conversa',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Mensagem ao condutor (claude -p --resume, sem schema)',
  },
  execucao_assumir: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/assumir',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Assumir no terminal (lock da sessão)',
  },
  execucao_devolver: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/devolver',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Devolver ao pipeline: commit manual → verificar',
  },
  execucao_descartar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/descartar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Descartar a tentativa (nota interna opcional)',
  },
  execucao_encerrar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/encerrar',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'Encerrar sem trabalho a preservar → cancelado',
  },
  execucao_tentar_novamente: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/tentar-novamente',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'falhou/interrompido: recomeça a etapa',
  },
  execucao_resolver_pendencia: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/pendencia',
    transporte: 'json',
    tela: 'execucao',
    descricao: 'precisa_humano: mais um ciclo, seguir com achados, replanejar',
  },
  execucao_ciente_mensagem: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/ciente-mensagem',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: '"Li a mensagem nova" do cliente',
  },
  execucao_recapturar_prints: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/recapturar-prints',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Coleta de novo os prints de evidencias/ no mesmo sha (FJ-026, FJ-030 §3)',
  },
  execucao_reconhecer_sentinela: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/sentinela/reconhecer',
    transporte: 'json',
    tela: 'fila_merge',
    descricao: 'Reconhecer divergência da sentinela (destrava sem desfazer)',
  },
  execucao_apagar_dados: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/apagar-dados',
    transporte: 'json',
    tela: 'historico',
    descricao: 'Apagar dados do cliente desta execução (05 §11)',
  },
  // --- aprovação
  aprovacao_obter: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/aprovacao',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Relatório, selos, alertas, resposta e opções de status',
  },
  aprovacao_diff: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/diff',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Diff do patch apresentado (arquivos de selo primeiro)',
  },
  aprovacao_interdiff: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/interdiff',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Diff bruto entre a versão anterior e a atual',
  },
  aprovacao_evidencias: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/evidencias',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Prints antes/depois por tela e logs da verificação',
  },
  aprovacao_tecnico: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/tecnico',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Veredito, negações, sessões, custos e nota interna',
  },
  evidencia_imagem: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/evidencias/:artefato_id/imagem',
    transporte: 'binario',
    tela: 'aprovacao',
    descricao: 'PNG de um print (sha256 conferido ao servir)',
  },
  artefato_log: {
    metodo: 'GET',
    caminho: '/api/execucoes/:id/artefatos/:artefato_id/log',
    transporte: 'binario',
    tela: 'aprovacao',
    descricao: 'Log de um comando (texto)',
  },
  aprovacao_validar_resposta: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/resposta/validar',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Validador de linguagem ao vivo (04 §8)',
  },
  aprovacao_aprovar: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/aprovar',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'G2: aprovar e mergear (amarrado ao patch-id)',
  },
  aprovacao_pedir_ajustes: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/pedir-ajustes',
    transporte: 'json',
    tela: 'aprovacao',
    descricao: 'Pedir ajustes → retrabalho_humano',
  },
  // --- lotes
  lotes_listar: {
    metodo: 'GET',
    caminho: '/api/lotes',
    transporte: 'json',
    tela: 'lotes',
    descricao: 'Lotes e contadores por grupo de estado',
  },
  lote_previa: {
    metodo: 'POST',
    caminho: '/api/lotes/previa',
    transporte: 'json',
    tela: 'fila',
    descricao: 'Diálogo "Implementar em lote": incluídos e excluídos por pré-condição',
  },
  lote_criar: {
    metodo: 'POST',
    caminho: '/api/lotes',
    transporte: 'json',
    tela: 'fila',
    descricao: 'Cria o lote (G0 em bloco) e vai para a mesa de planos',
  },
  lote_obter: {
    metodo: 'GET',
    caminho: '/api/lotes/:id',
    transporte: 'json',
    tela: 'lote',
    descricao: 'Linhas do lote, schema em voo e freio de cota',
  },
  lote_planos: {
    metodo: 'GET',
    caminho: '/api/lotes/:id/planos',
    transporte: 'json',
    tela: 'mesa_planos',
    descricao: 'Mesa de planos: cartões por classe e arquivos em comum',
  },
  lote_aprovar_limpos: {
    metodo: 'POST',
    caminho: '/api/lotes/:id/aprovar-limpos',
    transporte: 'json',
    tela: 'mesa_planos',
    descricao: 'G1 em bloco, só planos limpos (lista confirmada)',
  },
  lote_pausar: {
    metodo: 'POST',
    caminho: '/api/lotes/:id/pausar',
    transporte: 'json',
    tela: 'lote',
    descricao: 'Pausar o lote (não inicia novas etapas)',
  },
  lote_cancelar_pendentes: {
    metodo: 'POST',
    caminho: '/api/lotes/:id/cancelar-pendentes',
    transporte: 'json',
    tela: 'lote',
    descricao: 'Cancela o que ainda não começou a implementar',
  },
  // --- fila de merge
  merge_obter: {
    metodo: 'GET',
    caminho: '/api/merge',
    transporte: 'json',
    tela: 'fila_merge',
    descricao: 'Filas por destino, pendências com o Chamados, a publicar',
  },
  merge_reordenar: {
    metodo: 'POST',
    caminho: '/api/merge/itens/:id/reordenar',
    transporte: 'json',
    tela: 'fila_merge',
    descricao: 'Reordena um item da fila serial',
  },
  merge_publicado_producao: {
    metodo: 'POST',
    caminho: '/api/merge/publicado-producao',
    transporte: 'json',
    tela: 'fila_merge',
    descricao: 'Gdeploy: "Publicado em produção" (vários)',
  },
  merge_liberar_token_schema: {
    metodo: 'POST',
    caminho: '/api/merge/token-schema/liberar',
    transporte: 'json',
    tela: 'fila_merge',
    descricao: 'Libera o token de schema preso (com confirmação)',
  },
  outbox_tentar_agora: {
    metodo: 'POST',
    caminho: '/api/execucoes/:id/outbox/tentar-agora',
    transporte: 'json',
    tela: 'fila_merge',
    descricao: 'mergeado_pendente_chamado: tenta o passo agora',
  },
  // --- projetos
  projetos_listar: {
    metodo: 'GET',
    caminho: '/api/projetos',
    transporte: 'json',
    tela: 'projetos',
    descricao: 'Projetos configurados',
  },
  projeto_obter: {
    metodo: 'GET',
    caminho: '/api/projetos/:id',
    transporte: 'json',
    tela: 'projeto',
    descricao: 'Configuração completa do projeto',
  },
  projeto_criar: {
    metodo: 'POST',
    caminho: '/api/projetos',
    transporte: 'json',
    tela: 'projeto',
    descricao: 'Cria projeto (valida tudo; nada pela metade)',
  },
  projeto_atualizar: {
    metodo: 'PUT',
    caminho: '/api/projetos/:id',
    transporte: 'json',
    tela: 'projeto',
    descricao: 'Salva a configuração (não afeta execuções já iniciadas)',
  },
  projeto_testar_detectores: {
    metodo: 'POST',
    caminho: '/api/projetos/:id/testar-detectores',
    transporte: 'json',
    tela: 'projeto',
    descricao: '[Testar contra um commit]: quais selos acenderiam',
  },
  projeto_detectar: {
    metodo: 'POST',
    caminho: '/api/projetos/detectar',
    transporte: 'json',
    tela: 'projeto',
    descricao: 'Valida a pasta (git) e mostra o que foi autodetectado (FJ-030 §5)',
  },
  // --- configurações globais
  configuracoes_obter: {
    metodo: 'GET',
    caminho: '/api/configuracoes',
    transporte: 'json',
    tela: 'configuracoes',
    descricao: 'Modelos, cota, concorrência, limites e gates globais (FJ-030 §2)',
  },
  configuracoes_gravar: {
    metodo: 'PUT',
    caminho: '/api/configuracoes',
    transporte: 'json',
    tela: 'configuracoes',
    descricao: 'Grava as configurações globais (não afeta execuções já iniciadas)',
  },
  configuracoes_restaurar: {
    metodo: 'POST',
    caminho: '/api/configuracoes/restaurar',
    transporte: 'json',
    tela: 'configuracoes',
    descricao: '[Restaurar padrões]',
  },
  // --- conexão
  conexoes_listar: {
    metodo: 'GET',
    caminho: '/api/conexoes',
    transporte: 'json',
    tela: 'conexao',
    descricao: 'Conexões com o Chamados (sem token)',
  },
  conexao_criar: {
    metodo: 'POST',
    caminho: '/api/conexoes',
    transporte: 'json',
    tela: 'conexao',
    descricao: 'Cria conexão (recusa 127.0.0.1)',
  },
  conexao_atualizar: {
    metodo: 'PUT',
    caminho: '/api/conexoes/:id',
    transporte: 'json',
    tela: 'conexao',
    descricao: 'Atualiza conexão',
  },
  conexao_testar: {
    metodo: 'POST',
    caminho: '/api/conexoes/:id/testar',
    transporte: 'json',
    tela: 'conexao',
    descricao: '[Testar conexão]: usuário, papel, validade do token',
  },
  conexao_relogar: {
    metodo: 'POST',
    caminho: '/api/conexoes/:id/relogar',
    transporte: 'json',
    tela: 'conexao',
    descricao: '[Relogar]',
  },
  conexao_esquecer: {
    metodo: 'POST',
    caminho: '/api/conexoes/:id/esquecer',
    transporte: 'json',
    tela: 'conexao',
    descricao: '[Esquecer credenciais] (keyring + token)',
  },
  // --- diagnóstico
  diagnostico_obter: {
    metodo: 'GET',
    caminho: '/api/diagnostico',
    transporte: 'json',
    tela: 'diagnostico',
    descricao: 'Última rodada das verificações',
  },
  diagnostico_rodar: {
    metodo: 'POST',
    caminho: '/api/diagnostico/rodar',
    transporte: 'json',
    tela: 'diagnostico',
    descricao: '[Rodar tudo]',
  },
  diagnostico_aceitar_versao_cli: {
    metodo: 'POST',
    caminho: '/api/diagnostico/aceitar-versao-cli',
    transporte: 'json',
    tela: 'diagnostico',
    descricao: '"Aceitar versão X": dispara o smoke de perfis',
  },
  // --- histórico e worktrees
  historico_listar: {
    metodo: 'GET',
    caminho: '/api/historico',
    transporte: 'json',
    tela: 'historico',
    descricao: 'Execuções encerradas e métricas (00 §10)',
  },
  worktrees_listar: {
    metodo: 'GET',
    caminho: '/api/worktrees',
    transporte: 'json',
    tela: 'worktrees',
    descricao: 'Worktrees da Forja, órfãs e tamanho em disco',
  },
  worktree_limpar: {
    metodo: 'POST',
    caminho: '/api/worktrees/limpar',
    transporte: 'json',
    tela: 'worktrees',
    descricao: '[Limpar…] uma worktree',
  },
  // --- terminal
  terminal_sessoes: {
    metodo: 'GET',
    caminho: '/api/terminal/sessoes',
    transporte: 'json',
    tela: 'terminal',
    descricao: 'Abas de PTY abertas',
  },
  terminal_abrir: {
    metodo: 'POST',
    caminho: '/api/terminal/sessoes',
    transporte: 'json',
    tela: 'terminal',
    descricao: 'Novo chat livre (claude interativo no repo ou worktree)',
  },
  terminal_encerrar: {
    metodo: 'POST',
    caminho: '/api/terminal/sessoes/:id/encerrar',
    transporte: 'json',
    tela: 'terminal',
    descricao: 'Encerra o PTY',
  },
  terminal_reabrir: {
    metodo: 'POST',
    caminho: '/api/terminal/sessoes/:id/reabrir',
    transporte: 'json',
    tela: 'terminal',
    descricao: '[Reabrir] um processo que saiu',
  },
  terminal_ws: {
    metodo: 'GET',
    caminho: '/api/terminal/:sessao',
    transporte: 'ws',
    tela: 'terminal',
    descricao: 'WebSocket do PTY (bytes + controle; 01 §11)',
  },
} as const satisfies { [N in keyof ContratoRotas]: DefRota };

export type NomeRota = keyof ContratoRotas;
export type EntradaRota<N extends NomeRota> = ContratoRotas[N]['entrada'];
export type SaidaRota<N extends NomeRota> = ContratoRotas[N]['saida'];

/** `'/api/execucoes/:id/etapas/:etapa_id'` → `{ id: string; etapa_id: string }`. */
export type ParametrosDoCaminho<P extends string> =
  P extends `${string}:${infer Nome}/${infer Resto}`
    ? { [K in Nome | keyof ParametrosDoCaminho<`/${Resto}`>]: string }
    : P extends `${string}:${infer Nome}`
      ? { [K in Nome]: string }
      : Record<never, never>;

export type ParametrosRota<N extends NomeRota> = ParametrosDoCaminho<
  (typeof ROTAS_API)[N]['caminho']
>;

/** Substitui `:param` pelos valores (codificados). Lança se faltar parâmetro. */
export function montarCaminho(caminho: string, parametros: Record<string, string> = {}): string {
  return caminho.replace(/:([a-z_]+)/g, (_trecho, nome: string) => {
    const valor = parametros[nome];
    if (valor === undefined || valor === '') {
      throw new Error(`parâmetro de rota ausente: ${nome} em ${caminho}`);
    }
    return encodeURIComponent(valor);
  });
}

/**
 * Serializa a entrada de um GET como query string: arrays repetem a chave,
 * `undefined`/`null` são omitidos, booleanos e números viram texto.
 */
export function montarQuery(entrada: object | undefined): string {
  if (!entrada) return '';
  const qs = new URLSearchParams();
  for (const [chave, valor] of Object.entries(entrada)) {
    if (valor === undefined || valor === null) continue;
    const lista: unknown[] = Array.isArray(valor) ? valor : [valor];
    for (const item of lista) {
      if (item === undefined || item === null) continue;
      qs.append(chave, String(item));
    }
  }
  const texto = qs.toString();
  return texto ? `?${texto}` : '';
}
