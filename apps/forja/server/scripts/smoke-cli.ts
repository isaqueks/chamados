/**
 * Smoke de compatibilidade da CLI fora do app (specs/forja/01 §7):
 * `npm run smoke:cli -w @chamados/forja`.
 *
 * Sempre (custo zero): `claude --version` × versão fixada, `claude auth status`,
 * `git --version` ≥ 2.38, `node-pty` e `better-sqlite3` carregam, diretório
 * temporário gravável — as mesmas funções que o boot e o Diagnóstico usam
 * (`claude/compat.ts`, `boot/compat-cli.ts`).
 *
 * Com `FORJA_SMOKE_CLAUDE=1`: também o smoke de PERFIS — um `claude -p` por
 * perfil de 01 §6.2 com as mesmas flags, mas `--model haiku --max-turns 1
 * --max-budget-usd 0.05` e schema trivial (≈ US$ 0,04 equivalente no total,
 * gasta cota da assinatura). É o mesmo smoke que "Aceitar versão X" dispara.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  criarExecPadrao,
  VERSAO_CLI_FIXADA,
  verificarAuthCli,
  verificarGit,
  verificarVersaoCli,
} from '../claude/compat';
import { rodarSmokePerfis } from '../boot/compat-cli';

function linha(ok: boolean | null, titulo: string, detalhe: string): void {
  const marca = ok === null ? '  ·' : ok ? '  ✓' : '  ✗';
  console.log(`${marca} ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function main(): Promise<number> {
  const exec = criarExecPadrao(process.env);
  let falhas = 0;
  const conta = (ok: boolean) => {
    if (!ok) falhas += 1;
    return ok;
  };

  console.log('[smoke:cli] checagens de boot (custo zero)');
  const versao = await verificarVersaoCli(exec);
  linha(
    conta(versao.ok),
    'claude --version',
    versao.encontrada
      ? `${versao.encontrada} (fixada ${VERSAO_CLI_FIXADA})`
      : (versao.erro ?? 'não encontrado'),
  );
  const auth = await verificarAuthCli(exec);
  linha(
    conta(auth.ok),
    'claude auth status',
    auth.ok ? `${auth.authMethod} (${auth.subscriptionType ?? '?'})` : (auth.erro ?? 'sem login'),
  );
  const git = await verificarGit(exec);
  linha(conta(git.ok), 'git ≥ 2.38', git.encontrada ?? git.erro ?? '?');

  try {
    await import('better-sqlite3');
    linha(true, 'better-sqlite3 carrega', '');
  } catch (e) {
    linha(conta(false), 'better-sqlite3 carrega', (e as Error).message);
  }
  try {
    await import('node-pty');
    linha(true, 'node-pty carrega', '');
  } catch (e) {
    // O Terminal fica indisponível, mas o pipeline roda: não reprova o smoke.
    linha(false, 'node-pty carrega (só o Terminal depende dele)', (e as Error).message);
  }
  const dir = mkdtempSync(join(tmpdir(), 'forja-smoke-cli-'));
  try {
    writeFileSync(join(dir, 'gravavel'), 'ok', { mode: 0o600 });
    linha(true, 'diretório temporário gravável', '');

    if (process.env.FORJA_SMOKE_CLAUDE !== '1') {
      linha(null, 'smoke de perfis', 'pulado (FORJA_SMOKE_CLAUDE=1 roda; ≈ US$ 0,04, haiku)');
    } else if (!versao.encontrada) {
      linha(conta(false), 'smoke de perfis', 'sem CLI para rodar');
    } else {
      console.log('[smoke:cli] smoke de perfis (haiku, --max-turns 1, US$ 0,05 por perfil)');
      const r = await rodarSmokePerfis({
        dirDados: dir,
        versao: versao.encontrada,
        envOrigem: process.env,
      });
      for (const p of r.perfis) {
        linha(
          conta(p.ok),
          `perfil ${p.perfil}`,
          p.ok ? `exit ${p.exitCode}` : p.falhas.join('; ').slice(0, 300),
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nRESULTADO: ${falhas === 0 ? 'PASSOU' : `FALHOU (${falhas})`}`);
  return falhas === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[smoke:cli] erro:', e);
    process.exit(1);
  },
);
