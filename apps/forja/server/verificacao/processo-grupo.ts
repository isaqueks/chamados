import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Processo do app em GRUPO PRÓPRIO, com escada de sinais (specs/forja/01 §10,
 * 03 §5.1 e §5.4 passo 6).
 *
 * POR QUE grupo próprio (`detached: true` → `pgid = pid`): os comandos do
 * projeto (`npm test`, `npm run dev`) disparam netos — vitest workers, o Next,
 * o esbuild. Matar só o `sh` deixaria órfãos segurando porta e CPU. Toda
 * derrubada vai ao grupo inteiro: SIGINT → espera → SIGTERM → espera → SIGKILL.
 * Mesmo quando o líder sai sozinho, o grupo é conferido: sobrou alguém, a escada
 * roda também (um `npm run dev` que sai deixando o servidor vivo é o caso típico).
 *
 * stdout e stderr vão DIRETO para o arquivo de log (fd herdado), sem passar
 * pela memória do app: um build verboso não pressiona o processo da Forja.
 *
 * Este módulo é local à verificação porque o supervisor geral
 * (`server/processos`) é de outro pacote da R2; a R3 pode unificá-los atrás da
 * mesma interface.
 */

export interface OpcoesProcessoGrupo {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** stdout+stderr anexados aqui (criado se não existir). */
  arquivoLog: string;
  /** 0/undefined = sem timeout (ex.: `app_subir`, derrubado pelo chamador). */
  timeoutMs?: number;
  /** Espera entre degraus da escada (padrão 10 s, 03 §5.4). */
  escadaMs?: number;
}

export interface FimProcesso {
  exitCode: number | null;
  sinal: NodeJS.Signals | null;
  /** O timeout do comando disparou a escada. */
  timeout: boolean;
  /** Falha ao iniciar (cwd inexistente, executável ausente). */
  erroSpawn: string | null;
  duracaoMs: number;
  /** Sobraram processos do grupo depois do líder (e foram derrubados). */
  sobrasDerrubadas: boolean;
  /** Ainda havia processo vivo no grupo depois do SIGKILL. */
  orfaos: boolean;
}

export interface ProcessoEmGrupo {
  pid: number | null;
  /** Resolve quando o líder sai E o grupo foi conferido/limpo. */
  fim: Promise<FimProcesso>;
  /** O líder já saiu? (para detectar `app_subir` que morreu cedo). */
  readonly encerrado: boolean;
  /** Escada no grupo e espera o fim. Idempotente. */
  derrubar(): Promise<FimProcesso>;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Algum processo do grupo ainda existe? */
export function grupoVivo(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sinalizar(pgid: number, sinal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sinal);
  } catch {
    // Grupo já vazio.
  }
}

async function esperarGrupoSumir(pgid: number, ms: number): Promise<boolean> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (!grupoVivo(pgid)) return true;
    await dormir(Math.min(50, ms));
  }
  return !grupoVivo(pgid);
}

/** SIGINT → `escadaMs` → SIGTERM → `escadaMs` → SIGKILL. `true` = grupo vazio ao fim. */
export async function escadaDeSinais(pgid: number, escadaMs: number): Promise<boolean> {
  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    if (!grupoVivo(pgid)) return true;
    sinalizar(pgid, sinal);
    if (await esperarGrupoSumir(pgid, escadaMs)) return true;
  }
  sinalizar(pgid, 'SIGKILL');
  return esperarGrupoSumir(pgid, Math.max(1000, escadaMs));
}

export function iniciarEmGrupo(o: OpcoesProcessoGrupo): ProcessoEmGrupo {
  const inicio = Date.now();
  const escadaMs = o.escadaMs ?? 10_000;
  mkdirSync(dirname(o.arquivoLog), { recursive: true });
  const fd = openSync(o.arquivoLog, 'a', 0o600);
  const [cmd, ...args] = o.argv;
  let encerrado = false;
  let timeout = false;
  let derrubando: Promise<boolean> | null = null;
  let resolverFim!: (f: FimProcesso) => void;
  const fim = new Promise<FimProcesso>((r) => (resolverFim = r));

  const filho = spawn(cmd as string, args, {
    cwd: o.cwd,
    env: o.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const pgid = filho.pid ?? null;

  const derrubarGrupo = (): Promise<boolean> => {
    if (pgid === null) return Promise.resolve(true);
    derrubando ??= escadaDeSinais(pgid, escadaMs);
    return derrubando;
  };

  const timer =
    o.timeoutMs && o.timeoutMs > 0
      ? setTimeout(() => {
          timeout = true;
          void derrubarGrupo();
        }, o.timeoutMs)
      : null;

  filho.on('error', (e) => {
    if (timer) clearTimeout(timer);
    encerrado = true;
    resolverFim({
      exitCode: null,
      sinal: null,
      timeout: false,
      erroSpawn: e.message,
      duracaoMs: Date.now() - inicio,
      sobrasDerrubadas: false,
      orfaos: false,
    });
  });

  filho.on('exit', (exitCode, sinal) => {
    if (timer) clearTimeout(timer);
    encerrado = true;
    void (async () => {
      const sobras = pgid !== null && grupoVivo(pgid);
      const limpo = sobras || derrubando ? await derrubarGrupo() : true;
      resolverFim({
        exitCode,
        sinal,
        timeout,
        erroSpawn: null,
        duracaoMs: Date.now() - inicio,
        sobrasDerrubadas: sobras,
        orfaos: !limpo,
      });
    })();
  });

  return {
    pid: pgid,
    fim,
    get encerrado() {
      return encerrado;
    },
    async derrubar() {
      if (!encerrado) void derrubarGrupo();
      return fim;
    },
  };
}
