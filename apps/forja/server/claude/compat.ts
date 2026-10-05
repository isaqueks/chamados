import { execFile } from 'node:child_process';
import type { ItemDiagnosticoDto } from '../../comum/dto';
import type { ClassificacaoProcesso } from '../../comum/estados';
import {
  montarComando,
  montarEnvBase,
  MODO_PERMISSAO_DO_PERFIL,
  type ComandoClaude,
  type EntradaPerfil,
  type Env,
} from './perfis';
import { analisarLinha, DivisorLinhas } from './stream';

/**
 * Compatibilidade com a CLI do Claude (specs/forja/01 §7).
 *
 * A versão fixada é a versão em que tudo o que a spec marca [V] foi observado.
 * POR QUE fixar: a CLI muda formato de evento e semântica de flag entre
 * versões, o `DISABLE_AUTOUPDATER=1` só congela o binário entre spawns, e a doc
 * anuncia que `--bare` (que NÃO lê o login OAuth da assinatura) vai virar o
 * padrão do `-p`. Uma versão diferente bloqueia o pipeline até o humano
 * "aceitar versão X", o que dispara o smoke de perfis. Atualizar a constante
 * abaixo é mudança de spec com CHANGELOG.
 *
 * Tudo aqui recebe `exec` injetável: o boot e o Diagnóstico chamam o binário
 * real; os testes, um falso. Nenhuma checagem envia prompt (custo zero), salvo
 * o smoke de perfis, que só é MONTADO e AVALIADO aqui (quem roda é o runner).
 */

export const VERSAO_CLI_FIXADA = '2.1.288';
/** `merge-tree --write-tree` (01 §7). */
export const GIT_VERSAO_MINIMA = '2.38.0';

export interface SaidaExec {
  codigo: number | null;
  stdout: string;
  stderr: string;
}

