import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import type { Esforco, NomePerfil } from './perfis';

/**
 * Arquivos gerados por spawn (specs/forja/01 §6.3; 05 §4.4; 04 §3): o
 * `settings.json` com `permissions.deny` + `disableAllHooks`, o `agentes.json`
 * do `--agents` e o arquivo do `--append-system-prompt-file`.
 *
 * POR QUE `deny` e não `allow`: em `--dangerously-skip-permissions` o allow não
 * restringe nada, mas o deny continua valendo (01 §6 da pesquisa). Sem sandbox
 * (U-3) ele não é fronteira — `cat`/script escapam — e sim um corrimão que
 * impede o caminho óbvio e deixa rastro em `permission_denials`.
 *
 * Duas regras da documentação da CLI (permissions.md, 2.1.288) moldam a lista:
 * - caminho absoluto em regra de arquivo é `//caminho`; `/caminho` ancora no
 *   diretório do arquivo de settings, não na raiz;
 * - regra de caminho com `Write(...)` é aceita mas NUNCA consultada; `Edit(...)`
 *   cobre todas as ferramentas que editam, e `Read(...)` negado já bloqueia
 *   Edit/Write no mesmo caminho. Por isso a spec diz "Read/Edit/Write" e aqui
 *   saem só `Read` e `Edit`.
 *
 * Um `deny` não tem exceção, e a worktree da própria execução mora em
 * `<dados>/worktrees/` (F-09): o diretório de dados é negado por ENUMERAÇÃO dos
 * caminhos sensíveis, nunca `<dados>/**` inteiro (05 §4.4, nota de layout).
 * `configuracoes.json` (globais, FJ-030 §2) entra na lista.
 */

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

export interface EntradaSettings {
  perfil: NomePerfil;
  /** Raiz do diretório de dados da Forja (absoluto). */
  dirDados: string;
  execucaoId: string;
  /**
   * Ids das outras execuções (só o planejador precisa: lê a própria `entrada/`).
   * Somam-se aos diretórios que existem em `<dados>/execucoes/` (lidos aqui).
   */
  outrasExecucoes?: readonly string[];
  /** Worktree desta execução (fica de fora do deny). */
  worktreePropria: string;
  /**
   * Worktrees conhecidas pelo estado (as de outras execuções ativas). Somam-se
   * às que existem no disco em `<dados>/worktrees/<projeto>/*` (lidas aqui) e
   * à regra fixa de `_integracao/**`.
   */
  worktreesExistentes: readonly string[];
  /** `repo.dir` do projeto: o checkout do usuário. */
  repoDirUsuario: string;
  /** `repo.dir` dos OUTROS projetos cadastrados. */
  reposOutrosProjetos: readonly string[];
  /** Branch de destino (`git checkout <destino>*` negado). */
  branchDestino: string;
  /** Bloco `sandbox` do modo reforçado (05 §5.1), passado adiante sem interpretação. */
  sandbox?: Record<string, unknown> | null;
}

export interface SettingsGerados {
  disableAllHooks: true;
  permissions: { deny: string[] };
  sandbox?: Record<string, unknown>;
}

export class ErroArquivosGerados extends Error {}

/** `//caminho/absoluto` (regra de arquivo da CLI). */
export function caminhoRegra(caminho: string): string {
  if (!isAbsolute(caminho)) throw new ErroArquivosGerados(`caminho não absoluto: ${caminho}`);
  const n = normalize(caminho).replace(/\/+$/, '');
  return `/${n}`;
}

/** Git que é do app (F-01, F-08): o agente nunca versiona nem publica. */
function negacoesGit(branchDestino: string): string[] {
  return [
    'Bash(git push*)',
    'Bash(git remote*)',
    'Bash(git reset --hard*)',
    `Bash(git checkout ${branchDestino}*)`,
    'Bash(git merge*)',
    'Bash(git worktree*)',
    'Bash(git commit*)',
    'Bash(git rebase*)',
    'Bash(git stash*)',
    'Bash(git tag*)',
  ];
}

