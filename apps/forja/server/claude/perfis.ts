import type { NomeContrato } from '../../comum/contratos';
import type { PapelAgente, TipoEtapa, TurnoCondutor } from '../../comum/estados';

/**
 * Perfis de spawn da CLI do Claude — ÚNICA fonte das flags por etapa
 * (specs/forja/01 §6.1 e §6.2; 05 §4.5–§4.7).
 *
 * POR QUE um único módulo monta a linha de comando inteira: a segurança da
 * Forja sem sandbox (U-3) depende de cada spawn levar exatamente o conjunto de
 * flags do seu papel — bypass só no T1, `dontAsk` nos demais, só o MCP do Chamados
 * em modo somente leitura (FJ-030 §4) e nada mais (`--strict-mcp-config`), settings
 * gerados, modelo e esforço explícitos (o resume não restaura `--settings` nem o
 * modo de permissão, 01 §6.1). Se outro módulo acrescentasse uma flag "só desta
 * vez", a validação do `init` (01 §6.4) e o smoke de perfis (01 §7) deixariam
 * de provar o que roda. Por isso: quem precisa de um spawn pede um perfil aqui,
 * recebe `ComandoClaude` (argv + env + expectativa do `init`) e não mexe nele.
 *
 * O ambiente é uma ALLOWLIST construída do zero (01 §6.1, 05 §4.7): nunca
 * `{...process.env}` menos algo. Variáveis herdadas de uma sessão do Claude Code
 * (`CLAUDECODE`, `CLAUDE_CODE_*`) quebram a persistência da sessão aninhada, e
 * tokens (GitHub, Chamados, API key) e `SSH_AUTH_SOCK` dariam braço ao agente.
 */

/** Perfis de etapa da CLI (01 §6.2). `conversar`/`retomar` são modificadores, não perfis. */
export const NomePerfil = {
  planejador: 'planejador',
  condutor_t1: 'condutor_t1',
  condutor_t2: 'condutor_t2',
  condutor_t3: 'condutor_t3',
} as const;
export type NomePerfil = (typeof NomePerfil)[keyof typeof NomePerfil];

export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Modos de permissão que o `init` deve reportar por perfil (01 §6.4). */
export type ModoPermissao = 'bypassPermissions' | 'dontAsk';

export const EXECUTAVEL_CLAUDE = 'claude';

/** Modelos padrão (01 §6.2; configuráveis por projeto em `projeto.modelos`, 02 §6). */
export const MODELO_FABLE_PADRAO = 'claude-fable-5-1';
export const MODELO_OPUS_PADRAO = 'claude-opus-5-5';
export const ESFORCO_PADRAO: Esforco = 'high';

/** Tetos padrão de `--max-budget-usd` (01 §6.2); 40 por chamado. */
export const TETOS_ORCAMENTO_USD = {
  planejar: 5,
  implementar: 25,
  revisar: 10,
  relatar: 2,
  por_chamado: 40,
} as const;

/** Timeouts padrão por etapa, em minutos (01 §3.2). Inatividade gera só aviso. */
export const TIMEOUTS_MIN = {
  planejar: 15,
  implementar: 90,
  revisar: 45,
  relatar: 5,
  aviso_inatividade: 15,
} as const;

/**
 * Agentes embutidos da CLI 2.1.288 vistos em `system/init.agents` (pesquisa,
 * fixtures `a.jsonl`/`c.jsonl`). É a semente da lista negada do T1 antes de o
 * cache por projeto × versão existir (01 §6.2): sem ela, o primeiro T1 de todo
 * projeto morreria no `init` e precisaria do reinício único.
 */
export const AGENTES_EMBUTIDOS_CONHECIDOS: readonly string[] = [
  'claude',
  'Explore',
  'general-purpose',
  'Plan',
  'statusline-setup',
];

/** Subagentes de cada turno (04 §2, §3). */
export const AGENTES_DO_PAPEL: Record<NomePerfil, readonly PapelAgente[]> = {
  planejador: [],
  condutor_t1: ['implementador'],
  condutor_t2: ['revisor_correcao', 'revisor_seguranca'],
  condutor_t3: [],
};

