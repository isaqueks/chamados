import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  configuracoesGlobaisPadrao,
  detectadoVazio,
  resolverConfig,
  type ConfigResolvida,
  type ConfiguracoesGlobais,
  type ProjetoDetectado,
} from '../../comum/config-projeto';
import type { CodigoErroApi } from '../../comum/dto';
import type { EstadoExecucao, OrigemEvento, TipoEtapa } from '../../comum/estados';
import type { EventoForja, NovoEventoForja } from '../../comum/protocolo-eventos';
import type { IdentidadeForja, OperacoesChamados } from '../chamados/tipos';
import type { Env } from '../claude/perfis';
import type { ExecucaoProcesso, Runner } from '../claude/runner';
import { ArmazemConfiguracoes } from '../configuracoes/armazem';
import type { BancoForja } from '../db/banco';
import type { Execucao } from '../db/entidades/execucao';
import type { Projeto } from '../db/entidades/projeto';
import { configDoProjeto } from '../db/repositorios/projeto';
import type { PatchExecucao, Repositorios } from '../db/repositorios';
import type { BarramentoEventos } from '../eventos/barramento';
import { enxugarEvento, type Redator } from '../eventos/normalizador';
import { autodetectarProjeto } from '../projetos/autodeteccao';
import type { GerenteSessoesTerminal } from '../terminal/sessoes';
import { coletarEvidencias } from '../verificacao';
import {
  liberar,
  liberarTudoMenosSchema,
  ocupar,
  podeIniciar,
  semaforosVazios,
  type PedidoVaga,
  type Semaforos,
} from './lote';
import {
  proximoEstado,
  type DecisaoMaquina,
  type EventoMaquina,
  type TransicaoAplicada,
} from './maquina-execucao';

/**
 * Núcleo do orquestrador (specs/forja/03 §1; 01 §3.2, §6.8): as dependências
 * injetadas, a ÚNICA porta de transição de estado e as vagas em memória.
 *
 * POR QUE uma porta única (`transicionar`): 03 §1.4 exige que toda transição
 * grave um `evento` com origem, estado de saída/chegada e motivo; aqui a
 * decisão do domínio puro (`proximoEstado`), a escrita de `execucao`, os
 * efeitos (ciclos, 03 §6) e o `evento` `execucao.estado` caem na MESMA
 * transação SQLite, e só DEPOIS do commit o envelope (com o `seq` do banco) é
 * difundido no barramento. Nada de rede, git ou processo dentro da transação
 * (a fila do `BancoForja` pararia inteira).
 *
 * Todas as portas de I/O (runner da CLI, Chamados, coleta, terminal,
 * relógio) chegam por injeção: os testes usam runner falso, git real em repo
 * temporário e o Chamados falso de `server/chamados`.
 */

// ---------------------------------------------------------------------------
// Portas injetadas
// ---------------------------------------------------------------------------

/** Conexão com o Chamados de uma `conexao_chamados` (produção: `ConexaoChamados`). */
export interface FonteChamados {
  api: OperacoesChamados;
  identidade(): IdentidadeForja | null;
  /** D-036 presente no servidor (L1/L4). `null` = ainda não detectado → tratado como ausente. */
  d036(): boolean | null;
  /** Sessão utilizável (07 §2.2): `false` = nenhuma chamada sai. */
  podeUsar(): boolean;
  /** Erro legível do estado da sessão (para a Fila mostrar o motivo real, FJ-031). */
  erro?(): { codigo: string; mensagem: string } | null;
  /** URL do painel (link "Abrir no Chamados"). */
  urlBase: string;
  papel?: 'operador' | 'admin';
}

/**
 * Funções de coleta (padrão: `server/verificacao`). Injetáveis nos testes. Sem
 * `setup`, verificação nem linha de base desde FJ-032: a Forja não executa
 * comandos do projeto.
 */
export interface PortaVerificacao {
  /** Coleta/validação dos prints que o agente tirou (FJ-030 §3). */
  coletarEvidencias: typeof coletarEvidencias;
}

