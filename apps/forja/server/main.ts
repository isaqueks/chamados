import 'reflect-metadata';
import { mkdirSync, readFileSync } from 'node:fs';
import { iniciarForja } from './boot/forja';
import { carregarConfig, ErroConfig, PORTA_VITE_DEV } from './config';
import { ErroMigracao } from './db/erros';
import { gerarTokenBoot } from './http/seguranca-local';
import { recusaPorRoot } from './processos/usuario';

/**
 * Processo da Forja (specs/forja/01 §4.1): lê a config, sobe tudo por
 * `iniciarForja` (boot/forja.ts — SQLite/migrations → segredos → compat da CLI
 * → reconciliação → orquestrador → conexões/polling → Fastify) e imprime a URL
 * com o token de boot.
 *
 * O token aparece SÓ no stdout deste terminal (é como o usuário abre a UI);
 * nunca em arquivo nem em log (05 §8.2).
 *
 * SIGINT/SIGTERM: desligamento limpo (01 §3.2) — HTTP fechado, escada nos
 * agentes, PTYs encerrados, nenhum filho vivo, SQLite fechado. Um segundo
 * sinal durante o desligamento sai na hora.
 */

function log(msg: string): void {
  console.log(`[forja] ${msg}`);
}

function versaoDoPacote(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const recusa = recusaPorRoot(process.getuid?.());
  if (recusa) {
    console.error(`[forja] ${recusa}`);
    process.exit(1);
  }
  const config = carregarConfig(process.env, versaoDoPacote());
  mkdirSync(config.dirDados, { recursive: true, mode: 0o700 });
  log(`modo ${config.modo} · dados em ${config.dirDados}`);

  const token = gerarTokenBoot();
  const forja = await iniciarForja(config, { env: process.env, token, log });

  if (config.modo === 'dev') {
    // No dev a SPA vem do Vite; `/api/sessao?t=` é proxiado para cá, grava o
    // cookie (cookies não distinguem porta) e redireciona para a raiz do Vite.
    log(`abra: http://127.0.0.1:${PORTA_VITE_DEV}/api/sessao?t=${token}`);
  } else {
    log(`abra: http://127.0.0.1:${forja.porta}/?t=${token}`);
  }

  let encerrando = false;
  const encerrar = (sinal: string): void => {
    if (encerrando) {
      log(`${sinal} de novo: saindo sem esperar`);
      process.exit(130);
    }
    encerrando = true;
    log(`${sinal} recebido, encerrando…`);
    forja
      .encerrar()
      .then(() => {
        log('encerrado');
        process.exit(0);
      })
      .catch((erro: unknown) => {
        console.error('[forja] falha no desligamento:', erro);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

main().catch((erro: unknown) => {
  if (erro instanceof ErroConfig) {
    console.error(`[forja] configuração inválida: ${erro.message}`);
  } else if (erro instanceof ErroMigracao) {
    console.error(
      `[forja] migration falhou: ${erro.message}` +
        (erro.caminhoBackup ? ` — backup do banco em ${erro.caminhoBackup}` : ''),
    );
  } else if ((erro as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    console.error(
      '[forja] a porta já está em uso: outra Forja rodando? (FORJA_PORTA muda a porta)',
    );
  } else {
    console.error('[forja] falha no boot:', erro);
  }
  process.exit(1);
});
