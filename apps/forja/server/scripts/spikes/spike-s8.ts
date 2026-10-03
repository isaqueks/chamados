import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErroSessaoOcupada, LockSessoes } from '../../claude/lock-sessoes';
import { montarComandoAssumir } from '../../claude/perfis';
import { RunnerCli, type ProcessoFilho } from '../../claude/runner';
import { abrirPty, TERM_PTY } from '../../terminal/pty';
import {
  clonarDescartavel,
  criarAreaTemporaria,
  dirSaida,
  esperar,
  executarSpike,
  textoDaTela,
  gravarRodada,
  MODELO_MECANICA,
  novoUuid,
  resumirStream,
  rodarClaude,
  ultimoResult,
  vereditoDe,
} from './apoio';
import { prepararEtapa, schemaObjeto } from './etapa-spike';
import { purgarEstado } from './limpeza';

/**
 * S8 — PTY + Assumir/Devolver (specs/forja/08 §2; 01 §11; 03 §10; F-13).
 *
 * 1. Uma sessão nasce em `-p` com o perfil T1 (haiku), com uma palavra-código.
 * 2. `abrirPty` (R2) abre `montarComandoAssumir` (R2): `claude --resume <id>
 *    --settings <da etapa> --strict-mcp-config --model …`, SEM bypass.
 * 3. Esperamos a TUI mostrar a conversa do pipeline (a palavra-código na tela);
 *    um diálogo de confiança na pasta é registrado e aceito.
 * 4. `/exit` + Enter: a TUI tem de sair sozinha (o Devolver depende disso).
 * 5. O `LockSessoes` recusa um segundo processo (runner) na mesma sessão.
 *
 * "Ao Devolver, o app commita e retoma verificação + revisão" é do
 * orquestrador (ainda não existe): PENDENTE.
 */

const PALAVRA = 'JABUTICABA-8';

function pgidDe(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return null;
  }
}

