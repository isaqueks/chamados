import { semSuposicao } from './maquina-execucao';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RespostaDetalheChamado } from '@chamados/cliente-api';
import type { ConfigResolvida } from '../../comum/config-projeto';
import {
  paraJsonSchema,
  validarContrato,
  type ComandoDoStream,
  type PlanoRegistrado,
  type PlanoV1,
  type RelatorioV1,
  type ResumoImplRegistrado,
  type ResumoImplV1,
  type VereditoRegistrado,
  type VereditoV1,
} from '../../comum/contratos';
import type { EstadoExecucao, MomentoEvidencia, TipoEtapa } from '../../comum/estados';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import { hashCorpo } from '../chamados/normalizacao';
import { extrairNotasIa } from '../chamados/notas-ia';
import { sinaisDoDetalhe } from '../chamados/sinais';
import { validarRespostaPublica } from '../chamados/validador-linguagem';
import {
  AGENTES_EMBUTIDOS_CONHECIDOS,
  atualizarAgentesNegados,
  montarComando,
  orcamentoEtapa,
  registroPerfil,
  type Esforco,
  type NomePerfil,
} from '../claude/perfis';
import {
  insumosConflito,
  insumosT1,
  insumosT2,
  insumosT3,
  montarPromptConversa,
  montarPromptCorrecao,
  montarPromptRetomada,
  montarPromptSubagente,
  montarPromptTurno,
  type ArquivoRegrasRepositorio,
  type ScriptDica,
  type DadosClientePlanejador,
  type SecaoInsumo,
} from '../claude/prompts';
import { montarPromptSessaoNova, resumeFalhou } from '../claude/retomada';
import {
  persistenciaEmArquivos,
  type ExecucaoProcesso,
  type ResultadoProcesso,
} from '../claude/runner';
import {
  gerarAgentesT1,
  gerarAgentesT2,
  gerarConfigMcp,
  gerarSettings,
  gravarArquivosEtapa,
  type ArquivoAgentes,
  type ConfigMcpGerada,
} from '../claude/settings-gerados';
import {
  calcularCustoTurno,
  condutorFezSozinho,
  eventoTelemetriaTurno,
  eventoUsoAtualizado,
  microUsd,
  type AcumuladoSessao,
} from '../claude/telemetria';
import type { Etapa } from '../db/entidades/etapa';
import type { Execucao } from '../db/entidades/execucao';
import type { Projeto } from '../db/entidades/projeto';
import type { JsonLivre, ObjetoJson } from '../db/json';
import {
  abortarMerge,
  arquivosComMarcadores,
  calcularPatchId,
  casaAlgum,
  commitCheckpoint,
  concluirMergeDestino,
  dirGitComum,
  ehAncestral,
  ErroCheckpointBranch,
  criarWorktreeExecucao,
  git,
  iniciarMergeDestino,
  mensagemPasso,
  mergeEmCurso,
  MENSAGEM_AO_INTERROMPER,
  refDoHead,
  resolverSha,
  selosDoDiff,
  shaHead,
  statusPorcelain,
} from '../git';
import {
  ARQUIVO_TELAS,
  calcularNivelVerificacao,
  DIR_EVIDENCIAS,
  ehComandoDeVerificacao,
  type CalculoNivel,
  type ResultadoColeta,
  type UiDaMudanca,
} from '../verificacao';
import {
  achadosEmAberto,
  custoVazio,
  desfechoDaClassificacao,
  estadoEtapaDaClassificacao,
  etapaParaRetomar,
  planoRegistrado,
  relatorioRegistrado,
  respostaRegistrada,
  resumoImplRegistrado,
  sha8,
  somarNumstat,
  telasDaExecucao,
  textoComandosDoStream,
  textoComoFoiVerificado,
  vereditoRegistrado,
  type CapturaRegistrada,
} from './aplicacao-resultados';
import { decidirAposVeredito, decidirRecusa, tetoPorChamadoAtingido } from './ciclos';
import { baixarAnexos, chamadoMarkdown, detalheSanitizado } from './entrada';
import { capturarUrlRemoto } from './fila-merge';
import { avaliarFreio, LIMIARES_PADRAO } from './freio-cota';
import {
  assumirDecisoes,
  avaliarG1,
  avaliarPreCondicoesG0,
  revisaoSegurancaObrigatoria,
} from './gates';
import { chaveDestino, decidirSchemaImprevisto } from './lote';
import type { EventoMaquina } from './maquina-execucao';
import { sandboxDoProjeto } from './modo-reforcado';
import { ErroForja, type Nucleo } from './nucleo';
import { planoPreveUi, validarPlano, validarResumoImpl, validarVeredito } from './regras-contratos';
import {
  avaliarRelatorio,
  decidirRelatorio,
  declaracaoSemPrints,
  tipoRespostaExigido,
} from './regras-relatorio';
import { valoresDeArquivosLocais } from './segredos-locais';
import { medirSentinela, registrarDivergencias } from './sentinela';

/**
 * Etapas do pipeline (specs/forja/03 §3–§5; 04 §4 insumos; 01 §6 runner): cada
 * função CONDUZ uma etapa de uma execução — monta prompt/arquivos, grava a
 * `etapa` ANTES do spawn (01 §3.2), consome o stream, commita checkpoints,
 * persiste artefatos e entrega o FATO à máquina via `nucleo.transicionar`.
 *
 * Quem decide QUANDO uma etapa roda (vagas, freio, ordem do lote) é o
 * orquestrador; quem decide PARA ONDE vai é o domínio puro. Aqui só se faz o
 * trabalho e se traduz o resultado.
 */

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------

async function gitSaida(args: string[], cwd: string): Promise<string> {
  return (await git(args, { cwd, aceitar: [0, 1, 128] })).stdout;
}

const ARQUIVOS_REGRAS = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'];

/** B3 = CLAUDE.md do COMMIT BASE (04 §4.3): o agente não injeta regra editando o arquivo. */
export async function regrasDoRepositorio(
  repoDir: string,
  shaBase: string | null,
): Promise<ArquivoRegrasRepositorio[]> {
  if (!shaBase) return [];
  const saida: ArquivoRegrasRepositorio[] = [];
  for (const origem of ARQUIVOS_REGRAS) {
    const r = await git(['show', `${shaBase}:${origem}`], { cwd: repoDir, aceitar: [0, 128] });
    if (r.codigo === 0 && r.stdout.trim()) saida.push({ origem, conteudo: r.stdout });
  }
  return saida;
}

const LOCKFILES = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/Gemfile.lock',
  '**/composer.lock',
  '**/go.sum',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

export const ehLockfile = (caminho: string): boolean => casaAlgum(caminho, LOCKFILES);

export async function arquivosDoDiff(dir: string, base: string, head: string): Promise<string[]> {
  return (await gitSaida(['diff', '--name-only', `${base}..${head}`], dir))
    .split('\n')
    .filter(Boolean);
}

async function diffStatTexto(dir: string, base: string, head: string): Promise<string> {
  return (await gitSaida(['diff', '--stat', `${base}..${head}`], dir)).trim();
}

async function numstat(dir: string, base: string, head: string) {
  return somarNumstat(await gitSaida(['diff', '--numstat', `${base}..${head}`], dir));
}

function destinosLocais(config: ConfigResolvida): string[] {
  return config.arquivos_locais.map((a) => a.destino);
}

/**
 * Worktree sem alteração além dos `arquivos_locais`. `soRastreados`: o T2 roda
 * os checks do projeto (FJ-032), que podem deixar artefato não rastreado
 * (cache, saída de build fora do `.gitignore`) — isso não é "alterar o código".
 */
async function arvoreLimpaSemLocais(
  dir: string,
  config: ConfigResolvida,
  soRastreados = false,
): Promise<boolean> {
  const locais = new Set(destinosLocais(config));
  const sujas = (await statusPorcelain(dir, !soRastreados)).filter(
    (l) => !locais.has(l.slice(3).trim()),
  );
  return sujas.length === 0;
}

const EMBUTIDOS_GERENCIADOR = new Set(['install', 'i', 'ci', 'add', 'exec', 'dlx', 'x']);

/**
 * Script de `package.json` que um comando chama (`npm run lint`, `npm test`,
 * `pnpm typecheck`, `yarn build`…), ou `null` se não for chamada de script.
 */
export function scriptChamado(comando: string): string | null {
  const m = /^\s*(?:cd\s+\S+\s*&&\s*)?(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(comando);
  if (!m) return null;
  const nome = m[2] as string;
  if (EMBUTIDOS_GERENCIADOR.has(nome)) return null;
  return nome === 't' ? 'test' : nome;
}

/**
 * Dicas de scripts do projeto para o prompt (FJ-032): nada disso é executado
 * pelo app. Uma dica que chama script inexistente no `package.json` da worktree
 * (um `npm run typecheck` herdado de configuração antiga) é descartada — dica
 * errada custa turno do agente.
 */
export async function scriptsDoProjeto(
  config: ConfigResolvida,
  dir: string | null,
): Promise<ScriptDica[]> {
  const c = config.comandos;
  const todas = [
    ...(c.setup ? [{ nome: 'dependências', comando: c.setup.comando }] : []),
    ...c.verificacao.map((v) => ({ nome: v.nome, comando: v.comando })),
    ...(c.e2e ? [{ nome: 'e2e', comando: c.e2e.comando }] : []),
    ...(c.app_subir ? [{ nome: 'subir o app', comando: c.app_subir.comando }] : []),
  ];
  if (!dir) return todas;
  let scripts: Record<string, unknown> | null = null;
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return todas; // sem package.json legível: não há como conferir
  }
  return todas.filter((d) => {
    const nome = scriptChamado(d.comando);
    return nome === null || Object.hasOwn(scripts, nome);
  });
}

const minutos = (m: number) => Math.max(1, m) * 60_000;