const NEGACOES_SEGREDOS_USUARIO = [
  'Read(~/.ssh/**)',
  'Read(~/.config/gh/**)',
  'Read(~/.claude/.credentials.json)',
];

/** Persistência e cópia do usuário (01 §6.3, só no T1, o único com Edit). */
const NEGACOES_EDICAO_USUARIO = [
  'Edit(~/.bashrc)',
  'Edit(~/.zshrc)',
  'Edit(~/.profile)',
  'Edit(~/.gitconfig)',
  'Edit(~/.claude/**)',
  'Edit(~/.config/**)',
];

function lerEditar(regraCaminho: string): string[] {
  return [`Read(${regraCaminho})`, `Edit(${regraCaminho})`];
}

/** Arquivos gerados por etapa (o `mcp.*` leva o token da sessão do Chamados, FJ-030 §4). */
const ARQUIVOS_GERADOS_ETAPA = ['settings.*', 'agentes.*', 'sistema.*', 'mcp.*'];

/** Sub-caminhos da própria execução que o planejador não lê (só `entrada/`). */
const SUBDIRS_EXECUCAO_FORA_DA_ENTRADA = ['contexto', 'etapas', 'logs', 'evidencias', 'artefatos'];

/**
 * T2 (`dontAsk` com allow `Bash(git diff|log|show *)`): o casamento é por
 * prefixo, então o allow também aceitaria opções que ESCREVEM em qualquer
 * caminho (`--output=<arq>`), leem fora da worktree (`--no-index`, ou
 * caminho absoluto/`~`/`../`/`$VAR` — o `git diff` vira `--no-index` sozinho
 * quando um caminho está fora do repo) ou executam programa configurável
 * (`--ext-diff`, `--textconv`). O deny vence o allow. `git -C <dir>` também
 * cai em ` /`.
 */
export const NEGACOES_GIT_LEITURA_T2: readonly string[] = [
  'Bash(git *--output*)',
  'Bash(git *--no-index*)',
  'Bash(git *--ext-diff*)',
  'Bash(git *--textconv*)',
  'Bash(git * /*)',
  'Bash(git * ~*)',
  'Bash(git *../*)',
  'Bash(git *$*)',
];