export interface DepsOrquestrador {
  banco: BancoForja;
  barramento: BarramentoEventos;
  runner: Runner;
  /** Raiz `<dados>` (02 §7). */
  dirDados: string;
  /** Fonte do Chamados por conexão (null = conexão inexistente/indisponível). */
  chamados(conexaoId: string): FonteChamados | null;
  verificacao?: Partial<PortaVerificacao>;
  /** Configurações globais (FJ-030 §2). Padrão: `<dados>/configuracoes.json`. */
  configuracoes?: ArmazemConfiguracoes;
  /** Autodetecção do repositório (FJ-030 §1). Padrão: `autodetectarProjeto`. */
  autodetectar?: (repoDir: string) => Promise<ProjetoDetectado>;
  /**
   * Credencial do MCP do Chamados para os agentes (FJ-030 §4): token da sessão
   * da conexão. `null`/ausente = os agentes rodam sem o MCP.
   */
  mcpChamados?: (conexaoId: string) => Promise<CredencialMcpChamados | null>;
  /** Comando do servidor MCP (`tsx …/apps/mcp/src/index.ts`). Ausente = sem MCP. */
  servidorMcp?: { command: string; args: string[] } | null;
  /** Caminho absoluto de `scripts/forja-print.mjs` (B7, env `FORJA_PRINT`). */
  forjaPrint?: string | null;
  terminal?: GerenteSessoesTerminal | null;
  agora?: () => Date;
  novoSessionId?: () => string;
  /** Ambiente de origem dos spawns (só a allowlist é lida, 05 §4.7). */
  envOrigem?: Env;
  /** CLI na versão compatível (03 §11 "CLI atualizada"). Padrão: true. */
  cliCompativel?: () => boolean;
  versaoCli?: string | null;
  /**
   * Varredura obrigatória do cwd depois de matar um agente (01 §3.2 [V S4]: os
   * comandos do Bash ficam fora do `pgid`). Devolve quantos processos matou.
   */
  varrerCwd?: (dir: string) => Promise<number>;
  /** Escada no grupo (reconciliação do boot). */
  encerrarGrupo?: (pgid: number, escada: 'padrao' | 'pty') => Promise<void>;
  /**
   * Redator com os valores sensíveis conhecidos (token de boot, API key,
   * valores dos `arquivos_locais`), compartilhado com o barramento (05 §8.2).
   */
  redator?: Redator;
  /** Hashes da sentinela de integridade (05 §4.9). Ausente = sentinela desligada. */
  sentinela?: (repoDirUsuario: string) => Promise<Record<string, string>>;
  /** Retomada automática após crash (03 §3.3, DECISÃO PENDENTE: padrão ligada, 1×). */
  retomadaAutomatica?: boolean;
  /** Intervalo do relógio interno (freio, backoff, cópia suja). 0 = sem timer (testes). */
  intervaloTickMs?: number;
  log?: (mensagem: string) => void;
}

/** O que o `mcp.<n>.json` da etapa precisa para o `apps/mcp` logar por token (FJ-030 §4). */
export interface CredencialMcpChamados {
  url: string;
  tenant: string | null;
  email: string;
  token: string;
}

// ---------------------------------------------------------------------------
// Erro tipado dos comandos (a fachada traduz para `ErroApiDto`)
// ---------------------------------------------------------------------------

export class ErroForja extends Error {
  constructor(
    readonly codigo: CodigoErroApi,
    mensagem: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 500 | 501 | 503 = 409,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroForja';
  }
}

/** Concorrência global → semáforos (o token de schema é sempre 1 por destino). */
export function limitesDeConcorrencia(c: ConfiguracoesGlobais) {
  return {
    agentes: c.concorrencia.implementacoes,
    planejadores: c.concorrencia.planejadores,
    schema_em_voo: 1,
  };
}

