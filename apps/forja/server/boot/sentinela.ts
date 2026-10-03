import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirGitComum, git } from '../git';

/**
 * Hashes da sentinela de integridade (specs/forja/05 §4.9), medidos antes e
 * depois de cada etapa com Bash e de cada verificação (o orquestrador compara;
 * ver `dominio/sentinela.ts`). Sem sandbox, a escrita fora da worktree não é
 * impedida: isto DETECTA persistência (rc files, chaves SSH, autostart, cron,
 * config/hooks do git) e mexida na cópia do usuário.
 *
 * Cada item vira uma chave estável (`~/.bashrc`, `<repo>/.git/config`…) com o
 * sha256 do conteúdo, `ausente` ou `ilegivel`. Diretórios: hash da árvore
 * (caminho relativo + tipo + conteúdo), com teto de entradas.
 *
 * Cópia do usuário: `git status --porcelain` + a ref do HEAD (a branch em
 * checkout). O SHA do HEAD fica de fora de propósito: o próprio app avança a
 * cópia limpa por fast-forward ao integrar outra execução (03 §8.2), o que
 * seria divergência autoinfligida em toda etapa concorrente.
 */

const ARQUIVOS_HOME = [
  '.bashrc',
  '.zshrc',
  '.profile',
  '.gitconfig',
  '.ssh/authorized_keys',
  '.ssh/config',
  '.claude/settings.json',
];
const DIRS_HOME = ['.claude/agents', '.config/autostart'];
const MAX_ENTRADAS_DIR = 2000;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function hashArquivo(caminho: string): Promise<string> {
  try {
    return sha(await readFile(caminho));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ausente' : 'ilegivel';
  }
}

async function hashDiretorio(raiz: string): Promise<string> {
  const h = createHash('sha256');
  let total = 0;
  const visitar = async (dir: string, rel: string): Promise<boolean> => {
    let nomes: string[];
    try {
      nomes = (await readdir(dir)).sort();
    } catch (e) {
      if (rel === '') {
        h.update((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ausente' : 'ilegivel');
      }
      return true;
    }
    for (const nome of nomes) {
      if (++total > MAX_ENTRADAS_DIR) {
        h.update('…truncado');
        return false;
      }
      const abs = join(dir, nome);
      const r = rel ? `${rel}/${nome}` : nome;
      const st = await lstat(abs).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        h.update(`L ${r} ${await readlink(abs).catch(() => '?')}\n`);
      } else if (st.isDirectory()) {
        h.update(`D ${r}\n`);
        if (!(await visitar(abs, r))) return false;
      } else {
        h.update(`F ${r} ${st.mode & 0o777} ${await hashArquivo(abs)}\n`);
      }
    }
    return true;
  };
  await visitar(raiz, '');
  return h.digest('hex');
}

export type ExecSentinela = (
  cmd: string,
  args: readonly string[],
) => Promise<{ codigo: number | null; stdout: string }>;

const execPadrao: ExecSentinela = (cmd, args) =>
  new Promise((ok) => {
    execFile(cmd, [...args], { timeout: 5000, encoding: 'utf8' }, (erro, stdout) => {
      const codigo =
        erro && typeof (erro as NodeJS.ErrnoException).code === 'number'
          ? ((erro as unknown as { code: number }).code ?? 1)
          : erro
            ? null
            : 0;
      ok({ codigo, stdout: stdout ?? '' });
    });
  });

export interface OpcoesSentinela {
  home?: string;
  /** `crontab -l` (injetável no teste). */
  exec?: ExecSentinela;
}

/** Cria a função de medição injetada no orquestrador (`deps.sentinela`). */
export function criarSentinela(
  o: OpcoesSentinela = {},
): (repoDirUsuario: string) => Promise<Record<string, string>> {
  const home = o.home ?? homedir();
  const exec = o.exec ?? execPadrao;
  return async (repoDir) => {
    const m: Record<string, string> = {};
    for (const a of ARQUIVOS_HOME) m[`~/${a}`] = await hashArquivo(join(home, a));
    for (const d of DIRS_HOME) m[`~/${d}/`] = await hashDiretorio(join(home, d));
    const cron = await exec('crontab', ['-l']).catch(() => ({ codigo: null, stdout: '' }));
    m['crontab -l'] = cron.codigo === null ? 'indisponivel' : sha(`${cron.codigo}\n${cron.stdout}`);

    const gitDir = await dirGitComum(repoDir).catch(() => join(repoDir, '.git'));
    m['<repo>/.git/config'] = await hashArquivo(join(gitDir, 'config'));
    m['<repo>/.git/hooks/'] = await hashDiretorio(join(gitDir, 'hooks'));
    m['<repo>/.git/info/attributes'] = await hashArquivo(join(gitDir, 'info', 'attributes'));
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: repoDir,
      aceitar: [0, 128],
    }).catch(() => null);
    const ref = await git(['symbolic-ref', '-q', 'HEAD'], {
      cwd: repoDir,
      aceitar: [0, 1, 128],
    }).catch(() => null);
    m['<repo> cópia do usuário (status + HEAD)'] = sha(
      `${ref?.stdout.trim() ?? '?'}\n${status?.codigo === 0 ? status.stdout : 'ilegivel'}`,
    );
    return m;
  };
}