/** Subdiretórios reais de `dir` (vazio se não existe). */
function subdiretorios(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * Worktrees que EXISTEM em `<dados>/worktrees/<projeto>/<x>` (fora de
 * `_integracao/`, que tem regra fixa). POR QUE ler o disco e não só o estado
 * ativo: worktrees retidas de execuções terminais (7 dias) continuam com o
 * código e o `.env` de outro chamado.
 */
function worktreesNoDisco(dirDados: string): string[] {
  return subdiretorios(join(dirDados, 'worktrees')).flatMap((projeto) =>
    subdiretorios(projeto).filter((d) => !d.endsWith('/_integracao')),
  );
}

/** Ids com diretório real em `<dados>/execucoes/` (inclui terminais retidas). */
function execucoesNoDisco(dirDados: string): string[] {
  return subdiretorios(join(dirDados, 'execucoes')).map((d) => d.slice(d.lastIndexOf('/') + 1));
}

export function gerarSettings(entrada: EntradaSettings): SettingsGerados {
  const dados = caminhoRegra(entrada.dirDados);
  const propria = normalize(entrada.worktreePropria).replace(/\/+$/, '');
  const deny: string[] = [...negacoesGit(entrada.branchDestino), ...NEGACOES_SEGREDOS_USUARIO];

  deny.push(...lerEditar(`${dados}/forja.db*`));
  deny.push(...lerEditar(`${dados}/backups/**`));
  deny.push(...lerEditar(`${dados}/credenciais.json`));
  deny.push(...lerEditar(`${dados}/configuracoes.json`));
  deny.push(...lerEditar(`${dados}/projetos/**`));
  if (entrada.perfil === 'planejador') {
    // O planejador lê `<exec>/entrada/` por `--add-dir`: negar `execucoes/**` inteiro o cegaria.
    const exec = `${dados}/execucoes/${entrada.execucaoId}`;
    for (const sub of SUBDIRS_EXECUCAO_FORA_DA_ENTRADA)
      deny.push(...lerEditar(`${exec}/${sub}/**`));
    for (const arq of ARQUIVOS_GERADOS_ETAPA) deny.push(...lerEditar(`${exec}/${arq}`));
    const outras = new Set([
      ...(entrada.outrasExecucoes ?? []),
      ...execucoesNoDisco(entrada.dirDados),
    ]);
    for (const outra of outras) {
      if (outra !== entrada.execucaoId) deny.push(...lerEditar(`${dados}/execucoes/${outra}/**`));
    }
  } else if (entrada.perfil === 'condutor_t1') {
    // B7 (FJ-030 §3): o T1 escreve os prints e o `telas.json` em
    // `<exec>/evidencias/`. Um deny não tem exceção, então a própria execução é
    // negada por ENUMERAÇÃO (tudo menos `evidencias/`) e as outras inteiras.
    const exec = `${dados}/execucoes/${entrada.execucaoId}`;
    for (const sub of [...SUBDIRS_EXECUCAO_FORA_DA_ENTRADA, 'entrada'].filter(
      (x) => x !== 'evidencias',
    )) {
      deny.push(...lerEditar(`${exec}/${sub}/**`));
    }
    for (const arq of ARQUIVOS_GERADOS_ETAPA) deny.push(...lerEditar(`${exec}/${arq}`));
    const outras = new Set([
      ...(entrada.outrasExecucoes ?? []),
      ...execucoesNoDisco(entrada.dirDados),
    ]);
    for (const outra of outras) {
      if (outra !== entrada.execucaoId) deny.push(...lerEditar(`${dados}/execucoes/${outra}/**`));
    }
  } else {
    deny.push(...lerEditar(`${dados}/execucoes/**`));
  }
  // Fila de merge e `base-<exec8>` dos prints (05 §4.4): regra fixa por projeto.
  if (!propria.split('/').includes('_integracao')) {
    deny.push(...lerEditar(`${dados}/worktrees/*/_integracao/**`));
  }
  const worktrees = new Set([
    ...entrada.worktreesExistentes,
    ...worktreesNoDisco(entrada.dirDados),
  ]);
  for (const wt of worktrees) {
    if (normalize(wt).replace(/\/+$/, '') === propria) continue;
    deny.push(...lerEditar(`${caminhoRegra(wt)}/**`));
  }
  deny.push('Read(./.env*)', 'Edit(./.env*)');
  for (const repo of entrada.reposOutrosProjetos) deny.push(`Read(${caminhoRegra(repo)}/**)`);
  if (entrada.perfil === 'condutor_t1') {
    deny.push(...NEGACOES_EDICAO_USUARIO);
    const repo = caminhoRegra(entrada.repoDirUsuario);
    deny.push(`Edit(${repo}/.git/hooks/**)`, `Edit(${repo}/.git/config)`, `Edit(${repo}/**)`);
  }
  if (entrada.perfil === 'condutor_t2') deny.push(...NEGACOES_GIT_LEITURA_T2);
  deny.push('WebFetch', 'WebSearch');

  const settings: SettingsGerados = {
    disableAllHooks: true,
    permissions: { deny: [...new Set(deny)] },
  };
  if (entrada.sandbox) settings.sandbox = entrada.sandbox;
  return settings;
}

// ---------------------------------------------------------------------------
// agentes.json (04 §3)
// ---------------------------------------------------------------------------

const ID_MODELO_COMPLETO = /^claude-[a-z]+-\d+(-\d+)*(-\d{8})?$/;

/**
 * Definição de um subagente no `--agents`. `.strict()` porque a CLI ignora campo
 * desconhecido sem erro (04 §3): um typo viraria silêncio. Os campos proibidos
 * (`mcpServers`, `hooks`, `memory`, `isolation`, `skills`, `background`,
 * `initialPrompt`, `disallowedTools`) simplesmente não existem no schema.
 */
export const DefinicaoAgente = z
  .object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().regex(ID_MODELO_COMPLETO, 'ID completo do modelo, nunca alias'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    tools: z
      .array(z.string().min(1))
      .min(1)
      .refine((t) => !t.includes('Agent') && !t.includes('Task'), 'subagente nunca tem Agent'),
    maxTurns: z.number().int().positive(),
    omitClaudeMd: z.literal(true),
    permissionMode: z.literal('dontAsk').optional(),
  })
  .strict();