export async function executar(): Promise<number> {
  return executarSpike('s8', 'PTY + Assumir/Devolver (F-13)', async (r) => {
    const area = await criarAreaTemporaria('s8');
    const clone = await clonarDescartavel(area);
    try {
      const sessao = novoUuid();
      const etapa = await prepararEtapa(
        {
          dirDados: join(area.raiz, 'dados'),
          execucaoId: novoUuid(),
          worktree: clone.dir,
          repoUsuario: join(area.raiz, 'checkout-usuario'),
        },
        {
          perfil: 'condutor_t1',
          n: 1,
          sessao: { modo: 'novo', sessionId: sessao },
          jsonSchema: schemaObjeto({ ok: { type: 'boolean' } }),
          maxTurns: 3,
          orcamentoUsd: 0.2,
        },
      );
      const rod = await rodarClaude({
        rotulo: 'sessao-p',
        args: etapa.comando.args,
        cwd: clone.dir,
        env: etapa.comando.env,
        prompt: `Palavra-código desta sessão: ${PALAVRA}. Não use ferramentas: só chame a saída estruturada com {"ok": true}.`,
        timeoutMs: 180_000,
      });
      await gravarRodada('s8', rod);
      const res = ultimoResult(resumirStream(rod.mensagens));
      if (res?.subtype !== 'success')
        throw new Error(`a sessão -p não concluiu: ${String(res?.subtype)}`);

      const cmd = montarComandoAssumir({
        sessionId: sessao,
        settings: etapa.arquivos.settings,
        modelo: MODELO_MECANICA,
        cwd: clone.dir,
        env: { envOrigem: process.env },
      });
      const locks = new LockSessoes();
      locks.adquirir(sessao, 'pty:spike');
      const pty = abrirPty({
        comando: cmd.executavel,
        args: cmd.args,
        cwd: cmd.cwd,
        env: { ...cmd.env, TERM: TERM_PTY },
        colunas: 140,
        linhas: 40,
      });
      let bruto = '';
      pty.aoDados((d) => (bruto += d));
      let fim: { codigo: number | null; sinal: string | null } | null = null;
      pty.aoSair((f) => (fim = f));
      const pgid = pgidDe(pty.pid);

      // Segundo processo na mesma sessão: o runner tem de recusar ANTES de spawnar.
      let spawnou = false;
      const runner = new RunnerCli({
        locks,
        spawn: () => {
          spawnou = true;
          return {
            pid: undefined,
            stdin: null,
            stdout: null,
            stderr: null,
            on: () => undefined,
          } as ProcessoFilho;
        },
      });
      let recusa: string | null = null;
      try {
        runner.iniciar(etapa.comando, {
          prompt: 'x',
          execucaoId: null,
          etapaId: null,
          timeoutMs: 1000,
        });
      } catch (e) {
        recusa = e instanceof ErroSessaoOcupada ? e.message : `outro erro: ${String(e)}`;
      }

      const ate = async (cond: () => boolean, ms: number) => {
        const limite = Date.now() + ms;
        while (!cond() && Date.now() < limite) await esperar(200);
        return cond();
      };
      const tela = () => textoDaTela(bruto);
      let confianca = false;
      // O diálogo só aceita tecla depois de montado: espera o rodapé "Enter to confirm".
      const dialogo = () => /Enter\s*to\s*confirm/i.test(tela()) && /trust/i.test(tela());
      const viuAlgo = await ate(() => tela().includes(PALAVRA) || dialogo(), 45_000);
      if (viuAlgo && !tela().includes(PALAVRA) && dialogo()) {
        await esperar(1000);
        // O diálogo abre com "No, exit" selecionado: seta para baixo ("Yes, I trust") + Enter.
        confianca = true;
        pty.escrever('\x1b[B');
        await esperar(400);
        pty.escrever('\r');
      }
      const viuPalavra = await ate(() => tela().includes(PALAVRA), 30_000);
      await esperar(1500);
      const tamanhoAntesExit = bruto.length;
      pty.escrever('/exit');
      await esperar(800);
      pty.escrever('\r');
      const saiu = await ate(() => fim !== null, 20_000);
      if (!saiu) {
        pty.sinalizar('SIGTERM');
        await ate(() => fim !== null, 5_000);
      }
      const fimFinal = fim as { codigo: number | null; sinal: string | null } | null;
      locks.liberar(sessao, 'pty:spike');
      const dir = join(dirSaida(), 's8');
      await writeFile(join(dir, 'pty-bruto.txt'), bruto);
      await writeFile(join(dir, 'pty-tela.txt'), tela());
      r.anexar('pty', { pid: pty.pid, pgid, args: cmd.args, confianca, saiu, fim: fimFinal });
      r.anexar('tela_pos_exit', textoDaTela(bruto.slice(tamanhoAntesExit)).slice(-800));

      r.criterio(
        'S8.a',
        'a TUI (`claude --resume <id de -p>` no PTY, sem bypass) abre a conversa do pipeline',
        vereditoDe(viuPalavra),
        `${viuPalavra ? `a palavra-código ${PALAVRA} apareceu na tela` : 'a conversa NÃO apareceu na tela'}; diálogo de confiança na pasta: ${confianca ? 'SIM, com "No, exit" pré-selecionado (aceito com ↓ + Enter)' : 'não'}; pid=${pty.pid} pgid=${String(pgid)} (${pgid === pty.pid ? 'líder do próprio grupo' : 'grupo de outro'})`,
      );
      r.criterio(
        'S8.b',
        '`/exit` + Enter encerra a TUI sozinha (base do Devolver)',
        vereditoDe(saiu),
        saiu
          ? `saiu com código ${String(fimFinal?.codigo)} sinal ${String(fimFinal?.sinal)}`
          : 'não saiu em 20 s (SIGTERM aplicado)',
      );
      r.criterio(
        'S8.c',
        'segundo processo na mesma sessão é recusado pelo lock (antes do spawn)',
        vereditoDe(recusa !== null && !recusa.startsWith('outro erro') && !spawnou),
        recusa ?? 'o runner NÃO recusou',
      );
      r.criterio(
        'S8.d',
        'ao Devolver, o app commita e retoma verificação + revisão',
        'PENDENTE',
        'depende do orquestrador (R3/M5); o spike prova só o PTY, o resume na TUI, o /exit e o lock',
      );
    } finally {
      await purgarEstado(clone.dir);
      await area.limpar();
    }
  });
}
