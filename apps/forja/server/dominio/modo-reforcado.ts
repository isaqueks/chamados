import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigResolvida } from '../../comum/config-projeto';

/**
 * Modo reforçado por projeto (specs/forja/05 §5): sandbox da CLI no
 * `--settings` do condutor/implementadores (§5.1). O `bwrap` da verificação
 * pelo app (§5.2) saiu com FJ-032 — a Forja não executa mais comandos do
 * projeto; `verificacao_bwrap` é aceito e ignorado.
 *
 * POR QUE aqui e não na UI: ligado no projeto, ele TEM de valer — "não há
 * queda silenciosa para o modo padrão". O sandbox vai com `failIfUnavailable`
 * (a CLI recusa rodar o Bash se não subir).
 */

function expandirHome(caminho: string, home: string): string {
  return caminho === '~' ? home : caminho.startsWith('~/') ? join(home, caminho.slice(2)) : caminho;
}

/** Bloco `sandbox` do `--settings` (05 §5.1). `null` com o modo desligado. */
export function sandboxDoProjeto(
  config: Pick<ConfigResolvida, 'modo_reforcado'>,
  dirs: { worktree: string; gitComum: string | null },
  home: string = homedir(),
): Record<string, unknown> | null {
  const m = config.modo_reforcado;
  if (!m.ligado) return null;
  const allowRead = [
    dirs.worktree,
    ...(dirs.gitComum ? [dirs.gitComum] : []),
    ...m.sandbox.allow_read_extra.map((c) => expandirHome(c, home)),
  ];
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: ['~/'], allowRead: [...new Set(allowRead)] },
    credentials: {
      files: ['~/.ssh', '~/.config/gh', '~/.claude/.credentials.json'],
      envVars: ['GH_TOKEN', 'GITHUB_TOKEN'],
    },
    network: { allowedDomains: [...m.rede_agente] },
  };
}