export type DefinicaoAgente = z.infer<typeof DefinicaoAgente>;

export const ArquivoAgentes = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), DefinicaoAgente);
export type ArquivoAgentes = z.infer<typeof ArquivoAgentes>;

export const MAX_TURNS_IMPLEMENTADOR = 80;
export const MAX_TURNS_REVISOR = 40;

const FERRAMENTAS_IMPLEMENTADOR = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
const FERRAMENTAS_REVISOR = ['Read', 'Grep', 'Glob', 'Bash'];

export interface EntradaAgentesT1 {
  modelo: string;
  esforco: Esforco;
  /** B1–B3 do implementador (`prompts.ts`). */
  promptImplementador: string;
}

export function gerarAgentesT1(entrada: EntradaAgentesT1): ArquivoAgentes {
  return ArquivoAgentes.parse({
    implementador: {
      description:
        'Implementa UM passo do plano aprovado, só nos arquivos permitidos daquele passo. Use para toda edição de código.',
      prompt: entrada.promptImplementador,
      model: entrada.modelo,
      effort: entrada.esforco,
      tools: FERRAMENTAS_IMPLEMENTADOR,
      maxTurns: MAX_TURNS_IMPLEMENTADOR,
      omitClaudeMd: true,
    },
  });
}

export interface EntradaAgentesT2 {
  modelo: string;
  esforco: Esforco;
  promptRevisorCorrecao: string;
  promptRevisorSeguranca: string;
}

export function gerarAgentesT2(entrada: EntradaAgentesT2): ArquivoAgentes {
  const comum = {
    model: entrada.modelo,
    effort: entrada.esforco,
    tools: FERRAMENTAS_REVISOR,
    maxTurns: MAX_TURNS_REVISOR,
    omitClaudeMd: true,
    permissionMode: 'dontAsk',
  };
  return ArquivoAgentes.parse({
    revisor_correcao: {
      description:
        'Revisa o diff contra o plano e os critérios de aceite (aderência, regressões, testes, escopo, regras de negócio, schema). Use sempre no T2.',
      prompt: entrada.promptRevisorCorrecao,
      ...comum,
    },
    revisor_seguranca: {
      description:
        'Revisa o diff com o checklist de segurança fixo (segredos, rede, leitura fora da worktree, SQL, authz, dependências, CI, ofuscação). Use quando a revisão de segurança for obrigatória.',
      prompt: entrada.promptRevisorSeguranca,
      ...comum,
    },
  });
}

// ---------------------------------------------------------------------------
// Gravação no diretório da execução (02 §7)
// ---------------------------------------------------------------------------