function esforco(valor: string): Esforco {
  return (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(valor as Esforco)
    ? (valor as Esforco)
    : 'high';
}

export interface Ctx {
  execucao: Execucao;
  projeto: Projeto;
  config: ConfigResolvida;
}

async function ultimoArtefato<T>(
  n: Nucleo,
  execucaoId: string,
  tipo: 'plano' | 'resumo_impl' | 'veredito' | 'relatorio' | 'resposta' | 'diff',
) {
  return n.banco.ler(async (r) => {
    const a = await r.artefatos.ultimaVersao(execucaoId, tipo);
    return a ? { artefato: a, conteudo: a.conteudo as unknown as T } : null;
  });
}

export async function planoOficial(n: Nucleo, execucaoId: string): Promise<PlanoRegistrado | null> {
  return (await ultimoArtefato<PlanoRegistrado>(n, execucaoId, 'plano'))?.conteudo ?? null;
}

async function etapasDa(n: Nucleo, execucaoId: string): Promise<Etapa[]> {
  return n.banco.ler((r) => r.etapas.listar(execucaoId));
}

/**
 * Aplica um FATO de código à máquina. `recusado` com a execução ainda no estado
 * da etapa é bug de mapeamento (vira erro interno, nunca silêncio que relança a
 * etapa); recusado porque o humano mudou o estado no meio (Pausar, Descartar)
 * é esperado.
 */
export async function aplicarFato(
  n: Nucleo,
  execucaoId: string,
  evento: EventoMaquina,
  esperado: EstadoExecucao,
): Promise<void> {
  const t = await n.transicionar(execucaoId, evento);
  if (t.decisao.tipo === 'recusado' && t.execucao.estado === esperado) {
    throw new Error(`fato "${evento.tipo}" recusado em "${esperado}": ${t.decisao.erro}`);
  }
}

/**
 * Base do diff da execução (03 §2.5): `sha_base`, ou o último `T0` que o APP
 * integrou na branch (reverificação reprovada na fila de merge) — sem isso, diff,
 * selos, T2 e patch-id passariam a incluir commits do destino. Só valem T0
 * gravados pelo app (nunca refs locais, que o agente em bypass pode mover).
 */
export async function baseDoDiff(n: Nucleo, execucao: Execucao, sha: string): Promise<string> {
  const base = execucao.sha_base as string;
  const dir = execucao.worktree_dir ?? null;
  if (!dir) return base;
  const itens = await n.banco.ler((r) => r.filaMerge.daExecucao(execucao.id));
  let melhor = base;
  for (const i of [...itens].reverse()) {
    const t0 = i.sha_destino_antes;
    if (!t0 || t0 === melhor) continue;
    if (!(await ehAncestral(dir, t0, sha).catch(() => false))) continue;
    if (await ehAncestral(dir, melhor, t0).catch(() => false)) melhor = t0;
  }
  return melhor;
}

// ---------------------------------------------------------------------------
// Turno de agente: etapa → spawn → stream → classificação (01 §6; 03 §3)
// ---------------------------------------------------------------------------

export interface EspecTurno {
  perfil: NomePerfil;
  sessionId: string;
  modo: 'novo' | 'resume';
  retomarTurnoInterrompido?: boolean;
  conversar?: boolean;
  /** stdin (B4/B5, correção, retomada ou mensagem do operador). */
  prompt: string;
  /** `--append-system-prompt-file` (B1/B2/B3/B6). */
  sistema: string;
  agentes?: ArquivoAgentes | null;
  ciclo: number;
  /** `etapa.retomada` (retomada automática ou pedida, 03 §3.3). */
  retomada?: boolean;
  /**
   * stdin da SESSÃO NOVA quando o resume falha (01 §6.7 passo 3): os insumos
   * completos + "estado atual" do SQLite/git. Ausente = `prompt`.
   */
  promptSessaoNova?: string;
  /** Um `implementador` retornou sem outro em voo: commit de checkpoint (03 §3.3). */
  aoCheckpoint?: () => Promise<void>;
  /** Teto/timeout próprios (conversa, 03 §10): os MESMOS anunciados no B6. */
  orcamentoUsd?: number;
  timeoutMin?: number;
  /**
   * Turno AVULSO fora do estado do perfil (FJ-032: reverificação do revisor na
   * fila de merge, em `integrando`): cwd próprio (a worktree de integração),
   * estado esperado e sessão que não vira a `session_id_condutor`.
   */
  avulso?: { cwd: string; estado: EstadoExecucao };
  /**
   * Turno do perfil num estado que não é o dele, na worktree e na sessão da
   * execução (FJ-036: T1 de conflito em `resolvendo_conflito`, etapa
   * `resolver_conflito`). A sessão vira a `session_id_condutor` como no T1.
   */
  foraDoEstado?: { estado: EstadoExecucao; tipo: TipoEtapa };
  /** T2: scripts do projeto (dicas) que entram no allow (FJ-032). */
  scriptsProjeto?: readonly string[];
}

/** O que o app MEDIU no stream do turno (04 §9): não o que o modelo declarou. */
export interface MedidoTurno {
  /** `agente.fora_do_papel`: edição do condutor na thread principal. */
  fora_do_papel: { ferramenta: 'Edit' | 'Write' | 'Bash'; alvo: string }[];
  /** `Agent` por `subagent_type` (chamadas). */
  subagentes: Record<string, number>;
  /**
   * Bash do turno (thread principal e subagentes) com o `tool_result` (FJ-032):
   * a base do nível ⚙ (T2) e dos "comandos que o implementador rodou" (T1).
   */
  bash: (ComandoDoStream & { tool_use_id: string })[];
}

/** Medição vazia (um por turno). */
export function medidoVazio(): MedidoTurno {
  return { fora_do_papel: [], subagentes: {}, bash: [] };
}

export type FimTurno =
  | {
      tipo: 'ok';
      saida: unknown;
      etapa: Etapa;
      resultado: ResultadoProcesso;
      sessionId: string;
      /** Custo DELTA do turno (S5: o `result` vem acumulado na sessão). */
      custo: CustoTurnoDelta | null;
      medido: MedidoTurno;
    }
  | { tipo: 'fato'; evento: EventoMaquina; etapa: Etapa | null }
  | { tipo: 'parado'; etapa: Etapa | null };

type CustoTurnoDelta = ReturnType<typeof calcularCustoTurno>;

const TIPO_ETAPA_PERFIL: Record<NomePerfil, TipoEtapa> = {
  planejador: 'planejar',
  condutor_t1: 'implementar',
  condutor_t2: 'revisar',
  condutor_t3: 'relatar',
};

/** Estado da execução em que o turno de cada perfil roda (a conversa roda em `pausado_usuario`). */
const ESTADO_PERFIL: Record<NomePerfil, EstadoExecucao> = {
  planejador: 'planejando',
  condutor_t1: 'implementando',
  condutor_t2: 'revisando',
  condutor_t3: 'relatando',
};

const ORCAMENTO_PERFIL = {
  planejador: 'planejar',
  condutor_t1: 'implementar',
  condutor_t2: 'revisar',
  condutor_t3: 'relatar',
} as const;

/** Acumulado da sessão no fim do último turno dela (S5: o `result` vem acumulado; o app grava o delta). */
async function acumuladoDaSessao(
  n: Nucleo,
  execucaoId: string,
  sessionId: string,
): Promise<AcumuladoSessao | null> {
  const etapas = await etapasDa(n, execucaoId);
  const ultima = [...etapas]
    .reverse()
    .find((e) => e.session_id === sessionId && e.model_usage !== null);
  const mu = ultima?.model_usage as { acumulado_sessao?: AcumuladoSessao } | null;
  return mu?.acumulado_sessao ?? null;
}

/**
 * Orçamento EFETIVO de uma etapa (`min(teto da etapa, saldo do chamado)`): o
 * mesmo valor vai no `--max-budget-usd` e no B6 (04 §4.1, lição D-033).
 * `null` = teto por chamado atingido.
 */
export function orcamentoEfetivo(
  config: ConfigResolvida,
  chave: (typeof ORCAMENTO_PERFIL)[NomePerfil],
  custoMicroUsd: number,
  teto?: number,
): number | null {
  try {
    return orcamentoEtapa(
      teto ?? config.limites.orcamento_usd[chave],
      config.limites.orcamento_usd.por_chamado - custoMicroUsd / 1_000_000,
    );
  } catch {
    return null;
  }
}

async function settingsDoPerfil(n: Nucleo, ctx: Ctx, perfil: NomePerfil) {
  const outros = await n.banco.ler(async (r) => {
    const ativas = await r.execucoes.listar({ ativas: true });
    const projetos = await r.projetos.listar();
    return {
      worktrees: ativas
        .map((e) => e.worktree_dir)
        .filter((d): d is string => !!d && d !== ctx.execucao.worktree_dir),
      execucoes: ativas.map((e) => e.id).filter((id) => id !== ctx.execucao.id),
      repos: projetos.filter((p) => p.id !== ctx.projeto.id).map((p) => p.repo_dir),
    };
  });
  const worktree = ctx.execucao.worktree_dir ?? ctx.projeto.repo_dir;
  // Modo reforçado (05 §5.1): só o condutor/implementadores (bypass) recebem o sandbox.
  const sandbox =
    perfil === 'condutor_t1'
      ? sandboxDoProjeto(ctx.config, {
          worktree,
          gitComum: await dirGitComum(ctx.projeto.repo_dir).catch(() => null),
        })
      : null;
  return gerarSettings({
    perfil,
    sandbox,
    dirDados: n.deps.dirDados,
    execucaoId: ctx.execucao.id,
    outrasExecucoes: outros.execucoes,
    worktreePropria: ctx.execucao.worktree_dir ?? ctx.projeto.repo_dir,
    worktreesExistentes: outros.worktrees,
    repoDirUsuario: ctx.projeto.repo_dir,
    reposOutrosProjetos: outros.repos,
    branchDestino: ctx.execucao.branch_destino,
  });
}

/**
 * `mcp.<n>.json` da etapa (FJ-030 §4): o MCP do Chamados somente leitura,
 * logado pelo token da sessão da conexão. Sem servidor configurado ou sem
 * sessão, a etapa roda sem MCP (o `init` então não o espera) — o app continua
 * gravando `entrada/`, que é a fonte do prompt.
 */
async function configMcpDaEtapa(n: Nucleo, ctx: Ctx): Promise<ConfigMcpGerada | null> {
  const servidor = n.deps.servidorMcp;
  if (!servidor || !n.deps.mcpChamados) return null;
  const cred = await n.deps.mcpChamados(ctx.projeto.conexao_id).catch((e: unknown) => {
    n.log(`MCP do Chamados indisponível para #${ctx.execucao.numero}: ${String(e)}`);
    return null;
  });
  if (!cred) return null;
  // O token passa a ser redigido em todo evento e barrado no outbox (05 §8.2).
  n.registrarSegredos([cred.token]);
  return gerarConfigMcp(servidor, cred, n.deps.envOrigem ?? process.env);
}

/**
 * Roda UM turno (com as repetições que a spec manda fazer dentro dele):
 * `saida_invalida` → 1 resume pedindo o schema; agente fora do papel → lista
 * negada atualizada e 1 reinício (01 §6.2). Cada processo é uma `etapa`.
 */
export async function rodarTurno(n: Nucleo, ctx: Ctx, espec: EspecTurno): Promise<FimTurno> {
  const { execucao, config } = ctx;
  if (!execucao.worktree_dir) throw new ErroForja('pre_condicao_falhou', 'execução sem worktree');
  const tipo: TipoEtapa = espec.conversar
    ? 'conversar'
    : (espec.foraDoEstado?.tipo ?? TIPO_ETAPA_PERFIL[espec.perfil]);
  const chaveOrc = ORCAMENTO_PERFIL[espec.perfil];
  const modelos =
    espec.perfil === 'planejador' ? config.modelos.planejador : config.modelos.condutor;
  const dirExec = n.dirExecucao(execucao.id);
  const dirEntrada = join(dirExec, 'entrada');
  const esperado: EstadoExecucao = espec.avulso
    ? espec.avulso.estado
    : espec.conversar
      ? 'pausado_usuario'
      : (espec.foraDoEstado?.estado ?? ESTADO_PERFIL[espec.perfil]);
  const cwd = espec.avulso?.cwd ?? execucao.worktree_dir;

  let sessao = { modo: espec.modo, sessionId: espec.sessionId };
  let prompt = espec.prompt;
  let retomarInterrompido = espec.retomarTurnoInterrompido ?? false;
  let tentativasSaida = 0;
  let perfilReiniciado = false;
  const medido = medidoVazio();

  for (;;) {
    const atual = await n.banco.ler((r) => r.execucoes.exigir(execucao.id));
    // Pausar/Parar/Descartar no prelúdio ou entre dois processos do turno: o
    // próximo `claude` NÃO sobe (03 §10). A pausa pedida vira transição no
    // `finally` do despachante.
    if (atual.estado !== esperado || (!espec.conversar && n.pausasPendentes.has(execucao.id))) {
      return { tipo: 'parado', etapa: null };
    }
    if (tetoPorChamadoAtingido(atual.custo_micro_usd, config.limites.orcamento_usd.por_chamado)) {
      return {
        tipo: 'fato',
        evento: { tipo: 'etapa_estourou', causa: 'teto_chamado' },
        etapa: null,
      };
    }
    const orcamento = orcamentoEfetivo(config, chaveOrc, atual.custo_micro_usd, espec.orcamentoUsd);
    if (orcamento === null) {
      return {
        tipo: 'fato',
        evento: { tipo: 'etapa_estourou', causa: 'teto_chamado' },
        etapa: null,
      };
    }
    const settings = await settingsDoPerfil(
      n,
      { ...ctx, execucao: espec.avulso ? { ...atual, worktree_dir: cwd } : atual },
      espec.perfil,
    );
    const campoSessao =
      espec.perfil === 'planejador' ? 'session_id_planejador' : 'session_id_condutor';
    // Nada de git dentro da transação (a fila do BancoForja pararia inteira).
    const shaInicio = await shaHead(cwd).catch(() => null);
    const etapa = await n.banco.transacao(async (r) => {
      if (!espec.conversar && !espec.avulso) {
        await r.execucoes.atualizar(execucao.id, { [campoSessao]: sessao.sessionId });
      }
      return r.etapas.criar({
        execucao_id: execucao.id,
        tipo,
        ciclo: espec.ciclo,
        papel:
          espec.perfil === 'planejador'
            ? 'planejador'
            : espec.perfil === 'condutor_t3'
              ? 'relator'
              : 'condutor',
        contrato: espec.conversar ? null : validarNomeContrato(espec.perfil),
        session_id: sessao.sessionId,
        retomada: espec.retomada ?? false,
        modelo: modelos.modelo,
        esforco: modelos.esforco,
        versao_cli: n.deps.versaoCli ?? null,
        sha_inicio: shaInicio,
      });
    });
    // Do `etapas.criar` ao fim do processo: qualquer exceção finaliza a etapa
    // (o índice `ux_etapa_sessao_executando` não pode ficar preso) e mata o
    // processo do agente, que senão seguiria editando a worktree.
    let processo: ExecucaoProcesso | null = null;
    const emCurso = {
      processo: null as unknown as ExecucaoProcesso,
      etapaId: etapa.id,
      cwd,
      parada: null as 'pausa' | 'parar' | 'cancelar' | null,
    };
    let resultado: ResultadoProcesso;
    let anterior: AcumuladoSessao | null = null;
    let sentinelaAntes: Record<string, string> | null = null;
    // O `mcp.<n>.json` leva o token da sessão do Chamados: some no fim da etapa (07 §2.6).
    let caminhoMcp: string | null = null;
    try {
      const arquivos = await gravarArquivosEtapa(dirExec, etapa.n, {
        settings,
        agentes: espec.agentes ?? null,
        sistema: espec.sistema,
        mcp: await configMcpDaEtapa(n, ctx),
      });
      caminhoMcp = arquivos.mcp;
      const negados = n.agentesNegados.get(ctx.projeto.id) ?? [...AGENTES_EMBUTIDOS_CONHECIDOS];
      // S5 (verificado) + incidente do #56 (2026-10-03): num `--resume` a CLI
      // compara `--max-budget-usd` com o ACUMULADO da sessão, não com o turno.
      // O teto da etapa continua sendo o delta; o que vai à CLI é delta + o que a
      // sessão já gastou, senão um T3 de US$ 2 nasce estourado.
      anterior = await acumuladoDaSessao(n, execucao.id, sessao.sessionId);
      const orcamentoCli = Math.floor((orcamento + (anterior?.total_cost_usd ?? 0)) * 100) / 100;
      const comando = montarComando({
        perfil: espec.perfil,
        sessao,
        conversar: espec.conversar,
        retomarTurnoInterrompido: retomarInterrompido,
        modelo: modelos.modelo,
        esforco: esforco(modelos.esforco),
        modeloSubagentes: config.modelos.subagentes.modelo,
        numeroChamado: execucao.numero,
        orcamentoUsd: orcamentoCli,
        arquivos: {
          settings: arquivos.settings,
          sistema: arquivos.sistema,
          agentes: arquivos.agentes,
          mcp: arquivos.mcp,
        },
        evidencias:
          espec.perfil === 'condutor_t1'
            ? { forjaPrint: n.deps.forjaPrint ?? null, dir: dirEvidencias(n, execucao.id) }
            : null,
        jsonSchema: espec.conversar ? null : paraJsonSchema(validarNomeContrato(espec.perfil)),
        dirEntrada: espec.perfil === 'planejador' ? dirEntrada : null,
        agentesNegados: negados,
        cwd,
        env: { envOrigem: n.deps.envOrigem ?? process.env },
        scriptsProjeto: espec.scriptsProjeto,
      });
      // Sentinela antes/depois de TODO processo com Bash (05 §4.9).
      sentinelaAntes = await medirSentinela(n, ctx.projeto.repo_dir);
      processo = n.deps.runner.iniciar(comando, {
        prompt,
        execucaoId: execucao.id,
        etapaId: etapa.id,
        timeoutMs: minutos(espec.timeoutMin ?? config.limites.timeout_min[chaveOrc]),
        avisoInatividadeMs: minutos(config.limites.timeout_min.aviso_inatividade),
        // 05 §8.2: o redator compartilhado conhece token, API keys e `.env` copiados.
        persistencia: persistenciaEmArquivos(n.dirEtapa(execucao.id, etapa.n), n.deps.redator),
      });
      emCurso.processo = processo;
      n.emCurso.set(execucao.id, emCurso);
      await n.banco.transacao(async (r) => {
        if (processo!.pid !== null) {
          await r.etapas.registrarProcesso(etapa.id, {
            pid: processo!.pid,
            pgid: processo!.pgid ?? processo!.pid,
          });
        }
        await r.etapas.atualizar(etapa.id, {
          perfil: { ...registroPerfil(comando), sha256: arquivos.sha256 } as unknown as ObjetoJson,
          transcript_path: join('etapas', String(etapa.n), 'eventos.jsonl'),
        });
      });
      await n.publicar({
        execucao_id: execucao.id,
        etapa_id: etapa.id,
        tipo: 'etapa.iniciada',
        nivel: 'info',
        resumo: `Etapa ${etapa.n}: ${tipo}${espec.retomada ? ' (retomada)' : ''}`,
        dados: {
          tipo_etapa: tipo,
          n: etapa.n,
          ciclo: espec.ciclo,
          papel: etapa.papel,
          session_id: sessao.sessionId,
          retomada: espec.retomada ?? false,
          modelo: modelos.modelo,
        },
      });

      // Stream: grava cada evento antes de chegar à UI (01 §6.7 "Durabilidade").
      for await (const ev of processo.eventos) {
        if (ev.tipo === 'evento') {
          const novo = ev.evento as NovoEventoForja;
          medirEvento(novo, medido);
          await n.publicar(novo, 'cli');
          await n.banco.transacao((r) => r.etapas.registrarAtividade(etapa.id, n.iso()));
        } else if (ev.tipo === 'uso') {
          const freio = avaliarFreio(
            { ...ev.snapshot, medido_em: n.iso() },
            config.limites.freio_cota ?? LIMIARES_PADRAO,
            n.agora(),
          );
          await n.banco.transacao((r) =>
            r.usoAssinatura.registrar({
              ...ev.snapshot,
              bruto: ev.snapshot.bruto as unknown as JsonLivre,
              etapa_id: etapa.id,
            }),
          );
          await n.publicar(eventoUsoAtualizado(ev.snapshot, freio.ativo));
        } else if (ev.tipo === 'checkpoint') {
          if (ev.emVoo === 0 && espec.aoCheckpoint) await espec.aoCheckpoint();
        } else if (ev.tipo === 'init') {
          await n.banco.transacao((r) =>
            r.etapas.atualizar(etapa.id, {
              init: ev.validacao.recorte as unknown as ObjetoJson,
            }),
          );
        }
      }
      resultado = await processo.resultado;
    } catch (e) {
      if (processo) {
        await processo.cancelar().catch(() => undefined);
        if (n.deps.varrerCwd) await n.deps.varrerCwd(emCurso.cwd).catch(() => 0);
      }
      await n.banco
        .transacao((r) =>
          r.etapas.finalizar(etapa.id, {
            estado: 'falhou',
            motivo_fim: 'erro_execucao',
            sha_fim: null,
          }),
        )
        .catch(() => undefined);
      throw e;
    } finally {
      if (n.emCurso.get(execucao.id) === emCurso) n.emCurso.delete(execucao.id);
      if (caminhoMcp) await rm(caminhoMcp, { force: true }).catch(() => undefined);
    }

    // Telemetria e custo (delta da sessão, S5).
    let custoMicro = 0;
    let custo: CustoTurnoDelta | null = null;
    if (resultado.final) {
      custo = calcularCustoTurno(resultado.final, anterior, true);
      custoMicro = microUsd(custo.custo_usd);
      await n.publicar(
        eventoTelemetriaTurno(
          { execucaoId: execucao.id, etapaId: etapa.id },
          resultado.final,
          custo,
          resultado.classificacao,
        ),
      );
    }
    if (resultado.agentesForaDoPapel.length > 0) {
      const negados = n.agentesNegados.get(ctx.projeto.id) ?? [...AGENTES_EMBUTIDOS_CONHECIDOS];
      n.agentesNegados.set(
        ctx.projeto.id,
        atualizarAgentesNegados(negados, resultado.agentesForaDoPapel),
      );
    }
    const shaFim = await shaHead(cwd).catch(() => null);
    const fim = await n.banco.transacao(async (r) => {
      if (custoMicro > 0) await r.execucoes.somarCusto(execucao.id, custoMicro);
      return r.etapas.finalizar(etapa.id, {
        estado: estadoEtapaDaClassificacao(resultado.classificacao),
        motivo_fim: resultado.classificacao,
        exit_code: resultado.exitCode,
        sinal: resultado.sinal,
        custo_micro_usd: resultado.final ? custoMicro : null,
        model_usage: resultado.final
          ? ({
              delta: custo?.model_usage_delta ?? {},
              acumulado_sessao: {
                total_cost_usd: resultado.final.total_cost_usd,
                modelUsage: resultado.final.modelUsage,
              },
            } as unknown as JsonLivre)
          : null,
        subagent_stats: (resultado.final?.subagent_stats ?? null) as JsonLivre,
        permission_denials: (resultado.final?.permission_denials ?? null) as JsonLivre,
        sha_fim: shaFim,
      });
    });
    await n.publicar({
      execucao_id: execucao.id,
      etapa_id: etapa.id,
      tipo: 'etapa.finalizada',
      nivel: resultado.classificacao === 'concluido' ? 'info' : 'aviso',
      resumo: `Etapa ${etapa.n}: ${tipo} → ${resultado.classificacao}`,
      dados: {
        tipo_etapa: tipo,
        n: etapa.n,
        motivo_fim: resultado.classificacao,
        custo_micro_usd: resultado.final ? custoMicro : null,
        duracao_ms: resultado.duracaoMs,
      },
    });
    // Sentinela (05 §4.9) só registra e avisa (FJ-035): a execução segue.
    await registrarDivergencias(
      n,
      execucao.id,
      sentinelaAntes,
      await medirSentinela(n, ctx.projeto.repo_dir),
    );

    // Retomada que falhou logo de cara → sessão nova (01 §6.7 passo 3).
    if (sessao.modo === 'resume' && retomarInterrompido && resumeFalhou(resultado)) {
      sessao = { modo: 'novo', sessionId: n.novoSessionId() };
      retomarInterrompido = false;
      prompt = espec.promptSessaoNova ?? espec.prompt;
      continue;
    }

    const desfecho = desfechoDaClassificacao(resultado.classificacao, {
      tentativasSaidaInvalida: tentativasSaida,
      agentesForaDoPapel: resultado.agentesForaDoPapel.length,
      perfilJaReiniciado: perfilReiniciado,
      paradaPedida: emCurso.parada !== null,
    });
    switch (desfecho.tipo) {
      case 'ok':
        return {
          tipo: 'ok',
          saida: resultado.saida,
          etapa: fim,
          resultado,
          sessionId: sessao.sessionId,
          custo,
          medido,
        };
      case 'parado':
        return { tipo: 'parado', etapa: fim };
      case 'repetir_saida':
        tentativasSaida += 1;
        sessao = { modo: 'resume', sessionId: sessao.sessionId };
        retomarInterrompido = false;
        prompt = montarPromptCorrecao(
          resultado.errosContrato.length
            ? resultado.errosContrato
            : ['a saída estruturada não veio ou não passou no schema do turno'],
        );
        continue;
      case 'reiniciar_perfil':
        perfilReiniciado = true;
        // Reusar `--session-id` depois de um kill não é verificado (cli.md): sessão nova.
        sessao = {
          modo: sessao.modo === 'novo' ? 'novo' : 'resume',
          sessionId: sessao.modo === 'novo' ? n.novoSessionId() : sessao.sessionId,
        };
        continue;
      case 'fato':
        if (desfecho.alerta === 'autenticacao') {
          await n.publicar({
            execucao_id: execucao.id,
            etapa_id: etapa.id,
            tipo: 'cli.alerta',
            nivel: 'erro',
            resumo: 'A CLI perdeu a autenticação: rode `claude auth login` e tente de novo',
            dados: { codigo: 'autenticacao', bloqueante: true },
          });
        }
        if (resultado.classificacao === 'cota')
          await registrarCotaRejeitada(n, etapa.id, resultado);
        return { tipo: 'fato', evento: desfecho.evento, etapa: fim };
    }
  }
}

const FERRAMENTAS_AGENT = new Set(['Agent', 'Task']);

/**
 * Acumula o que o stream MEDIU (04 §9): edição do condutor, chamadas de
 * subagente e os Bash com o resultado (FJ-032).
 */
export function medirEvento(ev: NovoEventoForja, medido: MedidoTurno): void {
  const dados = ev.dados as Record<string, unknown> | null | undefined;
  if (!dados) return;
  if (ev.tipo === 'agente.ferramenta' && dados.ferramenta === 'Bash') {
    medido.bash.push({
      tool_use_id: String(dados.tool_use_id ?? ''),
      comando: String(dados.resumo_entrada ?? ''),
      resultado: 'sem_resultado',
    });
  } else if (ev.tipo === 'agente.resultado_ferramenta') {
    const id = String(dados.tool_use_id ?? '');
    const b = id ? medido.bash.find((x) => x.tool_use_id === id) : undefined;
    if (b) b.resultado = dados.erro === true ? 'erro' : 'exit_0';
  }
  if (ev.tipo === 'agente.fora_do_papel') {
    const ferramenta = dados.ferramenta;
    if (ferramenta === 'Edit' || ferramenta === 'Write' || ferramenta === 'Bash') {
      medido.fora_do_papel.push({ ferramenta, alvo: String(dados.alvo ?? '') });
    }
  } else if (
    ev.tipo === 'agente.ferramenta' &&
    typeof dados.subagente === 'string' &&
    FERRAMENTAS_AGENT.has(String(dados.ferramenta))
  ) {
    medido.subagentes[dados.subagente] = (medido.subagentes[dados.subagente] ?? 0) + 1;
  }
}

function validarNomeContrato(perfil: NomePerfil) {
  return (
    {
      planejador: 'plano.v1',
      condutor_t1: 'resumo_impl.v1',
      condutor_t2: 'veredito.v1',
      condutor_t3: 'relatorio.v1',
    } as const
  )[perfil];
}

/**
 * Limite batido no meio (03 §7.6): a CLI disse `rejected`. Grava a leitura em
 * `uso_assinatura` com o `resetsAt` — é o que liga o freio para as outras e o
 * que `pausado_cota` usa para "retoma às HH:MM".
 */
async function registrarCotaRejeitada(n: Nucleo, etapaId: string, r: ResultadoProcesso) {
  const reset = r.resetsAt ?? new Date(n.agora().getTime() + 5 * 3600_000).toISOString();
  await n.banco.transacao((repo) =>
    repo.usoAssinatura.registrar({
      etapa_id: etapaId,
      utilizacao_5h: 1,
      utilizacao_7d: null,
      reinicia_5h_em: reset,
      reinicia_7d_em: null,
      status: 'rejected',
      status_overage: null,
      usando_creditos_extras: null,
      bruto: { origem: 'result_cota', resetsAt: reset },
    }),
  );
}

/** Pausar/parar/cancelar o processo de agente em curso (03 §10). */
export async function interromperProcesso(
  n: Nucleo,
  execucaoId: string,
  como: 'pausa' | 'parar' | 'cancelar',
): Promise<boolean> {
  const p = n.emCurso.get(execucaoId);
  if (!p) return false;
  p.parada = como;
  if (como === 'pausa') await p.processo.pausar();
  else await p.processo.cancelar();
  // [V S4] os comandos do Bash do agente ficam fora do grupo: varre o cwd.
  if (n.deps.varrerCwd) await n.deps.varrerCwd(p.cwd).catch(() => 0);
  return true;
}

// ---------------------------------------------------------------------------
// preparando (03 §2.4, §4.1, §5.1)
// ---------------------------------------------------------------------------

export type ResultadoPreparo = 'planejando' | 'aguardar' | 'outro';

/**
 * Relê o chamado, confere as pré-condições de G0, cria a worktree (com os
 * `arquivos_locais`) e dispara a rodada de início do outbox. Sem `setup` e sem
 * linha de base (FJ-032): a Forja não executa comandos do projeto — instalar e
 * checar é do agente. Devolve `aguardar` quando a pendência é transitória
 * (conexão/CLI, 03 §11).
 */
export async function preparar(
  n: Nucleo,
  execucaoId: string,
  rodadaInicio: (execucaoId: string) => Promise<void>,
): Promise<ResultadoPreparo> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const fonte = n.fonte(execucao.conexao_id);
  if (!fonte || !fonte.podeUsar()) return 'aguardar';
  let detalhe: RespostaDetalheChamado;
  try {
    detalhe = await fonte.api.obterChamado(execucao.chamado_id, { formato: 'markdown' });
  } catch {
    return 'aguardar';
  }
  const sinais = sinaisDoDetalhe(detalhe);
  await n.banco.transacao(async (r) => {
    await r.chamados.gravarDaLista({
      conexao_id: execucao.conexao_id,
      chamado_id: execucao.chamado_id,
      numero: detalhe.chamado.numero,
      titulo: detalhe.chamado.titulo,
      status: detalhe.chamado.status,
      natureza: detalhe.chamado.natureza,
      prioridade: detalhe.chamado.prioridade,
      complexidade: detalhe.chamado.complexidade ?? null,
      sistema_nome: detalhe.chamado.sistema_nome,
      atualizado_em_remoto: detalhe.chamado.updated_at,
    });
    await r.chamados.gravarDetalhe(execucao.chamado_cache_id, {
      sinais: {
        tem_spec_ia: sinais.tem_spec_ia,
        tem_diagnostico_ia: sinais.tem_diagnostico_ia,
        tem_pr_ia: sinais.tem_pr_ia,
        branch_ia: sinais.branch_ia,
      },
      ia_silenciada: sinais.ia_silenciada,
      ultima_mensagem_id: detalhe.mensagens.at(-1)?.id ?? null,
      ultima_mensagem_em: detalhe.mensagens.at(-1)?.created_at ?? null,
    });
  });
  const branchExiste =
    (await resolverSha(projeto.repo_dir, `refs/heads/${execucao.branch_destino}`)) !== null;
  const avaliacao = avaliarPreCondicoesG0({
    chamado: { status: detalhe.chamado.status, natureza: detalhe.chamado.natureza },
    projeto: {
      projeto_id: projeto.id,
      mapeamento_id: 'execucao',
      via: 'id',
      converter_para_id: null,
    },
    execucaoAtiva: false,
    conexaoOk: true,
    pipelineDesbloqueado: n.cliCompativel(),
    prIa: null,
    branch_destino_existe: branchExiste,
  });
  const d = avaliacao.decisao_preparo;
  if (!d.ok) {
    if (d.acao === 'aguardar') return 'aguardar';
    await n.transicionar(execucaoId, {
      tipo: 'preparo_concluido',
      pre_condicoes:
        d.acao === 'precisa_humano'
          ? { ok: false, motivo: d.motivo, texto: d.texto }
          : { ok: true },
      worktree_ok: d.acao !== 'falhou',
      texto: d.texto,
    });
    return 'outro';
  }

  // URL do remoto fixada antes de qualquer agente do projeto rodar (05 §9).
  await capturarUrlRemoto(n, projeto.id);

  // Worktree (01 §9.1): reaproveita a de uma tentativa anterior desta execução.
  let atual = execucao;
  if (!atual.worktree_dir || !existsSync(atual.worktree_dir)) {
    try {
      const wt = await criarWorktreeExecucao({
        repoDir: projeto.repo_dir,
        dirDados: n.deps.dirDados,
        projetoSlug: projeto.slug,
        execucaoId,
        numero: execucao.numero,
        titulo: detalhe.chamado.titulo,
        branchDestino: execucao.branch_destino,
        prefixoBranch: config.repo.prefixo_branch,
        arquivosLocais: config.arquivos_locais,
      });
      atual = await n.banco.transacao((r) =>
        r.execucoes.atualizar(execucaoId, {
          worktree_dir: wt.dir,
          branch: wt.branch,
          sha_base: wt.shaBase,
          sha_atual: wt.shaBase,
        }),
      );
    } catch (e) {
      await n.transicionar(execucaoId, {
        tipo: 'preparo_concluido',
        pre_condicoes: { ok: true },
        worktree_ok: false,
        texto: `worktree: ${(e as Error).message}`,
      });
      return 'outro';
    }
  }

  // Valores dos `arquivos_locais` copiados: redigidos e barrados no outbox (05 §8.2).
  n.registrarSegredos(await valoresDeArquivosLocais(config, atual.worktree_dir as string));

  // Rodada de início do outbox (atribuir → nota_inicio, 03 §9.1). Sem
  // `silenciar_ia` e sem esperar por ele (FJ-031): a IA do servidor não
  // interfere na Forja.
  await rodadaInicio(execucaoId);
  const depoisRodada = await n.banco.ler((r) => r.execucoes.exigir(execucaoId));
  if (depoisRodada.estado !== 'preparando') return 'outro';

  const r = await n.transicionar(execucaoId, {
    tipo: 'preparo_concluido',
    pre_condicoes: { ok: true },
    worktree_ok: true,
  });
  return r.execucao.estado === 'planejando' ? 'planejando' : 'outro';
}