export type FuncaoExec = (
  executavel: string,
  args: string[],
  opcoes?: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<SaidaExec>;

/** `execFile` sem shell, com env allowlist (nunca o env do app) e timeout. */
export function criarExecPadrao(envOrigem: Env = process.env): FuncaoExec {
  return (executavel, args, opcoes = {}) =>
    new Promise((ok) => {
      execFile(
        executavel,
        args,
        {
          env: opcoes.env ?? montarEnvBase({ envOrigem }),
          timeout: opcoes.timeoutMs ?? 20_000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
        },
        (erro, stdout, stderr) => {
          const codigo =
            erro === null ? 0 : typeof erro.code === 'number' ? erro.code : erro.code ? 127 : null;
          ok({ codigo, stdout: String(stdout), stderr: String(stderr || (erro?.message ?? '')) });
        },
      );
    });
}

export function analisarVersao(texto: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(texto)?.[1] ?? null;
}

/** `-1`, `0` ou `1`, comparando `x.y.z` numericamente. */
export function compararVersoes(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface VersaoVerificada {
  encontrada: string | null;
  ok: boolean;
  erro: string | null;
}

/** Boot: `claude --version` = fixada (custo zero). */
export async function verificarVersaoCli(
  exec: FuncaoExec,
  fixada: string = VERSAO_CLI_FIXADA,
): Promise<VersaoVerificada> {
  const r = await exec('claude', ['--version']);
  if (r.codigo !== 0)
    return { encontrada: null, ok: false, erro: r.stderr.trim() || 'claude não encontrado' };
  const encontrada = analisarVersao(r.stdout);
  return {
    encontrada,
    ok: encontrada === fixada,
    erro: encontrada ? null : 'saída de --version inesperada',
  };
}

export interface AuthVerificada {
  ok: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  erro: string | null;
}

/** Boot: `claude auth status` (exit 0, `authMethod`, `subscriptionType`). Nunca guarda o e-mail. */
export async function verificarAuthCli(exec: FuncaoExec): Promise<AuthVerificada> {
  const r = await exec('claude', ['auth', 'status']);
  if (r.codigo !== 0) {
    return {
      ok: false,
      authMethod: null,
      subscriptionType: null,
      erro: r.stderr.trim() || 'sem login',
    };
  }
  try {
    const json = JSON.parse(r.stdout) as Record<string, unknown>;
    const authMethod = typeof json.authMethod === 'string' ? json.authMethod : null;
    const subscriptionType =
      typeof json.subscriptionType === 'string' ? json.subscriptionType : null;
    const logado = json.loggedIn !== false && authMethod !== null && authMethod !== 'none';
    return { ok: logado, authMethod, subscriptionType, erro: logado ? null : 'sem login' };
  } catch {
    return {
      ok: false,
      authMethod: null,
      subscriptionType: null,
      erro: 'saída de auth status não é JSON',
    };
  }
}

export async function verificarGit(exec: FuncaoExec): Promise<VersaoVerificada> {
  const r = await exec('git', ['--version']);
  if (r.codigo !== 0) return { encontrada: null, ok: false, erro: 'git não encontrado' };
  const encontrada = analisarVersao(r.stdout);
  if (!encontrada)
    return { encontrada: null, ok: false, erro: 'saída de git --version inesperada' };
  return { encontrada, ok: compararVersoes(encontrada, GIT_VERSAO_MINIMA) >= 0, erro: null };
}

/**
 * `--bare` virou padrão do `-p`? (01 §7): falha de autenticação no spawn com
 * `auth status` OK, ou `apiKeySource ≠ none` sem o usuário ter escolhido API key.
 */
export function detectarBarePadrao(e: {
  classificacao: ClassificacaoProcesso | null;
  authStatusOk: boolean;
  apiKeySource: string | null;
  usaApiKey: boolean;
}): boolean {
  if (e.classificacao === 'autenticacao' && e.authStatusOk) return true;
  return !e.usaApiKey && e.apiKeySource !== null && e.apiKeySource !== 'none';
}

/** Itens do Diagnóstico (06 §4.10) das checagens de boot. */
export function itensDiagnosticoCli(
  versao: VersaoVerificada,
  auth: AuthVerificada,
  git: VersaoVerificada,
  fixada: string = VERSAO_CLI_FIXADA,
): ItemDiagnosticoDto[] {
  return [
    {
      codigo: 'cli_versao',
      titulo: 'Versão da CLI do Claude',
      // Versão DIFERENTE da validada é só AVISO (2026-10-03: a CLI se auto-
      // atualizou 2.1.288 → 2.1.289 e o pipeline inteiro parou, com a fila de
      // merge presa atrás de um "aceitar versão"). Só CLI AUSENTE bloqueia.
      estado: versao.ok ? 'ok' : versao.encontrada ? 'aviso' : 'erro',
      detalhe: versao.ok
        ? `claude ${fixada}`
        : versao.encontrada
          ? `claude ${versao.encontrada} (a Forja foi validada com ${fixada}; segue normalmente — se algo mudar de comportamento, rode o smoke de perfis no Diagnóstico).`
          : `CLI não encontrada (${versao.erro ?? 'erro'}).`,
      bloqueia: versao.ok || versao.encontrada ? null : 'pipeline',
      acao: null,
    },
    {
      codigo: 'cli_login',
      titulo: 'Login da CLI do Claude',
      estado: auth.ok ? 'ok' : 'erro',
      detalhe: auth.ok
        ? `${auth.authMethod ?? '?'}${auth.subscriptionType ? ` (${auth.subscriptionType})` : ''}`
        : `Sem login (${auth.erro ?? 'erro'}). Faça o login no Terminal.`,
      bloqueia: auth.ok ? null : 'pipeline',
      acao: auth.ok ? null : { rotulo: 'Abrir terminal', href: '/terminal' },
    },
    {
      codigo: 'git_versao',
      titulo: 'Git',
      estado: git.ok ? 'ok' : 'erro',
      detalhe: git.ok
        ? `git ${git.encontrada}`
        : `Precisa de git ≥ ${GIT_VERSAO_MINIMA} (${git.encontrada ?? git.erro ?? 'não encontrado'}).`,
      bloqueia: git.ok ? null : 'pipeline',
      acao: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Smoke de perfis (versão nova / sob demanda)
// ---------------------------------------------------------------------------

/** Schema trivial do smoke: prova que `--json-schema` é aceito e devolvido. */
export const SCHEMA_SMOKE = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
} as const;

export const PROMPT_SMOKE = 'Responda apenas chamando a saída estruturada com {"ok": true}.';

/**
 * Mesmo conjunto de flags do perfil, mas barato: `--model haiku`,
 * `--max-turns 1`, `--max-budget-usd 0.05`, schema trivial e, nos perfis sem
 * subagentes, `--tools ""` (01 §7).
 */
export function comandoSmokePerfil(entrada: EntradaPerfil): ComandoClaude {
  const comando = montarComando({
    ...entrada,
    conversar: false,
    retomarTurnoInterrompido: false,
    modelo: 'haiku',
    orcamentoUsd: 0.05,
    maxTurns: 1,
    jsonSchema: { ...SCHEMA_SMOKE },
  });
  const semSubagentes = entrada.perfil === 'planejador' || entrada.perfil === 'condutor_t3';
  if (semSubagentes) {
    const i = comando.args.indexOf('--tools');
    if (i >= 0) comando.args[i + 1] = '';
  }
  return comando;
}

export interface ResultadoSmoke {
  ok: boolean;
  falhas: string[];
  capabilities: string[];
}

/** Avalia a saída de um smoke de perfil (01 §7, linhas "idem"). */
export function avaliarSmoke(e: {
  perfil: EntradaPerfil['perfil'];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): ResultadoSmoke {
  const falhas: string[] = [];
  if (/unknown option|error: option|not a valid JSON Schema/i.test(e.stderr)) {
    falhas.push(`flag recusada pela CLI: ${e.stderr.trim().split('\n')[0] ?? ''}`);
  }
  const divisor = new DivisorLinhas();
  const linhas = [...divisor.empurrar(e.stdout), ...divisor.finalizar()];
  let init: Record<string, unknown> | null = null;
  let results = 0;
  let comStructured = 0;
  let rateLimits = 0;
  for (const linha of linhas) {
    const a = analisarLinha(linha);
    if (a.tipo !== 'mensagem') continue;
    const m = a.mensagem;
    if (m.type === 'system' && m.subtype === 'init' && !init) init = m;
    if (m.type === 'result') {
      results += 1;
      if (m.structured_output !== undefined && m.structured_output !== null) comStructured += 1;
    }
    if (m.type === 'rate_limit_event') rateLimits += 1;
  }
  if (!init) falhas.push('nenhum system/init no stream');
  else {
    if (!Array.isArray(init.capabilities)) falhas.push('init sem capabilities');
    if (init.apiKeySource !== 'none')
      falhas.push(`apiKeySource ${String(init.apiKeySource)} ≠ none`);
    const modo = MODO_PERMISSAO_DO_PERFIL[e.perfil];
    if (init.permissionMode !== modo)
      falhas.push(`permissionMode ${String(init.permissionMode)} ≠ ${modo}`);
  }
  if (results !== 1) falhas.push(`esperado exatamente 1 result, vieram ${results}`);
  if (comStructured !== 1) falhas.push('result sem structured_output');
  if (rateLimits !== 1) falhas.push(`esperado 1 rate_limit_event, vieram ${rateLimits}`);
  if (e.exitCode !== 0) falhas.push(`exit code ${e.exitCode ?? 'nulo'}`);
  return {
    ok: falhas.length === 0,
    falhas,
    capabilities: init && Array.isArray(init.capabilities) ? (init.capabilities as string[]) : [],
  };
}