/** Ferramentas EXATAS de cada perfil (`--tools`; conferidas no `init`, 01 §6.4). */
export const FERRAMENTAS_DO_PERFIL: Record<NomePerfil, readonly string[]> = {
  planejador: ['Read', 'Grep', 'Glob'],
  condutor_t1: ['Agent', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  condutor_t2: ['Agent', 'Read', 'Grep', 'Glob', 'Bash'],
  condutor_t3: ['Read', 'Grep', 'Glob'],
};

export const MODO_PERMISSAO_DO_PERFIL: Record<NomePerfil, ModoPermissao> = {
  planejador: 'dontAsk',
  condutor_t1: 'bypassPermissions',
  condutor_t2: 'dontAsk',
  condutor_t3: 'dontAsk',
};

/** Contrato (`--json-schema`) de cada perfil (01 §6.2; o T3 devolve `relatorio.v1` com `resposta.v1` dentro). */
export const CONTRATO_DO_PERFIL: Record<NomePerfil, NomeContrato> = {
  planejador: 'plano.v1',
  condutor_t1: 'resumo_impl.v1',
  condutor_t2: 'veredito.v1',
  condutor_t3: 'relatorio.v1',
};

export const TIPO_ETAPA_DO_PERFIL: Record<NomePerfil, TipoEtapa> = {
  planejador: 'planejar',
  condutor_t1: 'implementar',
  condutor_t2: 'revisar',
  condutor_t3: 'relatar',
};

/** Papel da thread principal (para a autoria das falas no feed). */
export const PAPEL_PRINCIPAL_DO_PERFIL: Record<NomePerfil, PapelAgente> = {
  planejador: 'planejador',
  condutor_t1: 'condutor',
  condutor_t2: 'condutor',
  condutor_t3: 'relator',
};

export const TURNO_DO_PERFIL: Record<NomePerfil, TurnoCondutor | null> = {
  planejador: null,
  condutor_t1: 'T1',
  condutor_t2: 'T2',
  condutor_t3: 'T3',
};

/**
 * Ferramentas do MCP do Chamados em `CHAMADOS_MCP_SOMENTE_LEITURA=true`
 * (FJ-030 §4; specs/11): leitura de chamados, anexos (o modelo vê imagens) e
 * sistemas-alvo. Escrever no Chamados continua SÓ pelo app (outbox).
 */
export const SERVIDOR_MCP_CHAMADOS = 'chamados';
export const FERRAMENTAS_MCP_CHAMADOS: readonly string[] = [
  'chamados_listar',
  'chamado_obter',
  'anexo_obter',
  'sistemas_alvo_listar',
].map((f) => `mcp__${SERVIDOR_MCP_CHAMADOS}__${f}`);

/** Variáveis `FORJA_*` que o T1 recebe de propósito (B7, FJ-030 §3); o resto de `FORJA_*` é proibido. */
export const ENV_FORJA_PERMITIDAS: ReadonlySet<string> = new Set([
  'FORJA_PRINT',
  'FORJA_EVIDENCIAS_DIR',
]);

/**
 * Executores de script que o T2 pode rodar (FJ-032): a revisão roda os checks
 * do projeto ela mesma (a Forja não executa comandos). Cobre os gerenciadores
 * comuns; os scripts detectados do projeto entram à parte (`allowDosScripts`).
 */
export const ALLOW_CHECKS_T2: readonly string[] = [
  'Bash(npm run *)',
  'Bash(npm test*)',
  'Bash(npm ci*)',
  'Bash(npm install*)',
  'Bash(npx tsc*)',
  'Bash(npx vitest*)',
  'Bash(npx jest*)',
  'Bash(npx eslint*)',
  'Bash(npx prettier*)',
  'Bash(npx playwright*)',
  'Bash(pnpm run *)',
  'Bash(pnpm test*)',
  'Bash(pnpm install*)',
  'Bash(pnpm lint*)',
  'Bash(pnpm build*)',
  'Bash(pnpm typecheck*)',
  'Bash(yarn run *)',
  'Bash(yarn test*)',
  'Bash(yarn install*)',
  'Bash(yarn lint*)',
  'Bash(yarn build*)',
  'Bash(yarn typecheck*)',
  'Bash(bun run *)',
  'Bash(bun test*)',
  'Bash(bun install*)',
  'Bash(make *)',
];

/** Allow do T2 em `dontAsk` (01 §6.2): efetivo, ao contrário do allow em bypass. */
const ALLOW_T2: readonly string[] = [
  'Agent(revisor_correcao)',
  'Agent(revisor_seguranca)',
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  ...ALLOW_CHECKS_T2,
];

/**
 * Allow para os scripts do projeto que a autodetecção/o Avançado achou (dicas,
 * FJ-032): `Bash(<cmd>)` e `Bash(<cmd> *)`. Comando com caractere que quebraria
 * a regra (parênteses, quebra de linha) fica de fora.
 */
export function allowDosScripts(comandos: readonly string[]): string[] {
  const out = new Set<string>();
  for (const c of comandos) {
    const cmd = c.trim().replace(/\s+/g, ' ');
    if (!cmd || /[()\n]/.test(cmd)) continue;
    out.add(`Bash(${cmd})`);
    out.add(`Bash(${cmd} *)`);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Ambiente (01 §6.1, 05 §4.7)
// ---------------------------------------------------------------------------

/** Variáveis copiadas do ambiente do app (nome exato). `LC_*` é tratado à parte. */
const ENV_HERDADAS: readonly string[] = ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'];

/**
 * Fixas em todo spawn (01 §6.1). SEM `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` [V S2]:
 * com ela a CLI 2.1.288 força `permissionMode: default`, anulando o bypass do T1
 * e o `dontAsk` dos demais perfis (todo `validarInit` falharia). O env do filho
 * já é allowlist (05 §4.7), então o scrub não acrescenta proteção.
 */
const ENV_BASE_FIXA: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
};

/**
 * Nunca chegam a um filho `claude`, venham de onde vierem (inclusive de
 * `envProjeto`). `ANTHROPIC_API_KEY` só entra pela opção explícita do usuário.
 */
export function variavelProibida(nome: string): boolean {
  return (
    nome === 'CLAUDECODE' ||
    nome.startsWith('CLAUDE_') ||
    nome.startsWith('ANTHROPIC_') ||
    nome.startsWith('CHAMADOS_') ||
    nome.startsWith('FORJA_') ||
    nome === 'GH_TOKEN' ||
    nome === 'GITHUB_TOKEN' ||
    nome === 'GIT_ASKPASS' ||
    nome === 'SSH_ASKPASS' ||
    nome === 'SSH_AUTH_SOCK' ||
    nome === 'GPG_AGENT_INFO'
  );
}

export type Env = Readonly<Record<string, string | undefined>>;

export interface OpcoesEnv {
  /** Ambiente de origem (normalmente `process.env` do app). Só a allowlist é lida dele. */
  envOrigem: Env;
  /** Variáveis do projeto declaradas na configuração (05 §4.7). Proibidas são descartadas. */
  envProjeto?: Readonly<Record<string, string>>;
  /** Opção explícita do usuário de usar API key em vez da assinatura (05 §10). */
  apiKey?: string | null;
}

/** Allowlist base: o que todo `claude` (inclusive PTY) recebe. */
export function montarEnvBase(opcoes: OpcoesEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(opcoes.envOrigem)) {
    if (valor === undefined) continue;
    if (ENV_HERDADAS.includes(nome) || nome.startsWith('LC_')) env[nome] = valor;
  }
  for (const [nome, valor] of Object.entries(opcoes.envProjeto ?? {})) {
    if (!variavelProibida(nome) && !(nome in ENV_BASE_FIXA)) env[nome] = valor;
  }
  Object.assign(env, ENV_BASE_FIXA);
  if (opcoes.apiKey) env.ANTHROPIC_API_KEY = opcoes.apiKey;
  return env;
}

/** Env extra dos perfis com subagentes (01 §6.2): todo subagente é Opus, em foreground. */
function envSubagentes(modeloSubagentes: string): Record<string, string> {
  return {
    CLAUDE_CODE_SUBAGENT_MODEL: modeloSubagentes,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
}

/** Variáveis `CLAUDE_*` que a Forja põe de propósito; qualquer outra `CLAUDE*` no env é defeito. */
export const ENV_CLAUDE_PERMITIDAS: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
]);