// ---------------------------------------------------------------------------
// planejando → plano_pronto → G1/Gdec (03 §3.1, §4; 04 §6)
// ---------------------------------------------------------------------------

function dadosDoCliente(d: RespostaDetalheChamado): DadosClientePlanejador {
  const notasIa = extrairNotasIa(d.mensagens);
  const textoIa = [notasIa.spec, notasIa.diagnostico]
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .map((x) => x.mensagem.corpo)
    .join('\n\n');
  const msg = (m: RespostaDetalheChamado['mensagens'][number]) => ({
    autor: m.autor_nome ?? '(sem nome)',
    papel: m.autor_papel ?? 'desconhecido',
    em: m.created_at ?? '',
    texto: m.corpo,
  });
  return {
    metadados: {
      numero: String(d.chamado.numero),
      titulo: d.chamado.titulo,
      status: d.chamado.status,
      natureza: d.chamado.natureza,
      prioridade: d.chamado.prioridade,
      sistema: d.chamado.sistema_nome ?? '',
    },
    descricao: d.chamado.descricao,
    conversaPublica: d.mensagens.filter((m) => m.visibilidade !== 'interna').map(msg),
    notasInternas: d.mensagens
      .filter((m) => m.visibilidade === 'interna' && m.autor_papel !== 'agente_ia')
      .map(msg),
    analiseIaServidor: textoIa || null,
    anexos: d.chamado.anexos.map((a) => a.nome_arquivo),
  };
}

