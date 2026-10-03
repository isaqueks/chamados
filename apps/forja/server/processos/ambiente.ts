/**
 * Ambiente dos filhos por ALLOWLIST (specs/forja/01 §6.1, 05 §4.7). POR QUE
 * construir do zero e nunca `{...process.env}` menos algo: o processo da Forja
 * herda do terminal do usuário variáveis que não podem chegar a um agente em
 * bypass nem a um PTY — `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID` (aninhamento quebra
 * a persistência da sessão, 01 §13), `GH_TOKEN`, `SSH_AUTH_SOCK`, `CHAMADOS_*`,
 * `ANTHROPIC_API_KEY`. Uma lista de exclusão esquece a próxima variável nova;
 * uma allowlist falha fechada.
 *
 * Este módulo só monta a BASE comum (01 §6.1). O que é de cada perfil (env do
 * perfil de agente, variáveis declaradas do projeto, `TERM` do PTY) entra por
 * `extras`, que vence a base — mas nunca reintroduz uma variável proibida.
 */

/** Herdadas do processo da Forja quando existirem (01 §6.1). `LC_*` entra por prefixo. */
export const VARIAVEIS_HERDADAS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TERM',
  'SHELL',
  'TMPDIR',
];

/** Sempre presentes em todo filho `claude` (01 §6.1, 05 §4.6). */
export const VARIAVEIS_FIXAS: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
};

/**
 * Nunca entram, nem por `extras` (05 §4.7). `ANTHROPIC_API_KEY` só com a opção
 * explícita do usuário (`permitirApiKey`, 05 §10).
 */
const PROIBIDAS_EXATAS: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
]);

function proibida(nome: string, permitirApiKey: boolean): boolean {
  if (PROIBIDAS_EXATAS.has(nome)) return true;
  if (nome === 'ANTHROPIC_API_KEY') return !permitirApiKey;
  if (nome.startsWith('CHAMADOS_')) return true;
  // Sockets/tokens de sessão da CLI-mãe (`CLAUDE_CODE_*_SOCKET`, `…_TOKEN`).
  if (/^CLAUDE_CODE_.*_(SOCKET|TOKEN)$/.test(nome)) return true;
  return false;
}

export interface OpcoesAmbiente {
  /** Variáveis do perfil/projeto/PTY; vencem a base. */
  extras?: Readonly<Record<string, string | undefined>>;
  /** Liga `ANTHROPIC_API_KEY` nos `extras` (opção do usuário, 05 §10). */
  permitirApiKey?: boolean;
  /** Sem `VARIAVEIS_FIXAS` (ex.: um comando de verificação que não é `claude`). */
  semFixas?: boolean;
}

export class ErroAmbienteProibido extends Error {}

/**
 * Monta o env de um filho a partir do env do processo (só para LER as herdadas).
 * Uma variável proibida em `extras` é erro de programação: lança, em vez de
 * descartar em silêncio (quem passou achava que ela chegaria).
 */
export function montarAmbiente(
  origem: Readonly<Record<string, string | undefined>>,
  opcoes: OpcoesAmbiente = {},
): Record<string, string> {
  const permitirApiKey = opcoes.permitirApiKey ?? false;
  const env: Record<string, string> = {};
  for (const nome of VARIAVEIS_HERDADAS) {
    const valor = origem[nome];
    if (valor !== undefined) env[nome] = valor;
  }
  for (const [nome, valor] of Object.entries(origem)) {
    if (nome.startsWith('LC_') && valor !== undefined) env[nome] = valor;
  }
  if (!opcoes.semFixas) Object.assign(env, VARIAVEIS_FIXAS);
  for (const [nome, valor] of Object.entries(opcoes.extras ?? {})) {
    if (valor === undefined) continue;
    if (proibida(nome, permitirApiKey)) {
      throw new ErroAmbienteProibido(`variável proibida no ambiente do filho: ${nome}`);
    }
    env[nome] = valor;
  }
  return env;
}