// ---------------------------------------------------------------------------
// Linha de comando
// ---------------------------------------------------------------------------

/** Arquivos gerados da etapa (01 §6.3; `settings-gerados.ts`, `prompts.ts`). */
export interface ArquivosEtapa {
  /** `settings.<n>.json`: `permissions.deny` + `disableAllHooks`. */
  settings: string;
  /** `sistema.<n>.md`: blocos B1/B2/B3/B6 (`--append-system-prompt-file`). */
  sistema: string;
  /** `agentes.<n>.json` (`--agents`): obrigatório no T1 e no T2. */
  agentes?: string | null;
  /** `mcp.<n>.json` (`--mcp-config`): o MCP do Chamados somente leitura (FJ-030 §4). */
  mcp?: string | null;
}

export interface EntradaPerfil {
  perfil: NomePerfil;
  /** `novo` = `--session-id` (gerado e gravado antes do spawn); `resume` = `--resume`. */
  sessao: { modo: 'novo' | 'resume'; sessionId: string };
  /** Conversa do humano com a etapa pausada (03 §10): mesmo perfil, sem `--json-schema`. */
  conversar?: boolean;
  /** Retomada de turno interrompido (01 §6.7): `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`. */
  retomarTurnoInterrompido?: boolean;
  modelo: string;
  esforco: Esforco;
  /** Modelo forçado nos subagentes (T1/T2). Padrão: Opus. */
  modeloSubagentes?: string;
  numeroChamado: number;
  /** `--max-budget-usd` já calculado com `orcamentoEtapa`. */
  orcamentoUsd: number;
  /** Freio opcional (`--max-turns`), desligado por padrão (01 §6.1). */
  maxTurns?: number | null;
  arquivos: ArquivosEtapa;
  /** JSON Schema do contrato do turno (`paraJsonSchema`). Ignorado em `conversar`. */
  jsonSchema: Record<string, unknown> | null;
  /** Planejador: `<exec>/entrada/` (dado bruto, só leitura pelo perfil). */
  dirEntrada?: string | null;
  /** T1: agentes de `init.agents` fora do papel (cache por projeto × versão, 01 §6.2). */
  agentesNegados?: readonly string[];
  /** Worktree da execução. */
  cwd: string;
  env: OpcoesEnv;
  /** T1: utilitário de prints e diretório de evidências (B7, FJ-030 §3). */
  evidencias?: { forjaPrint: string | null; dir: string } | null;
  /** T2: scripts do projeto (dicas) que entram no allow (FJ-032). */
  scriptsProjeto?: readonly string[];
}