/** `mcp.<n>.json` (`--mcp-config`, FJ-030 §4): só o servidor `chamados`. */
export interface ConfigMcpGerada {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

/**
 * MCP do Chamados para os agentes (FJ-030 §4): o `apps/mcp` existente, em modo
 * SOMENTE LEITURA, logado pelo token da sessão da conexão da Forja. Exposição
 * aceita (05 §4): os agentes já rodam como o usuário; o token no env do
 * processo do MCP não amplia o que já estava ao alcance. Escrever no Chamados
 * continua só pelo app (outbox).
 */
export function gerarConfigMcp(
  servidor: { command: string; args: readonly string[] },
  credencial: { url: string; tenant: string | null; email: string; token: string },
  envBase: Readonly<Record<string, string | undefined>> = {},
): ConfigMcpGerada {
  const env: Record<string, string> = {};
  for (const nome of ['PATH', 'HOME', 'LANG']) {
    const v = envBase[nome];
    if (v) env[nome] = v;
  }
  Object.assign(env, {
    CHAMADOS_URL: credencial.url,
    CHAMADOS_EMAIL: credencial.email,
    CHAMADOS_TOKEN: credencial.token,
    CHAMADOS_MCP_SOMENTE_LEITURA: 'true',
  });
  if (credencial.tenant) env.CHAMADOS_TENANT = credencial.tenant;
  return { mcpServers: { chamados: { command: servidor.command, args: [...servidor.args], env } } };
}

export interface ConteudoArquivosEtapa {
  settings: SettingsGerados;
  agentes?: ArquivoAgentes | null;
  mcp?: ConfigMcpGerada | null;
  /** Blocos do `--append-system-prompt-file`. */
  sistema: string;
}

export interface ArquivosGravados {
  settings: string;
  agentes: string | null;
  sistema: string;
  mcp: string | null;
  /** sha256 de cada arquivo, para `etapa.perfil` (02 §4.7). O do `mcp` cobre o token: só o hash sai. */
  sha256: { settings: string; agentes: string | null; sistema: string; mcp: string | null };
}

function sha256(conteudo: string): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

/**
 * Grava `settings.<n>.json`, `agentes.<n>.json` e `sistema.<n>.md` em
 * `<dados>/execucoes/<id>/` (fora da worktree; nunca reaproveitados entre etapas).
 */
export async function gravarArquivosEtapa(
  dirExecucao: string,
  n: number,
  conteudo: ConteudoArquivosEtapa,
): Promise<ArquivosGravados> {
  if (!Number.isInteger(n) || n < 1)
    throw new ErroArquivosGerados(`número de etapa inválido: ${n}`);
  await mkdir(dirExecucao, { recursive: true, mode: 0o700 });
  const settingsTxt = `${JSON.stringify(conteudo.settings, null, 2)}\n`;
  const agentesTxt = conteudo.agentes
    ? `${JSON.stringify(ArquivoAgentes.parse(conteudo.agentes), null, 2)}\n`
    : null;
  const mcpTxt = conteudo.mcp ? `${JSON.stringify(conteudo.mcp, null, 2)}\n` : null;
  const caminhos = {
    settings: join(dirExecucao, `settings.${n}.json`),
    agentes: agentesTxt ? join(dirExecucao, `agentes.${n}.json`) : null,
    sistema: join(dirExecucao, `sistema.${n}.md`),
    mcp: mcpTxt ? join(dirExecucao, `mcp.${n}.json`) : null,
  };
  await writeFile(caminhos.settings, settingsTxt, { mode: 0o600 });
  if (caminhos.agentes && agentesTxt)
    await writeFile(caminhos.agentes, agentesTxt, { mode: 0o600 });
  await writeFile(caminhos.sistema, conteudo.sistema, { mode: 0o600 });
  if (caminhos.mcp && mcpTxt) await writeFile(caminhos.mcp, mcpTxt, { mode: 0o600 });
  return {
    ...caminhos,
    sha256: {
      settings: sha256(settingsTxt),
      agentes: agentesTxt ? sha256(agentesTxt) : null,
      sistema: sha256(conteudo.sistema),
      mcp: mcpTxt ? sha256(mcpTxt) : null,
    },
  };
}