/** Comentários/decisões humanos ainda não entregues ao planejador (G1 "Comentar", Gdec "Eu decido"). */
async function insumosHumanosDoPlano(n: Nucleo, execucaoId: string, ciclo: number) {
  return n.banco.ler(async (r) =>
    (await r.comentarios.pendentes(execucaoId, ciclo)).filter((c) => c.alvo === 'plano'),
  );
}

/**
 * `planejando` (03 §3.1). Devolve `aguardar` quando a conexão com o Chamados
 * não está utilizável ou o chamado não pôde ser lido (transitório, como em
 * `preparar`): o despachante adia em vez de relançar a etapa em laço.
 */
export async function planejar(n: Nucleo, execucaoId: string): Promise<'aguardar' | void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const fonte = n.fonte(execucao.conexao_id);
  if (!fonte || !fonte.podeUsar()) return 'aguardar';
  let bruto: RespostaDetalheChamado;
  try {
    bruto = await fonte.api.obterChamado(execucao.chamado_id, { formato: 'markdown' });
  } catch (e) {
    n.log(`planejar #${execucao.numero}: Chamados indisponível (${(e as Error).message})`);
    return 'aguardar';
  }
  // Entrada sanitizada pelo app (05 §4.3): nunca a resposta crua da API.
  const detalhe = detalheSanitizado(bruto);
  const dirEntrada = join(n.dirExecucao(execucaoId), 'entrada');
  await mkdir(dirEntrada, { recursive: true, mode: 0o700 });
  const anexos = await baixarAnexos(fonte.api, bruto, dirEntrada);
  await writeFile(join(dirEntrada, 'chamado.md'), chamadoMarkdown(detalhe, anexos), {
    mode: 0o600,
  });
  const ciclo = execucao.ciclo_total + 1;
  const comentarios = await insumosHumanosDoPlano(n, execucaoId, ciclo);
  const secoes: SecaoInsumo[] = comentarios.map((c) => ({
    titulo: 'Decisão/comentário do operador',
    conteudo: c.texto,
    origem: 'humano',
  }));
  const prompt = montarPromptTurno({
    perfil: 'planejador',
    regrasRepositorio: await regrasDoRepositorio(projeto.repo_dir, execucao.sha_base),
    arquivosLocais: destinosLocais(config),
    insumos: secoes,
    orcamento: {
      orcamentoUsd:
        orcamentoEfetivo(config, 'planejar', execucao.custo_micro_usd) ??
        config.limites.orcamento_usd.planejar,
      timeoutMin: config.limites.timeout_min.planejar,
    },
    dadosCliente: { ...dadosDoCliente(detalhe), anexos },
    dirEntrada,
  });
  const etapas = await etapasDa(n, execucaoId);
  const retomar = etapaParaRetomar(etapas, 'planejar', ciclo);
  const sessao = execucao.session_id_planejador;
  let fim = await rodarTurno(n, ctx, {
    perfil: 'planejador',
    sessionId: retomar?.session_id ?? sessao ?? n.novoSessionId(),
    modo: retomar || sessao ? 'resume' : 'novo',
    retomarTurnoInterrompido: retomar !== null,
    retomada: retomar !== null,
    prompt: retomar ? montarPromptRetomada('retome o plano do ponto em que parou') : prompt.stdin,
    promptSessaoNova: prompt.stdin,
    sistema: prompt.sistema,
    ciclo,
  });
  let recusas = 0;
  for (;;) {
    if (fim.tipo === 'parado') return;
    if (fim.tipo === 'fato') {
      await aplicarFato(n, execucaoId, fim.evento, 'planejando');
      return;
    }
    const plano = fim.saida as PlanoV1;
    const val = validarPlano(plano, { arquivos_locais: destinosLocais(config) });
    const recusa = decidirRecusa(val.erros, recusas);
    if (recusa.acao === 'recusar') {
      recusas += 1;
      fim = await rodarTurno(n, ctx, {
        perfil: 'planejador',
        sessionId: fim.sessionId,
        modo: 'resume',
        prompt: montarPromptCorrecao(recusa.erros),
        sistema: prompt.sistema,
        ciclo,
      });
      continue;
    }
    if (recusa.acao === 'precisa_humano') {
      await aplicarFato(
        n,
        execucaoId,
        { tipo: 'regra_conteudo_persistente', erros: recusa.erros },
        'planejando',
      );
      return;
    }
    const custo = fim.custo;
    const chamadoCache = await n.banco.ler((r) => r.chamados.obter(execucao.chamado_cache_id));
    // FJ-033: o planejador decide — perguntas/decisões com suposição/recomendação
    // viram `suposicoes` ANTES do Gdec, e o plano normalizado é o oficial.
    const { plano: normalizado } = assumirDecisoes(plano);
    const g1 = avaliarG1(normalizado, {
      gate_plano: config.gates.plano,
      em_lote: execucao.lote_id !== null,
      complexidade: chamadoCache?.complexidade ?? null,
      trabalho_existente: chamadoCache?.sinais.tem_pr_ia ?? false,
    });
    const registrado = planoRegistrado({
      plano: normalizado,
      arquivos_previstos: val.arquivos_previstos,
      sha_base: execucao.sha_base ?? '0'.repeat(40),
      gate_g1: g1.gate_g1,
      avisos: g1.avisos,
      editado: false,
      prompt_versao: prompt.versao,
      custo,
    });
    const etapaId = fim.etapa.id;
    await n.transicionar(
      execucaoId,
      { tipo: 'plano_produzido', result_sem_erro: true, contrato_valido: true, regras_ok: true },
      {
        dentro: async (r) => {
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'plano',
            contrato: 'plano.v1',
            conteudo: registrado as unknown as JsonLivre,
          });
          await r.comentarios.marcarConsumidos(comentarios.map((c) => c.id));
        },
      },
    );
    await n.transicionar(execucaoId, { tipo: 'plano_avaliado', decisao: g1.decisao });
    return;
  }
}

/** `plano_pronto` sem tarefa (reboot entre o plano e o gate): reavalia o G1 sobre o artefato. */
export async function reavaliarPlano(n: Nucleo, execucaoId: string): Promise<void> {
  const { execucao, config } = await n.carregar(execucaoId);
  const plano = await planoOficial(n, execucaoId);
  // Sem o artefato não há o que reavaliar: erro interno (→ `falhou`), nunca laço.
  if (!plano) throw new Error('plano_pronto sem artefato de plano');
  const cache = await n.banco.ler((r) => r.chamados.obter(execucao.chamado_cache_id));
  // FJ-033: artefato anterior à normalização → assume e grava a versão normalizada.
  // FJ-034: e recalcula os avisos ⚙ com o gate atual.
  const { plano: normalizado, assumidas } = assumirDecisoes(plano);
  const g1 = avaliarG1(normalizado, {
    gate_plano: config.gates.plano,
    em_lote: execucao.lote_id !== null,
    complexidade: cache?.complexidade ?? null,
    trabalho_existente: cache?.sinais.tem_pr_ia ?? false,
  });
  const oficial: PlanoRegistrado = { ...normalizado, gate_g1: g1.gate_g1, avisos: g1.avisos };
  await n.transicionar(
    execucaoId,
    { tipo: 'plano_avaliado', decisao: g1.decisao },
    // FJ-033/FJ-034: grava nova versão se assumiu algo ou se os avisos ⚙ mudaram.
    assumidas.length > 0 ||
      JSON.stringify((plano.avisos as string[] | undefined) ?? []) !== JSON.stringify(g1.avisos)
      ? {
          dentro: async (r) => {
            await r.artefatos.criar({
              execucao_id: execucaoId,
              tipo: 'plano',
              contrato: 'plano.v1',
              conteudo: oficial as unknown as JsonLivre,
            });
          },
        }
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Evidência visual (FJ-026; FJ-030 §3): o agente fotografa, o app coleta
// ---------------------------------------------------------------------------

async function sha256Arquivo(caminho: string): Promise<{ sha256: string; tamanho: number }> {
  const buf = await readFile(caminho);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    tamanho: (await stat(caminho)).size,
  };
}

/** O plano prevê UI (fatos do G2/T3; desde FJ-031 o B7 vai em todo T1). */
export function planoComUi(plano: PlanoV1 | null, config: ConfigResolvida): boolean {
  if (!plano) return false;
  return planoPreveUi(plano, (c) => casaAlgum(c, config.detectores.frontend));
}

/**
 * A coleta no fim do T1 é obrigatória (sem `telas.json` = sem evidência) quando
 * o plano prevê UI OU o selo `altera_ui` já ligou numa verificação (FJ-030 §3).
 * O B7 em si vai em todo T1 (FJ-031): sem UI, o agente declara `nao_se_aplica`.
 */
export function precisaEvidencias(ctx: Ctx, plano: PlanoV1 | null): boolean {
  return planoComUi(plano, ctx.config) || (ctx.execucao.selos?.altera_ui ?? false);
}

/** UI da mudança como o selo `altera_ui` a vê (04 §7.1): contesta um `nao_se_aplica` (FJ-031). */
export function uiDaMudanca(
  arquivos: readonly string[],
  config: ConfigResolvida,
  plano: Pick<PlanoV1, 'areas'> | null,
): UiDaMudanca {
  const frontend = arquivos.filter((a) => casaAlgum(a, config.detectores.frontend));
  return { ligado: frontend.length > 0 || (plano?.areas ?? []).includes('ui'), arquivos: frontend };
}

/** `<exec>/evidencias/` (o agente escreve; `FORJA_EVIDENCIAS_DIR`). */
export function dirEvidencias(n: Nucleo, execucaoId: string): string {
  return join(n.dirExecucao(execucaoId), DIR_EVIDENCIAS);
}

/** Capturas `antes` já registradas desta execução. */
export async function capturasAntes(n: Nucleo, execucaoId: string): Promise<CapturaRegistrada[]> {
  return capturasDoMomento(n, execucaoId, 'antes');
}

async function capturasDoMomento(
  n: Nucleo,
  execucaoId: string,
  momento: MomentoEvidencia,
  sha?: string,
): Promise<CapturaRegistrada[]> {
  const etapas = await etapasDa(n, execucaoId);
  const porTela = new Map<string, CapturaRegistrada>();
  for (const e of etapas) {
    if (e.tipo !== 'evidenciar' || e.telas?.momento !== momento) continue;
    if (sha && e.sha_inicio !== sha) continue;
    // A coleta mais nova vale (o agente refez o `depois` no retrabalho).
    for (const t of e.telas.telas) porTela.set(t.tela_id, t);
  }
  return [...porTela.values()];
}

/**
 * Hora do primeiro checkpoint da execução (`sha_base..HEAD`, o commit mais
 * antigo): o `antes` tem de ser anterior a ela (FJ-030 §3). `null` = nenhum
 * commit ainda.
 */
export async function primeiroCheckpointEm(execucao: Execucao): Promise<Date | null> {
  if (!execucao.worktree_dir || !execucao.sha_base) return null;
  const saida = await gitSaida(
    ['log', '--reverse', '--format=%cI', `${execucao.sha_base}..HEAD`],
    execucao.worktree_dir,
  ).catch(() => '');
  const primeira = saida.split('\n').find((l) => l.trim());
  if (!primeira) return null;
  const d = new Date(primeira.trim());
  // O git guarda segundos: o fim do segundo do commit é o limite (um `antes`
  // no mesmo segundo do primeiro commit não é suspeito; minutos depois, é).
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 999);
}

/**
 * Coleta (FJ-030 §3): lê `evidencias/telas.json` que o agente escreveu, valida
 * os PNGs e registra `etapa` `evidenciar` (uma por momento) + `artefato`
 * `evidencia` por imagem, no `sha` dado. Nunca lança por conteúdo do agente.
 */
export async function coletarERegistrar(
  n: Nucleo,
  ctx: Ctx,
  sha: string,
  ui: UiDaMudanca | null = null,
): Promise<ResultadoColeta> {
  const { execucao } = ctx;
  const dirExec = n.dirExecucao(execucao.id);
  const coleta = await n.verificacao.coletarEvidencias(
    dirExec,
    await primeiroCheckpointEm(execucao),
    ui,
  );
  for (const momento of ['antes', 'depois'] as const) {
    const comImagem = coleta.telas.filter((t) => t[momento] !== null || momento === 'antes');
    if (coleta.telas.length === 0 || comImagem.length === 0) continue;
    const etapa = await n.banco.transacao((r) =>
      r.etapas.criar({
        execucao_id: execucao.id,
        tipo: 'evidenciar',
        ciclo: execucao.ciclo_total + 1,
        sha_inicio: sha,
      }),
    );
    const registradas: NonNullable<Etapa['telas']>['telas'] = [];
    for (const t of coleta.telas) {
      const img = t[momento];
      let artefatoId: string | null = null;
      if (img) {
        const a = await n.banco.transacao((r) =>
          r.artefatos.criar({
            execucao_id: execucao.id,
            etapa_id: etapa.id,
            tipo: 'evidencia',
            caminho: img.caminho,
            sha256: img.sha256,
            tamanho_bytes: img.tamanho,
            sha_git: momento === 'antes' ? (execucao.sha_base ?? sha) : sha,
            conteudo: {
              momento,
              tela_id: t.tela_id,
              rota: t.rota,
              descricao: t.descricao,
              resultado: momento === 'antes' ? t.resultado_antes : t.resultado_depois,
              largura: img.largura,
              altura: img.altura,
              antes_suspeito: momento === 'antes' ? t.antes_suspeito : false,
              motivo_sem_antes: t.motivo_sem_antes,
              problemas: t.problemas,
            },
          }),
        );
        artefatoId = a.id;
      }
      registradas.push({
        tela_id: t.tela_id,
        rota: t.rota,
        resultado: momento === 'antes' ? t.resultado_antes : t.resultado_depois,
        artefato_id: artefatoId,
        duracao_ms: 0,
      });
    }
    await n.banco.transacao((r) =>
      r.etapas.finalizar(etapa.id, {
        estado: 'concluida',
        motivo_fim: 'concluido',
        sha_fim: sha,
        telas: { momento, telas: registradas },
      }),
    );
  }
  await n.publicar({
    execucao_id: execucao.id,
    etapa_id: null,
    tipo: 'cli.alerta',
    nivel:
      coleta.evidencia_visual === 'completa' || coleta.evidencia_visual === 'nao_se_aplica'
        ? 'info'
        : 'aviso',
    resumo: `#${execucao.numero}: evidências do agente — ${coleta.evidencia_visual}${coleta.motivo ? ` (${coleta.motivo})` : ''}`,
    dados: { codigo: 'evidencias_coletadas', bloqueante: false },
  });
  return coleta;
}