/** O que o `init` precisa mostrar para o spawn seguir (01 §6.4). */
export interface ExpectativaInit {
  perfil: NomePerfil;
  permissionMode: ModoPermissao;
  /** Ferramentas do perfil, sem `StructuredOutput` (que a CLI acrescenta com `--json-schema`). */
  ferramentas: readonly string[];
  comSchema: boolean;
  modelo: string;
  /** Agentes aceitos em `init.agents` (null = não conferir: perfil sem `Agent` ou allow efetivo). */
  agentesAceitos: readonly string[] | null;
  /** `none` na assinatura; com API key escolhida pelo usuário, qualquer fonte ≠ `none`. */
  apiKeySource: 'none' | 'api_key';
  /** Modelos aceitos em `modelUsage` (04 §9). */
  modelosPermitidos: readonly string[];
  /** O spawn levou `--mcp-config` com o servidor `chamados` (FJ-030 §4). */
  mcpChamados: boolean;
}

export interface ComandoClaude {
  executavel: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sessionId: string;
  contrato: NomeContrato | null;
  esperado: ExpectativaInit;
}

export class ErroPerfil extends Error {}

/** `--max-budget-usd = min(teto da etapa, saldo do chamado)` (01 §6.1). Zero ou menos não spawna. */
export function orcamentoEtapa(tetoEtapaUsd: number, saldoChamadoUsd: number): number {
  const valor = Math.min(tetoEtapaUsd, saldoChamadoUsd);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new ErroPerfil(`orçamento esgotado (teto ${tetoEtapaUsd}, saldo ${saldoChamadoUsd})`);
  }
  return Math.floor(valor * 100) / 100;
}

