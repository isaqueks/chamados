import * as nodePty from 'node-pty';
import { montarAmbiente } from '../processos/ambiente';
import { sinalizarGrupoReal } from '../processos/supervisor';

/**
 * PTY do Terminal (specs/forja/01 §11, 05 §7.2, 03 §10). O `node-pty` roda o
 * `claude` INTERATIVO (a TUI) e o xterm.js da SPA exibe. Dois usos:
 *
 * - **livre**: `claude` no repo ou numa worktree — o "Claude normal" do
 *   usuário, com os settings e MCPs dele, fora do pipeline (F-13);
 * - **assumida**: `claude --resume <session_id> --setting-sources ""
 *   --settings <settings da etapa> --strict-mcp-config --permission-mode
 *   default --model <id>` — valem o `deny` e o `disableAllHooks` da etapa,
 *   mas **sem bypass**: a TUI pede as permissões ao humano (05 §7.2).
 *
 * POR QUE `--setting-sources ""` no Assumir: sem ele a TUI carregaria o
 * `.claude/settings.json`/`settings.local.json` DA WORKTREE — que o agente em
 * bypass pode ter escrito (o `.local` costuma ser gitignored e nem aparece no
 * diff) — com `permissions.allow`, `env` (`ANTHROPIC_BASE_URL`) ou
 * `apiKeyHelper`: o humano acabaria numa TUI que executa sem perguntar. Só o
 * `--settings` gerado pelo app vale (o mesmo corte validado no T1/T2, S2).
 * `--permission-mode default` explícito: a sessão nasceu em bypass.
 *
 * POR QUE `argsAssumir` recusa qualquer flag de bypass: a sessão assumida
 * nasceu num `claude -p --dangerously-skip-permissions`; um descuido que
 * repassasse as flags do perfil deixaria o humano numa TUI que executa tudo
 * sem perguntar. Falha fechada.
 *
 * Env: a allowlist de 01 §6.1 (sem tokens da Forja nem `SSH_AUTH_SOCK`) +
 * `TERM=xterm-256color`. Na assumida também `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`
 * (04 §4.3: a sessão do pipeline usa o CLAUDE.md do commit base, não o da
 * worktree que o agente editou); na livre não — é o Claude normal do usuário.
 *
 * O `node-pty` faz `setsid` no filho: `pgid = sid = pid`. Sinais vão para o
 * grupo (`-pid`), como no supervisor, para pegar o Bash e os netos da TUI.
 */

export const TERM_PTY = 'xterm-256color';
export const COLUNAS_PADRAO = 120;
export const LINHAS_PADRAO = 32;
/** Limites do redimensionar vindo do navegador (frame de controle não confiável). */
export const MAX_COLUNAS = 1000;
export const MAX_LINHAS = 500;

/** Flags que NUNCA entram num PTY (05 §7.2: Assumir é sem bypass). */
const FLAGS_PROIBIDAS: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);

export class ErroArgsPty extends Error {}

/** Recusa bypass em qualquer forma (`--permission-mode bypassPermissions`, `=…`). */
export function validarArgsSemBypass(args: readonly string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const [flag, valorInline] = a.split('=', 2) as [string, string | undefined];
    if (FLAGS_PROIBIDAS.has(flag)) throw new ErroArgsPty(`flag proibida no PTY: ${flag}`);
    if (flag === '--permission-mode') {
      const valor = valorInline ?? args[i + 1];
      if (valor === 'bypassPermissions') {
        throw new ErroArgsPty('--permission-mode bypassPermissions é proibido no PTY');
      }
    }
  }
}