/** Telas dos fatos do T3/G2: plano ∪ resumo ∪ o que o agente fotografou (por `tela_id`). */
async function telasComColeta(
  n: Nucleo,
  execucaoId: string,
  plano: PlanoV1 | null,
  resumo: Pick<ResumoImplV1, 'telas_afetadas'> | null,
): Promise<{ id: string; rota: string; estado_esperado: string }[]> {
  const telas: { id: string; rota: string; estado_esperado: string }[] = telasDaExecucao(
    plano,
    resumo,
  );
  for (const c of await capturasDoMomento(n, execucaoId, 'depois')) {
    if (!telas.some((t) => t.id === c.tela_id)) {
      telas.push({
        id: c.tela_id,
        rota: c.rota,
        estado_esperado: '(tela fotografada pelo agente)',
      });
    }
  }
  return telas;
}

// ---------------------------------------------------------------------------
// implementando — T1 (03 §3.2, §3.3)
// ---------------------------------------------------------------------------

async function insumosDoT1(n: Nucleo, ctx: Ctx, ciclo: number) {
  const { execucao, config } = ctx;
  const plano = await planoOficial(n, execucao.id);
  const etapas = await etapasDa(n, execucao.id);
  const anterior = [...etapas]
    .reverse()
    .find((e) => e.tipo !== 'conversar' && e.tipo !== 'evidenciar');
  const comentarios = await n.banco.ler((r) => r.comentarios.pendentes(execucao.id, ciclo));
  const decisoes = await n.banco.ler(async (r) =>
    (await r.comentarios.listar(execucao.id)).filter((c) => c.alvo === 'plano').map((c) => c.texto),
  );
  let retrabalho: { instrucoes: string; achados: unknown } | null = null;
  // A reverificação do revisor na fila de merge (FJ-032) também é um `revisar`.
  if (anterior?.tipo === 'revisar') {
    const v = (await ultimoArtefato<VereditoRegistrado>(n, execucao.id, 'veredito'))?.conteudo;
    if (v) retrabalho = { instrucoes: v.instrucoes_para_retrabalho, achados: v.achados };
  }
  const estadoAtual =
    ciclo > 1 || etapas.some((e) => e.tipo === 'implementar')
      ? {
          commits: await gitSaida(
            ['log', '--oneline', `${execucao.sha_base}..HEAD`],
            execucao.worktree_dir as string,
          ),
          diffStat: await diffStatTexto(
            execucao.worktree_dir as string,
            execucao.sha_base as string,
            'HEAD',
          ),
        }
      : null;
  return {
    plano,
    comentarios,
    secoes: insumosT1({
      plano,
      ciclo,
      decisoesOperador: decisoes,
      comentariosHumanos: comentarios
        .filter((c) => c.alvo !== 'plano')
        .map((c) =>
          c.arquivo ? `${c.arquivo}${c.linha ? `:${c.linha}` : ''}: ${c.texto}` : c.texto,
        ),
      scripts: await scriptsDoProjeto(config, execucao.worktree_dir),
      retrabalho,
      estadoAtual,
    }),
  };
}

/**
 * Comandos de verificação/instalação vistos no stream (FJ-032), sem repetição
 * (fica o último resultado de cada comando).
 */
export function comandosDeVerificacaoDoStream(bash: readonly ComandoDoStream[]): ComandoDoStream[] {
  const porComando = new Map<string, ComandoDoStream>();
  for (const b of bash) {
    if (!ehComandoDeVerificacao(b.comando)) continue;
    porComando.delete(b.comando);
    porComando.set(b.comando, { comando: b.comando, resultado: b.resultado });
  }
  return [...porComando.values()];
}

/** Opções de checkpoint da execução: locais fora do commit e HEAD na branch dela (05 §8, 03 §3.3). */
export function opcoesCheckpoint(execucao: Execucao, config: ConfigResolvida) {
  return { excluir: destinosLocais(config), branch: execucao.branch };
}

export async function implementar(n: Nucleo, execucaoId: string): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const dir = execucao.worktree_dir as string;
  const ciclo = execucao.ciclo_total + 1;
  const { plano, comentarios, secoes } = await insumosDoT1(n, ctx, ciclo);
  if (!plano) throw new ErroForja('pre_condicao_falhou', 'implementar sem plano oficial');
  const regras = await regrasDoRepositorio(projeto.repo_dir, execucao.sha_base);
  const locais = destinosLocais(config);
  const opCp = opcoesCheckpoint(execucao, config);
  // B7 (FJ-030 §3; FJ-031): vai em TODO T1, condicional — se alterar UI, o
  // condutor sobe o app e fotografa; se não, declara `nao_se_aplica`. No
  // retrabalho o `antes` já existe (tirado no `sha_base`): refaz só o `depois`.
  const comEvidencias = precisaEvidencias(ctx, plano);
  const jaTemAntes = (await capturasAntes(n, execucaoId)).some((c) => c.artefato_id !== null);
  const prompt = montarPromptTurno({
    perfil: 'condutor_t1',
    regrasRepositorio: regras,
    arquivosLocais: locais,
    evidencias: {
      forjaPrint: n.deps.forjaPrint ?? null,
      dirEvidencias: dirEvidencias(n, execucaoId),
      somenteDepois: jaTemAntes,
      telasDoPlano: plano.telas_afetadas.map((t) => ({ id: t.id, rota: t.rota })),
    },
    insumos: secoes,
    orcamento: {
      orcamentoUsd:
        orcamentoEfetivo(config, 'implementar', execucao.custo_micro_usd) ??
        config.limites.orcamento_usd.implementar,
      timeoutMin: config.limites.timeout_min.implementar,
    },
  });
  const agentes = gerarAgentesT1({
    modelo: config.modelos.subagentes.modelo,
    esforco: esforco(config.modelos.subagentes.esforco_implementador),
    promptImplementador: montarPromptSubagente('implementador', regras, locais).prompt,
  });
  const checkpoints: string[] = [];
  let passo = 0;
  // HEAD fora da branch da execução (git switch/branch -f pelo agente): o app
  // não commita e para o turno — nada avança `main` localmente (05 §9).
  let violacao: string | null = null;
  const aoCheckpoint = async () => {
    if (violacao) return;
    passo += 1;
    let cp;
    try {
      cp = await commitCheckpoint(dir, mensagemPasso(passo, execucao.numero), opCp);
    } catch (e) {
      if (!(e instanceof ErroCheckpointBranch)) throw e;
      violacao = e.message;
      await interromperProcesso(n, execucaoId, 'cancelar').catch(() => false);
      return;
    }
    if (!cp) return;
    checkpoints.push(cp.sha);
    await n.banco.transacao((r) => r.execucoes.atualizar(execucaoId, { sha_atual: cp.sha }));
    await n.publicar({
      execucao_id: execucaoId,
      etapa_id: n.emCurso.get(execucaoId)?.etapaId ?? null,
      tipo: 'git.checkpoint',
      nivel: 'info',
      resumo: `Checkpoint ${sha8(cp.sha)}: ${cp.mensagem}`,
      dados: { sha: cp.sha, passo: String(passo), mensagem: cp.mensagem, arquivos: cp.arquivos },
    });
  };
  const pararPorViolacao = async (): Promise<boolean> => {
    if (!violacao) return false;
    await aplicarFato(
      n,
      execucaoId,
      { tipo: 'regra_conteudo_persistente', erros: [violacao] },
      'implementando',
    );
    return true;
  };
  const etapas = await etapasDa(n, execucaoId);
  const retomar = etapaParaRetomar(etapas, 'implementar', ciclo);
  if (retomar) {
    // Antes de qualquer retomada: o disco é o ponto de partida (03 §3.3).
    try {
      await commitCheckpoint(dir, MENSAGEM_AO_INTERROMPER, opCp);
    } catch (e) {
      if (e instanceof ErroCheckpointBranch) violacao = e.message;
    }
    if (await pararPorViolacao()) return;
  }
  const sessaoAtual = execucao.session_id_condutor;
  let fim = await rodarTurno(n, ctx, {
    perfil: 'condutor_t1',
    sessionId: retomar?.session_id ?? sessaoAtual ?? n.novoSessionId(),
    modo: retomar || sessaoAtual ? 'resume' : 'novo',
    retomarTurnoInterrompido: retomar !== null,
    retomada: retomar !== null,
    prompt: retomar
      ? montarPromptRetomada(await diffStatTexto(dir, execucao.sha_base as string, 'HEAD'))
      : prompt.stdin,
    promptSessaoNova: retomar
      ? montarPromptSessaoNova(secoes, {
          passosConcluidos: await gitSaida(['log', '--oneline', `${execucao.sha_base}..HEAD`], dir),
          diffAtual: await diffStatTexto(dir, execucao.sha_base as string, 'HEAD'),
          vereditosAnteriores: null,
          comentariosAnteriores: comentarios.map((c) => c.texto),
        })
      : undefined,
    sistema: prompt.sistema,
    agentes,
    ciclo,
    aoCheckpoint,
  });
  let recusas = 0;
  // Bash de todos os processos do turno (inclusive as correções de contrato), FJ-032.
  const bashT1: ComandoDoStream[] = [];
  for (;;) {
    if (await pararPorViolacao()) return;
    if (fim.tipo === 'parado') return;
    if (fim.tipo === 'fato') {
      await aplicarFato(n, execucaoId, fim.evento, 'implementando');
      return;
    }
    bashT1.push(...fim.medido.bash);
    const resumo = fim.saida as ResumoImplV1;
    let final;
    try {
      final = await commitCheckpoint(dir, `forja: fim do turno T1 (#${execucao.numero})`, opCp);
    } catch (e) {
      if (!(e instanceof ErroCheckpointBranch)) throw e;
      violacao = e.message;
      continue;
    }
    if (final) checkpoints.push(final.sha);
    const head = await shaHead(dir);
    const base = await baseDoDiff(n, execucao, head);
    const arquivosReais = await arquivosDoDiff(dir, base, head);
    const diffVazio = arquivosReais.length === 0;
    const val = validarResumoImpl(resumo, {
      ciclo,
      plano,
      arquivos_reais: arquivosReais,
      lockfile_mudou: arquivosReais.some(ehLockfile),
      head_igual_checkpoint: true,
    });
    const recusa = decidirRecusa(val.erros, recusas);
    if (recusa.acao === 'recusar') {
      recusas += 1;
      fim = await rodarTurno(n, ctx, {
        perfil: 'condutor_t1',
        sessionId: fim.sessionId,
        modo: 'resume',
        prompt: montarPromptCorrecao(recusa.erros),
        sistema: prompt.sistema,
        agentes,
        ciclo,
        aoCheckpoint,
      });
      continue;
    }
    if (recusa.acao === 'precisa_humano') {
      await aplicarFato(
        n,
        execucaoId,
        { tipo: 'regra_conteudo_persistente', erros: recusa.erros },
        'implementando',
      );
      return;
    }
    // Custo DELTA do turno (o `result` vem acumulado na sessão, S5).
    const custo = fim.custo;
    const editouSozinho = condutorFezSozinho(
      !diffVazio,
      custo?.model_usage_delta ?? {},
      config.modelos.subagentes.modelo,
    );
    // O que o app MEDIU no stream vale sobre o que o modelo declarou (04 §9).
    const medido = fim.medido;
    const declarouCondutor = resumo.passos.some((p) => p.executor === 'condutor');
    const condutorEditou = editouSozinho || medido.fora_do_papel.length > 0;
    if (medido.fora_do_papel.length > 0 && !declarouCondutor) {
      await n.publicar({
        execucao_id: execucaoId,
        etapa_id: fim.etapa.id,
        tipo: 'cli.alerta',
        nivel: 'aviso',
        resumo: `#${execucao.numero}: o condutor editou ${medido.fora_do_papel.length} vez(es) e declarou só implementadores`,
        dados: { codigo: 'declaracao_falsa', bloqueante: false },
      });
    }
    const registrado = resumoImplRegistrado({
      resumo,
      sha_checkpoints: checkpoints,
      sha_final: head,
      arquivos_reais: arquivosReais,
      diff_stat: await numstat(dir, base, head),
      condutor_editou: condutorEditou,
      modelo_subagentes: config.modelos.subagentes.modelo,
      custo: custo ?? custoVazio(),
      medido,
      comandos_stream: comandosDeVerificacaoDoStream(bashT1),
    });
    const etapaId = fim.etapa.id;
    // Coleta das evidências do agente (FJ-030 §3): no fim de todo T1, inclusive
    // retrabalho. Sem UI prevista e sem `telas.json`, nada a coletar. Um
    // `nao_se_aplica` com arquivo de interface no diff é contestado (FJ-031).
    let evidencia: Pick<Execucao, 'evidencia_visual' | 'evidencia_visual_motivo'> | null = null;
    if (comEvidencias || existsSync(join(dirEvidencias(n, execucaoId), ARQUIVO_TELAS))) {
      const coleta = await coletarERegistrar(
        n,
        { ...ctx, execucao: { ...execucao } },
        head,
        uiDaMudanca(arquivosReais, config, plano),
      );
      evidencia = {
        evidencia_visual: coleta.evidencia_visual,
        evidencia_visual_motivo: coleta.motivo,
      };
    }
    await n.transicionar(
      execucaoId,
      {
        tipo: 'implementacao_concluida',
        result_sem_erro: true,
        contrato_valido: true,
        commit_feito: true,
        diff_vazio: diffVazio,
        bloqueios: val.bloqueios,
      },
      {
        patch: { sha_atual: head, ...(evidencia ?? {}) },
        dentro: async (r) => {
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'resumo_impl',
            contrato: 'resumo_impl.v1',
            conteudo: registrado as unknown as JsonLivre,
          });
          if (condutorEditou) await r.etapas.atualizar(etapaId, { condutor_editou: true });
          await r.comentarios.marcarConsumidos(comentarios.map((c) => c.id));
        },
      },
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// verificando (03 §5; FJ-032) — COLETA: o app não executa comando do projeto
// ---------------------------------------------------------------------------

/** `etapa.comandos` da coleta: o que o T1 rodou, lido do stream (informativo). */
export function comandosEtapaDoStream(cmds: readonly ComandoDoStream[]) {
  return cmds.map((c) => ({
    nome: c.comando,
    exit_code: c.resultado === 'exit_0' ? 0 : c.resultado === 'erro' ? 1 : null,
    duracao_ms: 0,
    log_ref: '',
    instavel: false,
  }));
}

/**
 * Coleta (FJ-032): instantânea, sem processo. O app commita o que o T1 deixou,
 * fixa `sha_verificado = HEAD`, calcula os selos, toma o token de schema
 * imprevisto, confirma as evidências no sha e registra os comandos que o T1
 * rodou (lidos do stream). Sempre segue para a revisão: quem roda os checks é
 * o agente (o implementador no T1, o revisor no T2); o nível ⚙ sai do T2.
 */