function formatarUsd(valor: number): string {
  return valor.toFixed(2);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Monta o spawn completo de uma etapa: base comum (01 §6.1) + flags do perfil
 * (01 §6.2) + env allowlist + expectativa do `init`.
 */
export function montarComando(entrada: EntradaPerfil): ComandoClaude {
  const { perfil, sessao } = entrada;
  if (!UUID.test(sessao.sessionId))
    throw new ErroPerfil(`session_id inválido: ${sessao.sessionId}`);
  const conversar = entrada.conversar === true;
  const contrato = conversar ? null : CONTRATO_DO_PERFIL[perfil];
  if (contrato && !entrada.jsonSchema) {
    throw new ErroPerfil(`perfil ${perfil} exige --json-schema (${contrato})`);
  }
  const comSubagentes = perfil === 'condutor_t1' || perfil === 'condutor_t2';
  if (comSubagentes && !entrada.arquivos.agentes) {
    throw new ErroPerfil(`perfil ${perfil} exige o arquivo --agents`);
  }
  if (perfil === 'planejador' && !entrada.dirEntrada) {
    throw new ErroPerfil('planejador exige o diretório de entrada (--add-dir)');
  }
  const modeloSubagentes = entrada.modeloSubagentes ?? MODELO_OPUS_PADRAO;
  const tipoEtapa = conversar ? 'conversar' : TIPO_ETAPA_DO_PERFIL[perfil];

  const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
  // A árvore Fable → Opus no feed depende do texto dos subagentes com `parent_tool_use_id` (01 §6.5).
  args.push('--forward-subagent-text');
  if (sessao.modo === 'novo') args.push('--session-id', sessao.sessionId);
  else args.push('--resume', sessao.sessionId);
  args.push('--model', entrada.modelo, '--effort', entrada.esforco);
  args.push('--settings', entrada.arquivos.settings);
  // Só o MCP gerado pela Forja (FJ-030 §4); `.mcp.json` do repo e o do usuário não carregam.
  const comMcp = Boolean(entrada.arquivos.mcp);
  if (comMcp) args.push('--mcp-config', entrada.arquivos.mcp as string);
  args.push('--strict-mcp-config');
  args.push('--append-system-prompt-file', entrada.arquivos.sistema);
  args.push('--max-budget-usd', formatarUsd(entrada.orcamentoUsd));
  args.push('--name', `forja-${entrada.numeroChamado}-${tipoEtapa}`);
  if (contrato && entrada.jsonSchema)
    args.push('--json-schema', JSON.stringify(entrada.jsonSchema));
  if (entrada.maxTurns) args.push('--max-turns', String(entrada.maxTurns));

  const ferramentas = FERRAMENTAS_DO_PERFIL[perfil];
  let envPerfil: Record<string, string> = {};
  switch (perfil) {
    case 'planejador':
      args.push('--restricted', '--tools', ferramentas.join(','));
      args.push('--allowedTools', ...ferramentas, ...(comMcp ? FERRAMENTAS_MCP_CHAMADOS : []));
      args.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');
      args.push('--add-dir', entrada.dirEntrada as string);
      break;
    case 'condutor_t1': {
      args.push('--tools', ferramentas.join(','));
      args.push('--dangerously-skip-permissions');
      args.push('--agents', entrada.arquivos.agentes as string);
      const negados = agentesParaNegar(entrada.agentesNegados ?? AGENTES_EMBUTIDOS_CONHECIDOS);
      if (negados.length > 0) args.push('--disallowedTools', ...negados.map((a) => `Agent(${a})`));
      args.push('--setting-sources', '');
      envPerfil = envSubagentes(modeloSubagentes);
      if (entrada.evidencias) {
        envPerfil.FORJA_EVIDENCIAS_DIR = entrada.evidencias.dir;
        if (entrada.evidencias.forjaPrint) envPerfil.FORJA_PRINT = entrada.evidencias.forjaPrint;
      }
      break;
    }
    case 'condutor_t2': {
      args.push('--setting-sources', '');
      args.push('--tools', ferramentas.join(','));
      args.push(
        '--allowedTools',
        ...ALLOW_T2,
        ...allowDosScripts(entrada.scriptsProjeto ?? []).filter((a) => !ALLOW_T2.includes(a)),
        ...(comMcp ? FERRAMENTAS_MCP_CHAMADOS : []),
      );
      args.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');
      args.push('--agents', entrada.arquivos.agentes as string);
      // [V S2] o allow em `dontAsk` NÃO restringe o tipo de subagente
      // (`Agent(general-purpose)` rodou no T2): nega explicitamente os de fora do papel.
      const negados = agentesParaNegar(
        entrada.agentesNegados ?? AGENTES_EMBUTIDOS_CONHECIDOS,
        'condutor_t2',
      );
      if (negados.length > 0) args.push('--disallowedTools', ...negados.map((a) => `Agent(${a})`));
      envPerfil = envSubagentes(modeloSubagentes);
      break;
    }
    case 'condutor_t3':
      args.push('--restricted', '--tools', ferramentas.join(','));
      if (comMcp) args.push('--allowedTools', ...FERRAMENTAS_MCP_CHAMADOS);
      args.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');
      break;
  }

  const env = { ...montarEnvBase(entrada.env), ...envPerfil };
  if (entrada.retomarTurnoInterrompido) env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1';
  assegurarEnvLimpo(env, Boolean(entrada.env.apiKey));

  const negadosEfetivos = comSubagentes
    ? agentesParaNegar(entrada.agentesNegados ?? AGENTES_EMBUTIDOS_CONHECIDOS, perfil)
    : [];
  return {
    executavel: EXECUTAVEL_CLAUDE,
    args,
    env,
    cwd: entrada.cwd,
    sessionId: sessao.sessionId,
    contrato,
    esperado: {
      perfil,
      permissionMode: MODO_PERMISSAO_DO_PERFIL[perfil],
      ferramentas,
      comSchema: contrato !== null,
      modelo: entrada.modelo,
      // T1 (bypass) e T2 (`dontAsk`, [V S2]): o allow não restringe o tipo de
      // subagente; só aceitamos os do papel ou os já negados. Planejador e T3 não têm `Agent`.
      agentesAceitos: comSubagentes ? [...AGENTES_DO_PAPEL[perfil], ...negadosEfetivos] : null,
      apiKeySource: entrada.env.apiKey ? 'api_key' : 'none',
      modelosPermitidos: comSubagentes ? [entrada.modelo, modeloSubagentes] : [entrada.modelo],
      mcpChamados: comMcp,
    },
  };
}

/** Nunca nega os agentes do próprio papel (nem nomes repetidos). */
function agentesParaNegar(
  lista: readonly string[],
  perfil: 'condutor_t1' | 'condutor_t2' = 'condutor_t1',
): string[] {
  const papel = new Set<string>(AGENTES_DO_PAPEL[perfil]);
  return [...new Set(lista)].filter((a) => !papel.has(a));
}

/** Última barreira: o env montado não pode conter nada proibido (05 §4.7). */
export function assegurarEnvLimpo(env: Record<string, string>, apiKeyPermitida = false): void {
  for (const nome of Object.keys(env)) {
    if (nome === 'ANTHROPIC_API_KEY' && apiKeyPermitida) continue;
    if (ENV_CLAUDE_PERMITIDAS.has(nome) || ENV_FORJA_PERMITIDAS.has(nome)) continue;
    if (variavelProibida(nome)) throw new ErroPerfil(`variável proibida no env do spawn: ${nome}`);
  }
}

/**
 * Lista de agentes negados atualizada a partir de um `init` (01 §6.2): todo
 * agente listado fora do papel do T1 entra; a ordem é estável para o cache.
 */
export function atualizarAgentesNegados(
  atuais: readonly string[],
  agentesDoInit: readonly string[],
): string[] {
  return agentesParaNegar([...atuais, ...agentesDoInit]).sort();
}

// ---------------------------------------------------------------------------
// Assumir (PTY) — 01 §6.2, 03 §10
// ---------------------------------------------------------------------------

export interface EntradaAssumir {
  sessionId: string;
  settings: string;
  modelo: string;
  cwd: string;
  env: OpcoesEnv;
}

/**
 * `claude --resume <id>` interativo, SEM bypass e sem `-p`: o humano responde
 * às permissões na TUI. Mantém `--settings` (deny) e zero MCP.
 */
export function montarComandoAssumir(
  entrada: EntradaAssumir,
): Omit<ComandoClaude, 'contrato' | 'esperado'> {
  if (!UUID.test(entrada.sessionId))
    throw new ErroPerfil(`session_id inválido: ${entrada.sessionId}`);
  const env = montarEnvBase(entrada.env);
  assegurarEnvLimpo(env, Boolean(entrada.env.apiKey));
  return {
    executavel: EXECUTAVEL_CLAUDE,
    // Mesmo argv de `terminal/pty.ts#argsAssumir`: `--setting-sources ""` impede
    // que settings escritos pelo agente na worktree (allow, env, apiKeyHelper) valham.
    args: [
      '--resume',
      entrada.sessionId,
      '--setting-sources',
      '',
      '--settings',
      entrada.settings,
      '--strict-mcp-config',
      '--permission-mode',
      'default',
      '--model',
      entrada.modelo,
    ],
    env,
    cwd: entrada.cwd,
    sessionId: entrada.sessionId,
  };
}

/** Registro de `etapa.perfil` (02 §4.7): argv efetivo sem o schema inteiro e só os NOMES do env. */
export function registroPerfil(comando: ComandoClaude): { argv: string[]; env: string[] } {
  const argv = comando.args.map((a, i) =>
    comando.args[i - 1] === '--json-schema' ? `<json-schema ${a.length} bytes>` : a,
  );
  return { argv: [comando.executavel, ...argv], env: Object.keys(comando.env).sort() };
}