export const naoEncontrado = (o_que: string): ErroForja =>
  new ErroForja('nao_encontrado', `${o_que} não encontrado(a)`, 404);

// ---------------------------------------------------------------------------
// Vagas (03 §7.2): semáforos do domínio + espera assíncrona
// ---------------------------------------------------------------------------

export class GerenteVagas {
  private s: Semaforos;
  private esperas: (() => void)[] = [];

  constructor(limites?: Parameters<typeof semaforosVazios>[0]) {
    this.s = semaforosVazios(limites);
  }

  /** Novos limites de concorrência (configurações globais, FJ-030 §2): ocupantes ficam. */
  ajustarLimites(limites: Parameters<typeof semaforosVazios>[0]): void {
    const novo = semaforosVazios(limites);
    this.s = {
      ...this.s,
      planejadores: { ...this.s.planejadores, limite: novo.planejadores.limite },
      agentes: { ...this.s.agentes, limite: novo.agentes.limite },
    };
    this.acordar();
  }

  get semaforos(): Semaforos {
    return this.s;
  }

  definir(s: Semaforos): void {
    this.s = s;
    this.acordar();
  }

  tentar(p: PedidoVaga): boolean {
    if (!podeIniciar(this.s, p).ok) return false;
    this.s = ocupar(this.s, p);
    return true;
  }

  /** Espera a vaga (sub-passos que pedem uma vaga no meio de uma tarefa). */
  async aguardar(p: PedidoVaga): Promise<void> {
    while (!this.tentar(p)) {
      await new Promise<void>((ok) => this.esperas.push(ok));
    }
  }

  soltar(p: PedidoVaga): void {
    this.s = liberar(this.s, p);
    this.acordar();
  }

  soltarTudoMenosSchema(execucaoId: string): void {
    this.s = liberarTudoMenosSchema(this.s, execucaoId);
    this.acordar();
  }

  soltarSchema(execucaoId: string): void {
    for (const chave of Object.keys(this.s.schema.ocupantes)) {
      this.s = liberar(this.s, { execucao_id: execucaoId, recurso: 'schema', chave });
    }
    this.acordar();
  }

  /** Quem segura o token de schema de um destino. */
  donoSchema(chave: string): string | null {
    return this.s.schema.ocupantes[chave]?.[0] ?? null;
  }

  private acordar(): void {
    const e = this.esperas;
    this.esperas = [];
    for (const ok of e) ok();
  }
}

// ---------------------------------------------------------------------------
// Núcleo
// ---------------------------------------------------------------------------

export interface OpcoesTransicionar {
  /** Campos gravados junto com a transição (mesma transação). */
  patch?: PatchExecucao;
  /** Escritas extras na mesma transação (artefato, aprovação, comentário, item de fila…). */
  dentro?: (r: Repositorios, execucao: Execucao, t: TransicaoAplicada | null) => Promise<void>;
  /** `true` = recusado/permanece vira `ErroForja('conflito')` (comandos humanos). */
  exigir?: boolean;
}

export interface ResultadoTransicao {
  decisao: DecisaoMaquina;
  execucao: Execucao;
  evento: EventoForja | null;
}

const ORIGEM_EVENTO: Record<TransicaoAplicada['origem'], OrigemEvento> = {
  codigo: 'app',
  modelo: 'app',
  humano: 'humano',
};

export function eventoEstado(e: Execucao, t: TransicaoAplicada): NovoEventoForja {
  const motivo = t.motivo_estado ? ` (${t.motivo_texto ?? t.motivo_estado})` : '';
  return {
    execucao_id: e.id,
    etapa_id: null,
    tipo: 'execucao.estado',
    nivel:
      t.para === 'precisa_humano' || t.para === 'falhou'
        ? 'aviso'
        : t.para === 'interrompido'
          ? 'aviso'
          : 'info',
    resumo: `#${e.numero}: ${t.de} → ${t.para}${motivo}`,
    dados: {
      estado: t.para,
      estado_anterior: t.estado_anterior,
      motivo_estado: t.motivo_estado,
      numero: e.numero,
      projeto_id: e.projeto_id,
    },
  };
}