export async function verificar(n: Nucleo, execucaoId: string): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const dir = execucao.worktree_dir as string;
  // O app commita antes — nunca os `arquivos_locais`, e nunca com o HEAD fora
  // da branch da execução.
  try {
    await commitCheckpoint(dir, MENSAGEM_AO_INTERROMPER, opcoesCheckpoint(execucao, config));
  } catch (e) {
    if (e instanceof ErroCheckpointBranch) {
      await aplicarFato(
        n,
        execucaoId,
        { tipo: 'sentinela_divergente', caminhos: [`HEAD da worktree: ${e.message}`] },
        'verificando',
      );
      return;
    }
  }
  const sha = await shaHead(dir);
  const base = await baseDoDiff(n, execucao, sha);
  const resumo =
    (await ultimoArtefato<ResumoImplRegistrado>(n, execucaoId, 'resumo_impl'))?.conteudo ?? null;
  const doT1 = resumo?.comandos_stream ?? [];
  const etapa = await n.banco.transacao((r) =>
    r.etapas.criar({
      execucao_id: execucaoId,
      tipo: 'verificar',
      ciclo: execucao.ciclo_total + 1,
      sha_inicio: sha,
    }),
  );

  // Selos, token de schema imprevisto e prints no sha (03 §5.4, §7.3).
  const plano = await planoOficial(n, execucaoId);
  const selos = await selosDoDiff({
    dir,
    base,
    sha,
    detectores: config.detectores,
    areasPlano: plano?.areas ?? [],
  });
  if (selos.selos.altera_banco && !plano?.schema_banco.altera) {
    const chave = chaveDestino(projeto.id, execucao.branch_destino);
    const d = decidirSchemaImprevisto(n.vagas.semaforos, execucaoId, chave);
    if (d.acao === 'tomar') n.vagas.definir(d.semaforos);
    else if (d.acao === 'alertar') {
      await n.publicar({
        execucao_id: execucaoId,
        etapa_id: etapa.id,
        tipo: 'cli.alerta',
        nivel: 'aviso',
        resumo: d.alerta,
        dados: { codigo: 'schema_concorrente', bloqueante: false },
      });
    }
  }
  // Prints: o agente tirou no T1 (B7) e o app coletou no fim do turno (FJ-030
  // §3). Aqui só se confirma a coleta NO sha verificado (barato: nada sobe).
  let evidencia: { evidencia_visual: string; motivo: string | null } = {
    evidencia_visual: 'nao_se_aplica',
    motivo: null,
  };
  if (selos.selos.altera_ui) {
    const jaColetado = (await etapasDa(n, execucaoId)).some(
      (x) => x.tipo === 'evidenciar' && x.sha_inicio === sha,
    );
    if (!jaColetado) {
      const c = await coletarERegistrar(
        n,
        { ...ctx, execucao: { ...execucao, sha_verificado: sha } },
        sha,
        {
          ligado: true,
          arquivos: selos.por_arquivo
            .filter((a) => a.selos.includes('frontend'))
            .map((a) => a.caminho),
        },
      );
      evidencia = { evidencia_visual: c.evidencia_visual, motivo: c.motivo };
    } else {
      evidencia = {
        evidencia_visual:
          execucao.evidencia_visual && execucao.evidencia_visual !== 'nao_se_aplica'
            ? execucao.evidencia_visual
            : 'sem_evidencia_visual',
        motivo: execucao.evidencia_visual_motivo,
      };
    }
  }
  await n.banco.transacao((r) =>
    r.etapas.finalizar(etapa.id, {
      estado: 'concluida',
      motivo_fim: 'concluido',
      sha_fim: sha,
      comandos: comandosEtapaDoStream(doT1),
    }),
  );
  await n.transicionar(
    execucaoId,
    { tipo: 'verificacao_concluida', decisao: { para: 'revisando' } },
    {
      patch: {
        sha_atual: sha,
        sha_verificado: sha,
        // O nível sai do T2 (relatado × stream); até lá, nada verificado neste sha.
        nivel_verificacao: null,
        selos: selos.selos,
        evidencia_visual: evidencia.evidencia_visual as Execucao['evidencia_visual'],
        evidencia_visual_motivo: evidencia.motivo,
      },
    },
  );
}

/**
 * "Recapturar prints" (FJ-026; FJ-030 §3): coleta DE NOVO `evidencias/` no
 * mesmo `sha_verificado` — para depois que o humano (ou o agente, numa
 * conversa) acrescentou ou corrigiu prints. Nada sobe o app aqui.
 */
export async function recapturarPrints(n: Nucleo, execucaoId: string): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const sha = ctx.execucao.sha_verificado;
  if (!sha) throw new ErroForja('pre_condicao_falhou', 'sem sha verificado para coletar');
  const c = await coletarERegistrar(n, ctx, sha, {
    ligado: ctx.execucao.selos?.altera_ui ?? false,
    arquivos: [],
  });
  await n.banco.transacao((r) =>
    r.execucoes.atualizar(execucaoId, {
      evidencia_visual: c.evidencia_visual,
      evidencia_visual_motivo: c.motivo,
    }),
  );
}

// ---------------------------------------------------------------------------
// revisando — T2 (03 §3.2; 04 §6 veredito)
// ---------------------------------------------------------------------------

/** Insumos, prompt e agentes do T2 (revisão normal e reverificação na fila de merge). */
async function preparoT2(
  n: Nucleo,
  ctx: Ctx,
  e: {
    dir: string;
    base: string;
    sha: string;
    ciclo: number;
    reverificacao?: { destino: string; arquivosEmComum: readonly string[] } | null;
    /** FJ-036: conflito resolvido pelo agente desde a aprovação. */
    conflito?: ConflitoPendente | null;
  },
) {
  const { execucao, projeto, config } = ctx;
  const plano = await planoOficial(n, execucao.id);
  const resumo =
    (await ultimoArtefato<ResumoImplRegistrado>(n, execucao.id, 'resumo_impl'))?.conteudo ?? null;
  const refs = await n.banco.ler(async (r) =>
    (await r.artefatos.listar(execucao.id))
      .filter((a) => a.tipo === 'evidencia')
      .map((a) => `artefato:${a.id}`),
  );
  const arquivosReais = await arquivosDoDiff(e.dir, e.base, e.sha);
  const foraDoPlano = arquivosReais.filter((a) => !plano?.arquivos_previstos.includes(a));
  // Gatilho da lente de segurança (04 §4.6), o MESMO no prompt e no validarVeredito.
  const selosDiff = await selosDoDiff({
    dir: e.dir,
    base: e.base,
    sha: e.sha,
    detectores: config.detectores,
    areasPlano: plano?.areas ?? [],
  });
  const segurancaObrigatoria = revisaoSegurancaObrigatoria({
    sensiveis: execucao.selos?.sensivel ?? selosDiff.selos.sensivel,
    dependencias_novas: selosDiff.dependencias_novas,
    plano,
  });
  const regras = await regrasDoRepositorio(projeto.repo_dir, execucao.sha_base);
  const locais = destinosLocais(config);
  const scripts = await scriptsDoProjeto(config, e.dir);
  const secoes = insumosT2({
    plano,
    ciclo: e.ciclo,
    shaBase: e.base,
    shaVerificado: e.sha,
    diffStat: await diffStatTexto(e.dir, e.base, e.sha),
    comandosDoImplementador: textoComandosDoStream(resumo?.comandos_stream ?? []),
    scripts,
    reverificacao: e.reverificacao ?? null,
    conflitoResolvido: e.conflito
      ? {
          destino: e.conflito.destino,
          shaDestino: e.conflito.sha_destino,
          arquivos: e.conflito.arquivos,
          resumoTecnico: e.conflito.resumo_tecnico,
        }
      : null,
    revisaoSegurancaObrigatoria: segurancaObrigatoria,
    sensiveis: execucao.selos?.sensivel ?? [],
    refsEvidencia: refs,
    candidatosForaDoPlano: foraDoPlano,
  });
  const prompt = montarPromptTurno({
    perfil: 'condutor_t2',
    regrasRepositorio: regras,
    arquivosLocais: locais,
    insumos: secoes,
    orcamento: {
      orcamentoUsd:
        orcamentoEfetivo(config, 'revisar', execucao.custo_micro_usd) ??
        config.limites.orcamento_usd.revisar,
      timeoutMin: config.limites.timeout_min.revisar,
    },
  });
  const agentes = gerarAgentesT2({
    modelo: config.modelos.subagentes.modelo,
    esforco: esforco(config.modelos.subagentes.esforco_revisor),
    promptRevisorCorrecao: montarPromptSubagente('revisor_correcao', regras, locais).prompt,
    promptRevisorSeguranca: montarPromptSubagente('revisor_seguranca', regras, locais).prompt,
  });
  return {
    plano,
    refs,
    segurancaObrigatoria,
    prompt,
    agentes,
    scriptsProjeto: scripts.map((c) => c.comando),
  };
}

export async function revisar(n: Nucleo, execucaoId: string): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, config } = ctx;
  const dir = execucao.worktree_dir as string;
  const sha = execucao.sha_verificado as string;
  const base = await baseDoDiff(n, execucao, sha);
  const ciclo = execucao.ciclo_total + 1;
  const conflito = await conflitoPendente(n.banco, execucao, sha);
  const t2 = await preparoT2(n, ctx, { dir, base, sha, ciclo, conflito });
  const { plano, refs, segurancaObrigatoria, prompt } = t2;
  const anteriorArt = await ultimoArtefato<VereditoRegistrado>(n, execucaoId, 'veredito');
  const etapas = await etapasDa(n, execucaoId);
  const retomar = etapaParaRetomar(etapas, 'revisar', ciclo);
  const sessao = execucao.session_id_condutor ?? n.novoSessionId();
  const especBase = {
    perfil: 'condutor_t2' as const,
    sistema: prompt.sistema,
    agentes: t2.agentes,
    ciclo,
    scriptsProjeto: t2.scriptsProjeto,
  };
  let fim = await rodarTurno(n, ctx, {
    ...especBase,
    sessionId: sessao,
    modo: execucao.session_id_condutor ? 'resume' : 'novo',
    retomarTurnoInterrompido: retomar !== null,
    retomada: retomar !== null,
    prompt: retomar ? montarPromptRetomada(`revisão do sha ${sha}`) : prompt.stdin,
    promptSessaoNova: prompt.stdin,
  });
  let recusas = 0;
  let repeticoes = 0;
  // Bash de todos os processos do turno (FJ-032): a base do nível ⚙.
  const bashT2: ComandoDoStream[] = [];
  for (;;) {
    if (fim.tipo === 'parado') return;
    if (fim.tipo === 'fato') {
      await aplicarFato(n, execucaoId, fim.evento, 'revisando');
      return;
    }
    bashT2.push(...fim.medido.bash);
    const veredito = fim.saida as VereditoV1;
    const validacao = validarVeredito(veredito, {
      sha_verificado: sha,
      ids_criterios: plano?.criterios_de_aceite.map((c) => c.id) ?? [],
      refs_validas: refs,
      revisao_seguranca_obrigatoria: segurancaObrigatoria,
    });
    const decisao = decidirAposVeredito({
      veredito,
      validacao,
      veredito_anterior: anteriorArt?.conteudo ?? null,
      head_igual_sha_verificado: (await shaHead(dir)) === sha,
      // Os checks que a revisão roda podem deixar artefato não rastreado (FJ-032).
      worktree_limpa: await arvoreLimpaSemLocais(dir, config, true),
      contadores: { ciclo_auto: execucao.ciclo_auto, ciclo_total: execucao.ciclo_total },
      limites: config.limites.ciclos,
      repeticoes_invalido: repeticoes,
      recusas_feitas: recusas,
    });
    if (decisao.acao === 'repetir_t2') {
      repeticoes += 1;
      fim = await rodarTurno(n, ctx, {
        ...especBase,
        sessionId: fim.sessionId,
        modo: 'resume',
        prompt: montarPromptCorrecao([
          `${decisao.motivo_invalido}: ecoe em sha_avaliado exatamente ${sha}`,
        ]),
      });
      continue;
    }
    if (decisao.acao === 'recusar') {
      recusas += 1;
      fim = await rodarTurno(n, ctx, {
        ...especBase,
        sessionId: fim.sessionId,
        modo: 'resume',
        prompt: montarPromptCorrecao(decisao.erros),
      });
      continue;
    }
    const nivel = calcularNivelVerificacao({
      relatados: veredito.comandos_executados ?? [],
      stream: bashT2,
    });
    const custo = fim.custo;
    const registrado = vereditoRegistrado({
      veredito,
      nivel,
      sha_verificado: sha,
      valido: validacao.valido,
      motivo_invalido: validacao.motivo_invalido,
      repetidos: decisao.repetidos,
      decisao_do_app: decisao.decisao_do_app,
      custo: custo ?? custoVazio(),
    });
    const etapaId = fim.etapa.id;
    await n.transicionar(
      execucaoId,
      { tipo: 'veredito_avaliado', decisao: decisao.decisao },
      {
        patch: { nivel_verificacao: nivel.nivel },
        dentro: async (r) => {
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'veredito',
            contrato: 'veredito.v1',
            conteudo: registrado as unknown as JsonLivre,
          });
        },
      },
    );
    return;
  }
}

/** Ref de evidência de um comando confirmado (FJ-032): `comando:<n>@<sha8>`, n a partir de 1. */
export function refComando(indice: number, sha: string): string {
  return `comando:${indice + 1}@${sha8(sha)}`;
}

/** Algum comando e2e relatado pela revisão e visto no stream com exit 0 (FJ-032)? */
export function e2eConfirmado(veredito: VereditoRegistrado | null): boolean {
  const cmds = veredito?.verificacao?.comandos ?? [];
  return cmds.some(
    (c) =>
      typeof c.comando === 'string' &&
      c.no_stream === 'exit_0' &&
      c.exit_code === 0 &&
      /\b(e2e|playwright|cypress)\b/i.test(c.comando),
  );
}

/** Resultado da reverificação pelo revisor na fila de merge (FJ-032). */
export type ResultadoReverificacao =
  | { tipo: 'aprovado'; nivel: CalculoNivel }
  | { tipo: 'reprovado'; texto: string }
  | { tipo: 'falhou'; texto: string }
  | { tipo: 'parado' };

/**
 * Turno T2 AVULSO sobre o resultado integrado (FJ-032 §5): o destino andou
 * desde a aprovação e mexeu em arquivos do patch. Roda em `integrando`, com cwd
 * na worktree de integração e sessão nova (não vira a sessão do condutor — a
 * sessão da CLI é por diretório). O veredito vira artefato (o T1 de um
 * retrabalho o lê); aprovado sem bloqueante = segue o merge.
 */