export interface ParametrosAssumir {
  session_id: string;
  /** `settings.<n>.json` gerado da etapa (deny + disableAllHooks). */
  settings: string;
  modelo: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** argv do "Assumir" (01 §11, 03 §10). */
export function argsAssumir(p: ParametrosAssumir): string[] {
  if (!UUID.test(p.session_id)) throw new ErroArgsPty(`session_id inválido: ${p.session_id}`);
  if (!p.settings.startsWith('/')) throw new ErroArgsPty('settings precisa ser caminho absoluto');
  if (!p.modelo.trim()) throw new ErroArgsPty('modelo obrigatório no Assumir');
  const args = [
    '--resume',
    p.session_id,
    '--setting-sources',
    '',
    '--settings',
    p.settings,
    '--strict-mcp-config',
    '--permission-mode',
    'default',
    '--model',
    p.modelo,
  ];
  validarArgsSemBypass(args);
  return args;
}

/** argv do chat livre: `claude` puro, com a configuração do usuário. */
export function argsLivre(): string[] {
  return [];
}

export interface OpcoesAmbientePty {
  assumida: boolean;
  origem?: Readonly<Record<string, string | undefined>>;
}

export function ambientePty(opcoes: OpcoesAmbientePty): Record<string, string> {
  const extras: Record<string, string> = { TERM: TERM_PTY };
  if (opcoes.assumida) extras.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  return montarAmbiente(opcoes.origem ?? process.env, { extras });
}

export interface FimPty {
  codigo: number | null;
  sinal: string | null;
}

/** O que o gerente de sessões precisa de um PTY (fácil de simular em teste). */
export interface ProcessoPty {
  readonly pid: number;
  aoDados(fn: (dados: string) => void): () => void;
  aoSair(fn: (fim: FimPty) => void): () => void;
  escrever(dados: string): void;
  redimensionar(colunas: number, linhas: number): void;
  /** Sinal para o GRUPO do PTY (TUI + netos). */
  sinalizar(sinal: NodeJS.Signals): void;
}

export interface OpcoesPty {
  comando: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  colunas?: number;
  linhas?: number;
}

export type FabricaPty = (opcoes: OpcoesPty) => ProcessoPty;

export function limitarDimensao(valor: number, maximo: number, padrao: number): number {
  if (!Number.isFinite(valor)) return padrao;
  return Math.min(maximo, Math.max(1, Math.floor(valor)));
}

const NOMES_SINAL: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
};

/** Implementação real com `node-pty`. Os args passam por `validarArgsSemBypass`. */
export const abrirPty: FabricaPty = (opcoes) => {
  validarArgsSemBypass(opcoes.args);
  const pty = nodePty.spawn(opcoes.comando, [...opcoes.args], {
    name: TERM_PTY,
    cols: limitarDimensao(opcoes.colunas ?? COLUNAS_PADRAO, MAX_COLUNAS, COLUNAS_PADRAO),
    rows: limitarDimensao(opcoes.linhas ?? LINHAS_PADRAO, MAX_LINHAS, LINHAS_PADRAO),
    cwd: opcoes.cwd,
    env: { ...opcoes.env },
  });
  let saiu = false;
  pty.onExit(() => {
    saiu = true;
  });
  return {
    pid: pty.pid,
    aoDados(fn) {
      const d = pty.onData(fn);
      return () => d.dispose();
    },
    aoSair(fn) {
      const d = pty.onExit(({ exitCode, signal }) =>
        fn({
          codigo: exitCode,
          sinal: signal ? (NOMES_SINAL[signal] ?? String(signal)) : null,
        }),
      );
      return () => d.dispose();
    },
    escrever(dados) {
      if (!saiu) pty.write(dados);
    },
    redimensionar(colunas, linhas) {
      if (saiu) return;
      pty.resize(
        limitarDimensao(colunas, MAX_COLUNAS, COLUNAS_PADRAO),
        limitarDimensao(linhas, MAX_LINHAS, LINHAS_PADRAO),
      );
    },
    sinalizar(sinal) {
      if (saiu) return;
      try {
        sinalizarGrupoReal(pty.pid, sinal);
      } catch {
        try {
          pty.kill(sinal);
        } catch {
          // já saiu
        }
      }
    },
  };
};