/** Processo de agente em curso de uma execução (pausar/parar/assumir, 03 §10). */
export interface ProcessoEmCurso {
  processo: ExecucaoProcesso;
  etapaId: string;
  cwd: string;
  /** O humano pediu pausa/parada/descarte: o fim é esperado, não é falha. */
  parada: 'pausa' | 'parar' | 'cancelar' | null;
}

export class Nucleo {
  readonly vagas: GerenteVagas;
  readonly verificacao: PortaVerificacao;
  /** Um processo de agente por execução (o lock por sessão é do runner, 01 §6.8). */
  readonly emCurso = new Map<string, ProcessoEmCurso>();
  /** Pausa pedida em `verificando`/`integrando`: vale ao fim do passo corrente (03 §10). */
  readonly pausasPendentes = new Set<string>();
  /** Agentes negados por projeto × versão da CLI (01 §6.2), semeados pelos embutidos. */
  readonly agentesNegados = new Map<string, string[]>();
  /** Valores sensíveis conhecidos (detector do outbox, 05 §8.2). */
  readonly segredos = new Set<string>();
  /** Chamado depois de toda transição aplicada (o orquestrador re-despacha). */
  aoTransicionar: (execucaoId: string, t: TransicaoAplicada) => void = () => {};

  readonly configuracoes: ArmazemConfiguracoes;

  constructor(readonly deps: DepsOrquestrador) {
    this.configuracoes = deps.configuracoes ?? new ArmazemConfiguracoes(deps.dirDados);
    this.vagas = new GerenteVagas(limitesDeConcorrencia(this.lerGlobais()));
    this.configuracoes.aoMudar((c) => this.vagas.ajustarLimites(limitesDeConcorrencia(c)));
    this.verificacao = { coletarEvidencias, ...deps.verificacao };
  }

  /** Globais vigentes; arquivo corrompido não derruba o pipeline (vale o padrão + log). */
  private lerGlobais(): ConfiguracoesGlobais {
    try {
      return this.configuracoes.ler();
    } catch (e) {
      this.log(`configurações globais: ${(e as Error).message} — usando os padrões`);
      return configuracoesGlobaisPadrao();
    }
  }

  globais(): ConfiguracoesGlobais {
    return this.lerGlobais();
  }

  /**
   * Configuração resolvida do projeto AGORA (FJ-030 §1): projeto v2 + globais
   * + o último detectado (cache em `projeto.detectado`). Síncrona: a fila e os
   * DTOs consultam muito; quem precisa do repositório lido de novo chama
   * `redetectar` antes.
   */
  configDoProjeto(projeto: Projeto): ConfigResolvida {
    return resolverConfig(
      configDoProjeto(projeto),
      this.lerGlobais(),
      projeto.detectado ?? detectadoVazio(projeto.repo_dir),
    );
  }

  /** Relê o repositório e grava o detectado; falha (pasta sumiu) mantém o anterior. */
  async redetectar(projeto: Projeto): Promise<Projeto> {
    try {
      const detectado = await (this.deps.autodetectar ?? autodetectarProjeto)(projeto.repo_dir);
      await this.banco.transacao((r) => r.projetos.gravarDetectado(projeto.id, detectado));
      return { ...projeto, detectado };
    } catch (e) {
      this.log(`autodetecção de ${projeto.nome}: ${(e as Error).message}`);
      return projeto;
    }
  }

  get banco(): BancoForja {
    return this.deps.banco;
  }

  agora(): Date {
    return this.deps.agora ? this.deps.agora() : new Date();
  }

  iso(): string {
    return this.agora().toISOString();
  }

  novoSessionId(): string {
    return this.deps.novoSessionId ? this.deps.novoSessionId() : randomUUID();
  }

  log(mensagem: string): void {
    this.deps.log?.(mensagem);
  }