export async function reverificarIntegracao(
  n: Nucleo,
  execucaoId: string,
  e: { dir: string; base: string; sha: string; destino: string; arquivosEmComum: string[] },
): Promise<ResultadoReverificacao> {
  const ctx = await n.carregar(execucaoId);
  const { execucao } = ctx;
  const ciclo = execucao.ciclo_total + 1;
  const t2 = await preparoT2(n, ctx, {
    dir: e.dir,
    base: e.base,
    sha: e.sha,
    ciclo,
    reverificacao: { destino: e.destino, arquivosEmComum: e.arquivosEmComum },
  });
  const fim = await rodarTurno(n, ctx, {
    perfil: 'condutor_t2',
    sistema: t2.prompt.sistema,
    agentes: t2.agentes,
    ciclo,
    scriptsProjeto: t2.scriptsProjeto,
    sessionId: n.novoSessionId(),
    modo: 'novo',
    prompt: t2.prompt.stdin,
    avulso: { cwd: e.dir, estado: 'integrando' },
  });
  if (fim.tipo === 'parado') return { tipo: 'parado' };
  if (fim.tipo === 'fato') {
    return {
      tipo: 'falhou',
      texto: `a reverificação pelo revisor não concluiu (${fim.evento.tipo})`,
    };
  }
  const veredito = fim.saida as VereditoV1;
  const validacao = validarVeredito(veredito, {
    sha_verificado: e.sha,
    ids_criterios: t2.plano?.criterios_de_aceite.map((c) => c.id) ?? [],
    refs_validas: t2.refs,
    revisao_seguranca_obrigatoria: t2.segurancaObrigatoria,
  });
  const nivel = calcularNivelVerificacao({
    relatados: veredito.comandos_executados ?? [],
    stream: fim.medido.bash,
  });
  const bloqueantes = veredito.achados.filter((a) => a.severidade === 'bloqueante');
  const aprovado =
    validacao.valido && validacao.decisao_efetiva === 'aprovado' && bloqueantes.length === 0;
  const registrado = vereditoRegistrado({
    veredito,
    nivel,
    sha_verificado: e.sha,
    valido: validacao.valido,
    motivo_invalido: validacao.motivo_invalido,
    repetidos: [],
    decisao_do_app: aprovado ? 'relatando' : 'retrabalho',
    custo: fim.custo ?? custoVazio(),
  });
  await n.banco.transacao((r) =>
    r.artefatos.criar({
      execucao_id: execucaoId,
      etapa_id: fim.etapa.id,
      tipo: 'veredito',
      contrato: 'veredito.v1',
      conteudo: registrado as unknown as JsonLivre,
      sha_git: e.sha,
    }),
  );
  if (aprovado) return { tipo: 'aprovado', nivel };
  return {
    tipo: 'reprovado',
    texto: `o revisor reprovou o resultado integrado: ${
      bloqueantes.map((a) => a.descricao).join('; ') ||
      validacao.motivo_invalido ||
      veredito.motivo_recomendacao
    }`.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// resolvendo_conflito — T1 de conflito (FJ-036; 03 §8.4)
// ---------------------------------------------------------------------------

/** Conflito com o destino que o agente resolveu e ainda não foi aprovado (FJ-036). */
export interface ConflitoPendente {
  destino: string;
  sha_destino: string;
  arquivos: string[];
  /** Ocorrência deste conflito na execução (1, 2…). */
  ocorrencia: number;
  /** Como o agente resolveu (`resumo_tecnico` do turno de conflito), se registrado. */
  resumo_tecnico: string | null;
}

/**
 * Há resolução de conflito pendente de reaprovação no `sha`? O item da fila
 * fica em `conflito` até a próxima aprovação (`enfileirar` o substitui) e o
 * `T0` que o app integrou (`sha_destino_antes`) está no histórico do `sha`.
 * Alimenta o T2 (reverificação da resolução), o T3 ("Mudou desde a sua
 * aprovação") e a faixa de reaprovação da Aprovação.
 */
export async function conflitoPendente(
  banco: Nucleo['banco'],
  execucao: Pick<Execucao, 'id' | 'worktree_dir' | 'branch_destino'>,
  sha: string | null,
): Promise<ConflitoPendente | null> {
  const dir = execucao.worktree_dir;
  if (!dir || !sha) return null;
  const { item, resumo } = await banco.ler(async (r) => ({
    item: await r.filaMerge.ativoDaExecucao(execucao.id),
    resumo: await r.artefatos.ultimaVersao(execucao.id, 'resumo_impl'),
  }));
  if (item?.estado !== 'conflito' || !item.sha_destino_antes) return null;
  if (!(await ehAncestral(dir, item.sha_destino_antes, sha).catch(() => false))) return null;
  const resolucao = (
    (resumo?.conteudo as unknown as ResumoImplRegistrado | undefined)?.resolucoes_conflito ?? []
  ).find((x) => x.sha_destino === item.sha_destino_antes);
  return {
    destino: execucao.branch_destino,
    sha_destino: item.sha_destino_antes,
    arquivos: item.arquivos_em_conflito ?? [],
    ocorrencia: item.tentativas_conflito,
    resumo_tecnico: resolucao?.resumo_tecnico ?? null,
  };
}

/** `forja: resolve conflito com <destino>@<sha7>` (FJ-036). */
export function mensagemResolucaoConflito(destino: string, t0: string): string {
  return `forja: resolve conflito com ${destino}@${t0.slice(0, 7)}`;
}

/**
 * `resolvendo_conflito` (FJ-036; 03 §8.4): o destino andou e a integração
 * conflitou. O app commita o que houver, integra o `T0` atual na worktree do
 * chamado com `merge --no-commit` (os marcadores ficam) e abre um turno T1 de
 * conflito na sessão condutora. No fim confere que não sobrou marcador (1
 * correção), commita o merge e segue para a coleta → T2 (reverificação da
 * resolução) → T3 (nova versão) → reaprovação. Conflito em migration/schema
 * (detector `banco`) → `precisa_humano` com o merge desfeito.
 *
 * Retomada (reinício, interrupção, "tentar de novo" depois de uma parada): com
 * o merge ainda em curso, só o turno é refeito — o `T0` é o `MERGE_HEAD`.
 */
export async function resolverConflito(
  n: Nucleo,
  execucaoId: string,
  baseDestino: () => Promise<string>,
): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const dir = execucao.worktree_dir as string;
  const destino = execucao.branch_destino;
  const opCp = opcoesCheckpoint(execucao, config);
  const fato = (evento: EventoMaquina) => aplicarFato(n, execucaoId, evento, 'resolvendo_conflito');
  const desfecho = (
    resultado: 'resolvido' | 'conflito_merge' | 'conflito_schema' | 'impedimento',
    texto?: string,
  ) => fato({ tipo: 'conflito_resolvido', resultado, texto });
  const itens = await n.banco.ler((r) => r.filaMerge.daExecucao(execucaoId));
  let item = itens.find((i) => i.estado === 'conflito') ?? itens.at(-1) ?? null;
  if (!item) {
    await desfecho('conflito_merge', 'sem item da fila de merge para resolver: aprove de novo');
    return;
  }
  const ehBanco = (c: string) => casaAlgum(c, config.detectores.banco);

  let t0 = await mergeEmCurso(dir);
  let arquivos = item.arquivos_em_conflito ?? [];
  if (!t0) {
    // Ponto de partida limpo (o merge exige) e nunca com o HEAD fora da branch.
    try {
      await commitCheckpoint(dir, MENSAGEM_AO_INTERROMPER, opCp);
    } catch (e) {
      if (!(e instanceof ErroCheckpointBranch)) throw e;
      await fato({ tipo: 'sentinela_divergente', caminhos: [`HEAD da worktree: ${e.message}`] });
      return;
    }
    // `T0` atual (o destino pode ter andado de novo); sem rede, o do conflito.
    let base: string | null;
    try {
      base = await baseDestino();
    } catch (e) {
      n.log(`#${execucao.numero}: base do destino indisponível (${String(e)}); usa a do conflito`);
      base = item.sha_destino_antes;
    }
    if (!base) {
      await fato({
        tipo: 'falha_infra',
        motivo: 'setup_falhou',
        texto: 'base do destino indisponível para resolver o conflito',
      });
      return;
    }
    t0 = base;
    // Intenção antes de agir: `baseDoDiff` passa a contar este T0 (03 §8.1).
    item = await n.banco.transacao((r) =>
      r.filaMerge.atualizar(item!.id, { sha_destino_antes: base }),
    );
    const m = await iniciarMergeDestino(dir, t0, mensagemResolucaoConflito(destino, t0));
    if (m.tipo !== 'conflito') {
      // O conflito sumiu (o destino mudou de novo) ou já estava integrado:
      // segue para a coleta → T2 → T3 → reaprovação do mesmo jeito.
      const head = await shaHead(dir);
      if (m.tipo === 'limpo') {
        await n.publicar({
          execucao_id: execucaoId,
          etapa_id: null,
          tipo: 'git.checkpoint',
          nivel: 'info',
          resumo: `Destino integrado sem conflito: ${sha8(head)}`,
          dados: {
            sha: head,
            passo: null,
            mensagem: mensagemResolucaoConflito(destino, t0),
            arquivos: 0,
          },
        });
      }
      await n.transicionar(
        execucaoId,
        {
          tipo: 'conflito_resolvido',
          resultado: 'resolvido',
          texto: 'o destino integrou sem conflito',
        },
        { patch: { sha_atual: head } },
      );
      return;
    }
    arquivos = m.arquivos;
    item = await n.banco.transacao((r) =>
      r.filaMerge.atualizar(item!.id, { arquivos_em_conflito: m.arquivos }),
    );
  }
  const shaDestino = t0;

  // Migration/schema: dado é irreversível — humano direto, worktree de volta ao HEAD.
  const banco = arquivos.filter(ehBanco);
  if (banco.length > 0) {
    await abortarMerge(dir);
    await desfecho(
      'conflito_schema',
      `conflito em migration/schema (${banco.join(', ')}): resolva à mão — dado é irreversível`,
    );
    return;
  }

  const ciclo = execucao.ciclo_total + 1;
  const plano = await planoOficial(n, execucaoId);
  const regras = await regrasDoRepositorio(projeto.repo_dir, execucao.sha_base);
  const locais = destinosLocais(config);
  const mergeBase = (
    await git(['merge-base', 'HEAD', shaDestino], { cwd: dir, aceitar: [0, 1] })
  ).stdout.trim();
  const prompt = montarPromptTurno({
    perfil: 'condutor_t1',
    regrasRepositorio: regras,
    arquivosLocais: locais,
    evidencias: {
      forjaPrint: n.deps.forjaPrint ?? null,
      dirEvidencias: dirEvidencias(n, execucaoId),
      // O `antes` é do commit base: na resolução só o `depois` pode mudar.
      somenteDepois: true,
      telasDoPlano: (plano?.telas_afetadas ?? []).map((t) => ({ id: t.id, rota: t.rota })),
    },
    insumos: insumosConflito({
      plano,
      ciclo,
      destino,
      shaDestino,
      shaBase: mergeBase || (execucao.sha_base as string),
      arquivos,
      scripts: await scriptsDoProjeto(config, dir),
    }),
    orcamento: {
      orcamentoUsd:
        orcamentoEfetivo(config, 'implementar', execucao.custo_micro_usd) ??
        config.limites.orcamento_usd.implementar,
      timeoutMin: config.limites.timeout_min.implementar,
    },
  });
  const agentes = gerarAgentesT1({
    modelo: config.modelos.subagentes.modelo,
    esforco: esforco(config.modelos.subagentes.esforco_implementador),
    promptImplementador: montarPromptSubagente('implementador', regras, locais).prompt,
  });
  const retomar = etapaParaRetomar(await etapasDa(n, execucaoId), 'resolver_conflito', ciclo);
  const sessaoAtual = execucao.session_id_condutor;
  // Sem `aoCheckpoint`: um commit no meio fecharia o merge com marcadores.
  const especBase = {
    perfil: 'condutor_t1' as const,
    foraDoEstado: { estado: 'resolvendo_conflito' as const, tipo: 'resolver_conflito' as const },
    sistema: prompt.sistema,
    agentes,
    ciclo,
  };
  let fim = await rodarTurno(n, ctx, {
    ...especBase,
    sessionId: retomar?.session_id ?? sessaoAtual ?? n.novoSessionId(),
    modo: retomar || sessaoAtual ? 'resume' : 'novo',
    retomarTurnoInterrompido: retomar !== null,
    retomada: retomar !== null,
    prompt: retomar
      ? montarPromptRetomada(
          `resolução do conflito com ${destino} (${sha8(shaDestino)}) em curso: ${arquivos.join(', ')}`,
        )
      : prompt.stdin,
    promptSessaoNova: prompt.stdin,
  });
  let correcoes = 0;
  const bash: ComandoDoStream[] = [];
  for (;;) {
    if (fim.tipo === 'parado') return;
    if (fim.tipo === 'fato') {
      await fato(fim.evento);
      return;
    }
    bash.push(...fim.medido.bash);
    const resumo = fim.saida as ResumoImplV1;
    const bloqueios = resumo.bloqueios.map((b) => `${b.precisa}: ${b.descricao}`);
    const humanos = bloqueios.filter((b) => semSuposicao(b));
    if (humanos.length > 0) {
      // O merge fica em curso: "Tentar de novo" refaz o turno; Assumir → Devolver commita.
      await desfecho('impedimento', `impedimento declarado na resolução: ${humanos.join('; ')}`);
      return;
    }
    const ref = await refDoHead(dir);
    if (ref !== `refs/heads/${execucao.branch}`) {
      await fato({
        tipo: 'sentinela_divergente',
        caminhos: [`HEAD da worktree saiu da branch durante a resolução (${ref ?? 'destacado'})`],
      });
      return;
    }
    if (!(await mergeEmCurso(dir)) && !(await ehAncestral(dir, shaDestino, 'HEAD'))) {
      await desfecho('conflito_merge', 'o merge do destino foi desfeito durante a resolução');
      return;
    }
    const restantes = await arquivosComMarcadores(dir, arquivos);
    if (restantes.length > 0) {
      if (correcoes < 1) {
        correcoes += 1;
        fim = await rodarTurno(n, ctx, {
          ...especBase,
          sessionId: fim.sessionId,
          modo: 'resume',
          prompt: montarPromptCorrecao([
            `ainda há marcadores de conflito em: ${restantes.join(', ')} — resolva e remova todos (não commite)`,
          ]),
        });
        continue;
      }
      await desfecho(
        'conflito_merge',
        `marcadores de conflito restantes depois da resolução: ${restantes.join(', ')}`,
      );
      return;
    }
    const head = await concluirMergeDestino(
      dir,
      mensagemResolucaoConflito(destino, shaDestino),
      opCp,
    );
    await n.publicar({
      execucao_id: execucaoId,
      etapa_id: fim.etapa.id,
      tipo: 'git.checkpoint',
      nivel: 'info',
      resumo: `Conflito com ${destino} resolvido: ${sha8(head)}`,
      dados: {
        sha: head,
        passo: null,
        mensagem: mensagemResolucaoConflito(destino, shaDestino),
        arquivos: arquivos.length,
      },
    });
    // Nova versão do resumo_impl: o do T1 fica; a resolução é anexada (T2/T3 a leem).
    const anterior = (await ultimoArtefato<ResumoImplRegistrado>(n, execucaoId, 'resumo_impl'))
      ?.conteudo;
    const registrado: ResumoImplRegistrado | null = anterior
      ? {
          ...anterior,
          bloqueios: [...anterior.bloqueios, ...resumo.bloqueios],
          comandos_stream: [
            ...(anterior.comandos_stream ?? []),
            ...comandosDeVerificacaoDoStream(bash),
          ],
          resolucoes_conflito: [
            ...(anterior.resolucoes_conflito ?? []),
            {
              destino,
              sha_destino: shaDestino,
              sha: head,
              arquivos,
              resumo_tecnico: resumo.resumo_tecnico,
            },
          ],
        }
      : null;
    const etapaId = fim.etapa.id;
    await n.transicionar(
      execucaoId,
      { tipo: 'conflito_resolvido', resultado: 'resolvido' },
      {
        patch: { sha_atual: head },
        dentro: async (r) => {
          if (!registrado) return;
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'resumo_impl',
            contrato: 'resumo_impl.v1',
            conteudo: registrado as unknown as JsonLivre,
          });
        },
      },
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// relatando — T3 (04 §6–§8; 03 §2.4 linhas de `relatando`)
// ---------------------------------------------------------------------------

export async function relatar(n: Nucleo, execucaoId: string): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const dir = execucao.worktree_dir as string;
  const sha = execucao.sha_verificado as string;
  const base = await baseDoDiff(n, execucao, sha);
  const ciclo = execucao.ciclo_total + 1;
  const plano = await planoOficial(n, execucaoId);
  const veredito =
    (await ultimoArtefato<VereditoRegistrado>(n, execucaoId, 'veredito'))?.conteudo ?? null;
  const resumoImpl =
    (await ultimoArtefato<ResumoImplRegistrado>(n, execucaoId, 'resumo_impl'))?.conteudo ?? null;
  // Bloqueios que o implementador declarou mas que não param (FJ-033 no T1):
  // viram suposições no relatório, para o humano conferir na aprovação.
  const suposicoesImpl = (resumoImpl?.bloqueios ?? [])
    .filter((b) => !semSuposicao(`${b.precisa}: ${b.descricao}`))
    .map((b) => `Decidido na implementação (${b.precisa}): ${b.descricao}`);
  const versao = ((await ultimoArtefato(n, execucaoId, 'relatorio'))?.artefato.versao ?? 0) + 1;
  const tipoResposta = tipoRespostaExigido({
    momento: 'conclusao',
    merge_publica: config.entrega.merge_publica,
    ao_concluir: config.politica_status.ao_concluir,
  });
  const selosDiff = await selosDoDiff({
    dir,
    base,
    sha,
    detectores: config.detectores,
    areasPlano: plano?.areas ?? [],
  });
  const resumo =
    (await ultimoArtefato<ResumoImplRegistrado>(n, execucaoId, 'resumo_impl'))?.conteudo ?? null;
  const telas = await telasComColeta(n, execucaoId, plano, resumo);
  const antes = await capturasAntes(n, execucaoId);
  const depois = await capturasDoMomento(n, execucaoId, 'depois', sha);
  const fotografadas = telas
    .filter((t) => {
      const a = antes.find((c) => c.tela_id === t.id)?.resultado;
      const d = depois.find((c) => c.tela_id === t.id)?.resultado;
      return (
        a &&
        ['ok', 'reaproveitado', 'tela_nova'].includes(a) &&
        d &&
        ['ok', 'reaproveitado'].includes(d)
      );
    })
    .map((t) => t.id);
  // Refs (04 §6; FJ-032): cada comando que o revisor relatou E o stream
  // confirmou com exit 0 (`comando:<n>@<sha8>`) e os prints coletados.
  const verif = veredito?.verificacao;
  const refsComandos = (verif?.comandos ?? []).flatMap((c, i) =>
    c.no_stream === 'exit_0' && c.exit_code === 0 ? [refComando(i, sha)] : [],
  );
  const refs = [
    ...refsComandos,
    ...[...antes, ...depois]
      .map((c) => c.artefato_id)
      .filter((x): x is string => !!x)
      .map((id) => `artefato:${id}`),
  ];
  const evidenciaVisual = execucao.evidencia_visual ?? 'nao_se_aplica';
  const etapasExec = await etapasDa(n, execucaoId);
  const conflito = await conflitoPendente(n.banco, execucao, sha);
  const condutorEditouMedido = etapasExec.some((e) => e.condutor_editou);
  const momento = (lista: readonly CapturaRegistrada[], id: string) =>
    lista.find((c) => c.tela_id === id)?.resultado ?? 'sem captura';
  // Como foi verificado (FJ-032): o que a revisão relatou × o que o stream mostrou.
  const fatos = [
    verif && verif.motivo !== undefined
      ? `Como foi verificado (os comandos foram rodados pelos agentes, não pela Forja):\n${textoComoFoiVerificado(
          {
            nivel: verif.nivel as CalculoNivel['nivel'],
            motivo: verif.motivo,
            comandos: verif.comandos,
          },
          sha,
        )}`
      : `Nível de verificação: ${execucao.nivel_verificacao ?? 'nao_verificado'}`,
    `SHA: ${sha}`,
    `Ciclos: ${execucao.ciclo_total} (automáticos: ${execucao.ciclo_auto})`,
    `Condutor editou diretamente (medido pelo app): ${condutorEditouMedido ? 'sim' : 'não'}`,
    `Arquivos alterados: ${selosDiff.arquivos.join(', ') || '(nenhum)'}`,
    `Selos: banco=${selosDiff.selos.altera_banco} regra_negocio=${selosDiff.selos.altera_regra_negocio} ui=${selosDiff.selos.altera_ui} sensiveis=[${selosDiff.selos.sensivel.join(', ')}]`,
    `Dependências novas: ${selosDiff.dependencias_novas.join(', ') || '(nenhuma)'}`,
    `Telas (tela_id → rota | estado esperado | antes → depois): ${
      telas
        .map(
          (t) =>
            `${t.id} → ${t.rota} | ${t.estado_esperado} | ${momento(antes, t.id)} → ${momento(depois, t.id)}`,
        )
        .join('; ') || '(nenhuma)'
    }`,
    `Telas com par antes/depois: ${fotografadas.join(', ') || '(nenhuma)'}`,
    `evidencia_visual: ${evidenciaVisual}${execucao.evidencia_visual_motivo ? ` — declare: "${declaracaoSemPrints(execucao.evidencia_visual_motivo)}"` : ''}`,
    `Refs válidas: ${refs.join(', ') || '(nenhuma)'}`,
    `Achados em aberto: ${achadosEmAberto(veredito).join(' | ') || '(nenhum)'}`,
    ...(conflito
      ? [
          `Mudou desde a sua aprovação (FJ-036): o destino ${conflito.destino} avançou; a Forja integrou ${sha8(conflito.sha_destino)} nesta branch e o agente resolveu o conflito em: ${conflito.arquivos.join(', ') || '(arquivos não registrados)'}.${conflito.resumo_tecnico ? ` Como resolveu: ${conflito.resumo_tecnico}` : ''} Comece \`mudou_desde_a_ultima_versao\` por isso, em linguagem simples.`,
        ]
      : []),
  ].join('\n');
  const regras = await regrasDoRepositorio(projeto.repo_dir, execucao.sha_base);
  const prompt = montarPromptTurno({
    perfil: 'condutor_t3',
    regrasRepositorio: regras,
    arquivosLocais: destinosLocais(config),
    insumos: insumosT3({
      plano,
      vereditos: veredito ? [veredito] : [],
      fatosDoApp: fatos,
      tipoResposta,
      versaoRelatorio: versao,
      suposicoes: (plano?.suposicoes as string[] | undefined) ?? [],
    }),
    orcamento: {
      orcamentoUsd:
        orcamentoEfetivo(config, 'relatar', execucao.custo_micro_usd) ??
        config.limites.orcamento_usd.relatar,
      timeoutMin: config.limites.timeout_min.relatar,
    },
  });
  const etapas = etapasExec;
  const retomar = etapaParaRetomar(etapas, 'relatar', ciclo);
  const especBase = { perfil: 'condutor_t3' as const, sistema: prompt.sistema, ciclo };
  const sessao = execucao.session_id_condutor ?? n.novoSessionId();
  let fim = await rodarTurno(n, ctx, {
    ...especBase,
    sessionId: sessao,
    modo: execucao.session_id_condutor ? 'resume' : 'novo',
    retomarTurnoInterrompido: retomar !== null,
    retomada: retomar !== null,
    prompt: retomar ? montarPromptRetomada('relatório') : prompt.stdin,
    promptSessaoNova: prompt.stdin,
  });
  let recusas = 0;
  let regeneracoes = 0;
  for (;;) {
    if (fim.tipo === 'parado') return;
    if (fim.tipo === 'fato') {
      await aplicarFato(n, execucaoId, fim.evento, 'relatando');
      return;
    }
    const relatorio = fim.saida as RelatorioV1;
    const validacao = validarRespostaPublica(
      relatorio.resposta_ao_cliente.corpo_markdown,
      tipoResposta,
    );
    const avaliacao = avaliarRelatorio(relatorio, {
      selos: { ...selosDiff.selos, dependencias_novas: selosDiff.dependencias_novas },
      plano_altera_schema: plano?.schema_banco.altera ?? false,
      ids_criterios: plano?.criterios_de_aceite.map((c) => c.id) ?? [],
      nivel_verificacao: execucao.nivel_verificacao ?? 'nao_verificado',
      e2e_confirmado: e2eConfirmado(veredito),
      evidencia_visual: evidenciaVisual,
      telas_fatos: telas.map((t) => t.id),
      telas_fotografadas: fotografadas,
      refs_validas: refs,
      versao,
      tipo_resposta: tipoResposta,
      validacao_resposta: validacao,
    });
    const decisao = decidirRelatorio(avaliacao, {
      recusas_feitas: recusas,
      regeneracoes_feitas: regeneracoes,
    });
    if (decisao.acao === 'recusar' || decisao.acao === 'regerar') {
      if (decisao.acao === 'recusar') recusas += 1;
      else regeneracoes += 1;
      fim = await rodarTurno(n, ctx, {
        ...especBase,
        sessionId: fim.sessionId,
        modo: 'resume',
        prompt: montarPromptCorrecao(
          decisao.acao === 'recusar' ? decisao.erros : decisao.apontamentos,
        ),
      });
      continue;
    }
    const etapaId = fim.etapa.id;
    if (decisao.decisao.para !== 'aguardando_aprovacao') {
      await n.transicionar(execucaoId, { tipo: 'relatorio_avaliado', decisao: decisao.decisao });
      return;
    }
    const patchId = (await calcularPatchId(dir, base, sha)) ?? '';
    const patch = await gitSaida(['diff', '--no-color', `${base}..${sha}`], dir);
    const dirDiffs = join(n.dirExecucao(execucaoId), 'artefatos');
    await mkdir(dirDiffs, { recursive: true, mode: 0o700 });
    const caminhoRel = join('artefatos', `diff-${versao}.patch`);
    await writeFile(join(n.dirExecucao(execucaoId), caminhoRel), patch, { mode: 0o600 });
    const assinatura = await sha256Arquivo(join(n.dirExecucao(execucaoId), caminhoRel));
    const stat = await numstat(dir, base, sha);
    const telasReg = telas.map((t) => ({
      tela_id: t.id,
      rota: t.rota,
      antes_ref: antes.find((c) => c.tela_id === t.id)?.artefato_id
        ? `artefato:${antes.find((c) => c.tela_id === t.id)?.artefato_id}`
        : null,
      depois_ref: depois.find((c) => c.tela_id === t.id)?.artefato_id
        ? `artefato:${depois.find((c) => c.tela_id === t.id)?.artefato_id}`
        : null,
    }));
    const registrado = relatorioRegistrado({
      relatorio,
      telas: telasReg,
      selos: selosDiff.selos,
      nivel: execucao.nivel_verificacao ?? 'nao_verificado',
      ciclos: execucao.ciclo_total,
      custo_micro_usd: execucao.custo_micro_usd,
      diff_stat: stat,
      sha,
      patch_id: patchId,
      achados_em_aberto: achadosEmAberto(veredito),
      condutor_editou: etapas.some((e) => e.condutor_editou),
      incoerencias: decisao.incoerencias,
      regenerado: regeneracoes > 0,
      evidencia_visual: evidenciaVisual,
      evidencia_visual_motivo: execucao.evidencia_visual_motivo,
      suposicoes_plano: [...((plano?.suposicoes as string[] | undefined) ?? []), ...suposicoesImpl],
    });
    const resposta = respostaRegistrada({
      resposta: relatorio.resposta_ao_cliente,
      validacao,
      corpo_hash: hashCorpo(relatorio.resposta_ao_cliente.corpo_markdown),
      editada: false,
      publicar_mesmo_assim: null,
    });
    await n.transicionar(
      execucaoId,
      { tipo: 'relatorio_avaliado', decisao: decisao.decisao },
      {
        dentro: async (r) => {
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'diff',
            caminho: caminhoRel,
            sha256: assinatura.sha256,
            tamanho_bytes: assinatura.tamanho,
            sha_git: sha,
            patch_id: patchId,
            conteudo: { base, sha, por_arquivo: selosDiff.por_arquivo } as unknown as JsonLivre,
          });
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'relatorio',
            contrato: 'relatorio.v1',
            conteudo: registrado as unknown as JsonLivre,
            sha_git: sha,
          });
          await r.artefatos.criar({
            execucao_id: execucaoId,
            etapa_id: etapaId,
            tipo: 'resposta',
            contrato: 'resposta.v1',
            conteudo: resposta as unknown as JsonLivre,
          });
        },
      },
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// Conversa com a etapa pausada (03 §10)
// ---------------------------------------------------------------------------