  cliCompativel(): boolean {
    return this.deps.cliCompativel ? this.deps.cliCompativel() : true;
  }

  /** `<dados>/execucoes/<id>` (02 §7): arquivos gerados, logs, prints — fora da worktree. */
  dirExecucao(execucaoId: string): string {
    return join(this.deps.dirDados, 'execucoes', execucaoId);
  }

  dirEtapa(execucaoId: string, n: number): string {
    return join(this.dirExecucao(execucaoId), 'etapas', String(n));
  }

  /**
   * Registra valores sensíveis conhecidos (05 §8.2): passam a ser redigidos nos
   * eventos e bloqueiam o outbox se aparecerem numa nota ou mensagem pública.
   */
  registrarSegredos(valores: Iterable<string>): void {
    const novos = [...valores].filter((v) => typeof v === 'string' && v.trim().length >= 6);
    for (const v of novos) this.segredos.add(v);
    this.deps.redator?.adicionar(novos);
  }

  /** Grava um evento fora de transição (feed, checkpoint, comando) e difunde depois do commit. */
  async publicar(novo: NovoEventoForja, origem: OrigemEvento = 'app'): Promise<EventoForja> {
    const limpo = this.deps.redator ? enxugarEvento(novo, { redator: this.deps.redator }) : novo;
    const ev = await this.banco.transacao((r) => r.eventos.acrescentar(limpo, { origem }));
    return this.deps.barramento.difundir(ev);
  }

  /**
   * Aplica um fato/ação à máquina (03 §2.4) e grava tudo numa transação:
   * estado + efeitos + patch + escritas extras + `evento`. Depois do commit:
   * difunde o evento e solta as vagas que o destino solta (03 §7.2/§7.3).
   */
  async transicionar(
    execucaoId: string,
    evento: EventoMaquina,
    opcoes: OpcoesTransicionar = {},
  ): Promise<ResultadoTransicao> {
    const saida = await this.banco.transacao(async (r) => {
      const atual = await r.execucoes.exigir(execucaoId);
      const decisao = proximoEstado(
        {
          estado: atual.estado,
          estado_anterior: atual.estado_anterior,
          motivo_estado: atual.motivo_estado,
        },
        evento,
      );
      if (decisao.tipo !== 'transicao') {
        if (opcoes.exigir) {
          throw new ErroForja(
            'conflito',
            decisao.tipo === 'recusado' ? decisao.erro : decisao.razao,
            409,
          );
        }
        return { decisao, execucao: atual, evento: null as EventoForja | null };
      }
      const t = decisao.transicao;
      await r.execucoes.mudarEstado(execucaoId, t.para, {
        motivo: t.motivo_estado,
        motivo_texto: t.motivo_texto,
      });
      if (t.efeitos.ciclo_total) {
        await r.execucoes.incrementarCiclos(execucaoId, { automatico: t.efeitos.ciclo_auto === 1 });
      }
      if (opcoes.patch && Object.keys(opcoes.patch).length > 0) {
        await r.execucoes.atualizar(execucaoId, opcoes.patch);
      }
      const depois = await r.execucoes.exigir(execucaoId);
      if (opcoes.dentro) await opcoes.dentro(r, depois, t);
      await encerrarFilaAoSair(r, execucaoId, t);
      const ev = await r.eventos.acrescentar(eventoEstado(depois, t), {
        origem: ORIGEM_EVENTO[t.origem],
      });
      return { decisao, execucao: await r.execucoes.exigir(execucaoId), evento: ev };
    });
    if (saida.evento) this.deps.barramento.difundir(saida.evento);
    if (saida.decisao.tipo === 'transicao') {
      const t = saida.decisao.transicao;
      if (t.para === 'precisa_humano' || t.para === 'falhou' || t.para === 'interrompido') {
        this.vagas.soltarTudoMenosSchema(execucaoId);
      }
      if (t.efeitos.solta_token_schema) {
        this.vagas.soltarTudoMenosSchema(execucaoId);
        this.vagas.soltarSchema(execucaoId);
      }
      this.aoTransicionar(execucaoId, t);
    }
    return saida;
  }

  /** Execução + projeto (o `config_snapshot` é a configuração que vale para ela, 02 §4.6). */
  async carregar(
    execucaoId: string,
  ): Promise<{ execucao: Execucao; projeto: Projeto; config: ConfigResolvida }> {
    return this.banco.ler(async (r) => {
      const execucao = await r.execucoes.obter(execucaoId);
      if (!execucao) throw naoEncontrado('execução');
      const projeto = await r.projetos.exigir(execucao.projeto_id);
      return { execucao, projeto, config: execucao.config_snapshot };
    });
  }

  fonte(conexaoId: string): FonteChamados | null {
    return this.deps.chamados(conexaoId);
  }
}

/** Saídas de `na_fila_merge`/`integrando` que CONSERVAM o item e a aprovação vigente. */
const SAIDAS_QUE_MANTEM_FILA: readonly EstadoExecucao[] = [
  'integrando',
  'mergeado',
  // `falhou` (ambiente/setup) e laterais: "Tentar de novo"/Retomar voltam com a mesma aprovação.
  'falhou',
  'interrompido',
  'pausado_usuario',
];

/**
 * Coerência da fila de merge com a execução (03 §8.1, I-3, I-5), na MESMA
 * transação da transição: toda saída de `na_fila_merge`/`integrando` que volta
 * ao pipeline (reverificação reprovada, conflito, chamado mudou no servidor,
 * sentinela) e todo Descartar/Encerrar finalizam o item ativo (`devolvido`) e
 * invalidam a aprovação vigente. Sem isso o item `aguardando` ficava na cabeça
 * da fila travando o destino inteiro, e o G2 seguinte falhava com I-3/I-5.
 *
 * Exceções: `push_recusado` ("tentar de novo mais tarde" reaproveita a
 * aprovação) e o item em `conflito` com `conflito_merge`, que fica visível na
 * Fila de merge até a próxima aprovação o substituir (`enfileirar`).
 */
async function encerrarFilaAoSair(
  r: Repositorios,
  execucaoId: string,
  t: TransicaoAplicada,
): Promise<void> {
  const terminal = t.para === 'descartado' || t.para === 'cancelado';
  const daFila = t.de === 'na_fila_merge' || t.de === 'integrando';
  if (!terminal && !daFila) return;
  if (!terminal && SAIDAS_QUE_MANTEM_FILA.includes(t.para)) return;
  if (!terminal && t.para === 'precisa_humano' && t.motivo_estado === 'push_recusado') return;
  const item = await r.filaMerge.ativoDaExecucao(execucaoId);
  const manterConflito =
    !terminal && item?.estado === 'conflito' && t.motivo_estado === 'conflito_merge';
  if (item && !manterConflito) {
    await r.filaMerge.mudarEstado(item.id, 'devolvido', {
      motivo: `a execução foi para ${t.para}${t.motivo_estado ? ` (${t.motivo_estado})` : ''}`,
    });
  }
  const vigente = await r.aprovacoes.vigente(execucaoId);
  if (vigente) {
    await r.aprovacoes.invalidar(vigente.id, `a execução saiu da fila de merge (${t.para})`);
  }
}

/** Etapa do pipeline que roda quando a execução está num estado (03 §2.2, coluna "Recurso preso"). */
export function etapaDoEstado(estado: EstadoExecucao): TipoEtapa | null {
  switch (estado) {
    case 'na_fila':
    case 'preparando':
    case 'planejando':
      return 'planejar';
    case 'implementando':
      return 'implementar';
    case 'verificando':
      return 'verificar';
    case 'revisando':
      return 'revisar';
    case 'relatando':
      return 'relatar';
    case 'na_fila_merge':
    case 'integrando':
      return 'integrar';
    default:
      return null;
  }
}