const PERFIL_DO_ESTADO: Partial<Record<string, NomePerfil>> = {
  planejando: 'planejador',
  implementando: 'condutor_t1',
  resolvendo_conflito: 'condutor_t1',
  verificando: 'condutor_t1',
  revisando: 'condutor_t2',
  relatando: 'condutor_t3',
};

/** Teto e timeout da conversa (03 §10): os MESMOS no B6 e no processo. */
export const ORCAMENTO_CONVERSA_USD = 2;
export const TIMEOUT_CONVERSA_MIN = 10;

/** Uma mensagem do humano = 1 `claude -p --resume` com o perfil da etapa pausada, sem schema. */
export async function conversar(n: Nucleo, execucaoId: string, texto: string): Promise<void> {
  const ctx = await n.carregar(execucaoId);
  const { execucao, projeto, config } = ctx;
  const perfil = PERFIL_DO_ESTADO[execucao.estado_anterior ?? ''] ?? 'condutor_t1';
  const sessionId =
    perfil === 'planejador' ? execucao.session_id_planejador : execucao.session_id_condutor;
  if (!sessionId) throw new ErroForja('pre_condicao_falhou', 'não há sessão para conversar');
  const regras = await regrasDoRepositorio(projeto.repo_dir, execucao.sha_base);
  const locais = destinosLocais(config);
  const chave = ORCAMENTO_PERFIL[perfil];
  const orcamentoUsd =
    orcamentoEfetivo(config, chave, execucao.custo_micro_usd, ORCAMENTO_CONVERSA_USD) ??
    ORCAMENTO_CONVERSA_USD;
  const prompt = montarPromptConversa({
    perfil,
    regrasRepositorio: regras,
    arquivosLocais: locais,
    orcamento: { orcamentoUsd, timeoutMin: TIMEOUT_CONVERSA_MIN },
    dirEntrada: join(n.dirExecucao(execucaoId), 'entrada'),
    mensagemOperador: texto,
  });
  // Os subagentes da conversa recebem B1–B3 como os do turno pausado (04 §4.1).
  await rodarTurno(n, ctx, {
    perfil,
    sessionId,
    modo: 'resume',
    conversar: true,
    prompt: prompt.stdin,
    sistema: prompt.sistema,
    orcamentoUsd: ORCAMENTO_CONVERSA_USD,
    timeoutMin: TIMEOUT_CONVERSA_MIN,
    agentes:
      perfil === 'condutor_t1'
        ? gerarAgentesT1({
            modelo: config.modelos.subagentes.modelo,
            esforco: esforco(config.modelos.subagentes.esforco_implementador),
            promptImplementador: montarPromptSubagente('implementador', regras, locais).prompt,
          })
        : perfil === 'condutor_t2'
          ? gerarAgentesT2({
              modelo: config.modelos.subagentes.modelo,
              esforco: esforco(config.modelos.subagentes.esforco_revisor),
              promptRevisorCorrecao: montarPromptSubagente('revisor_correcao', regras, locais)
                .prompt,
              promptRevisorSeguranca: montarPromptSubagente('revisor_seguranca', regras, locais)
                .prompt,
            })
          : null,
    ciclo: execucao.ciclo_total + 1,
  });
}

/** Contrato zod do turno, revalidado no app (01 §6.5) — reexport para a fachada. */
export { validarContrato };
