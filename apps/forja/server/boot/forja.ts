import { request } from 'node:http';
import type { FetchImpl } from '@chamados/cliente-api';
import type { FastifyInstance } from 'fastify';
import type { EventoForja } from '../../comum/protocolo-eventos';
import type { PollingChamados } from '../chamados/polling';
import {
  criarExecPadrao,
  verificarAuthCli,
  VERSAO_CLI_FIXADA,
  type FuncaoExec,
} from '../claude/compat';
import type { Env } from '../claude/perfis';
import { RunnerCli, type Runner } from '../claude/runner';
import type { ConfigForja } from '../config';
import type { BancoForja } from '../db/banco';
import { abrirBanco } from '../db/data-source';
import { LIMITE_REPLAY, PersistenciaEventosSqlite } from '../db/persistencia-eventos';
import { Orquestrador } from '../dominio/orquestrador';
import { ServicosForja } from '../dominio/servicos';
import { BarramentoEventos } from '../eventos/barramento';
import { Redator } from '../eventos/normalizador';
import { criarServidor } from '../http/servidor';
import { LocksSessaoMemoria } from '../processos/lock-sessao';
import { encerrarGrupo, escadaPorNome } from '../processos/supervisor';
import { abrirSegredos } from '../segredos/keyring';
import type { GerenteSessoesTerminal } from '../terminal/sessoes';
import { caminhoForjaPrint, localizarServidorMcp } from '../claude/mcp-chamados';
import { ArmazemConfiguracoes } from '../configuracoes/armazem';
import { criarSentinela } from './sentinela';
import { CompatCli, DiagnosticoForja, rodarSmokePerfis } from './compat-cli';
import { GerenteConexoes } from './conexoes';
import { LockSessoesCompartilhado } from './locks';
import { encerrarDescendentes, varrerCwd } from './processos';

/**
 * Boot completo da Forja (specs/forja/01 §4.1, §3.2; 02 §1; 03 §9.5):
 *
 *   config → SQLite (VACUUM INTO + migrations) → segredos → compat da CLI →
 *   terminal (se `node-pty` carregar) → orquestrador (reconciliação com as
 *   ações APLICADAS: escada nos grupos, varredura de cwd, etapas
 *   `interrompido`, retomadas) → conexões + polling do Chamados → retenção →
 *   Diagnóstico → Fastify em 127.0.0.1.
 *
 * Desligamento (01 §3.2): fecha o HTTP (nenhum comando novo), para o polling,
 * para o orquestrador (escada nos agentes em curso), encerra os PTYs, mata
 * qualquer descendente que ainda esteja vivo e fecha o SQLite.
 *
 * Tudo que toca o mundo (exec da CLI, fetch, runner) é injetável: o teste de
 * boot sobe a Forja inteira sem `claude` real e sem rede.
 */

export interface OpcoesBoot {
  env: Env;
  token: string;
  /** Exec das checagens de compat/Diagnóstico (padrão: binário real, env allowlist). */
  exec?: FuncaoExec;
  fetch?: FetchImpl;
  runner?: Runner;
  /** `false` = não tenta carregar `node-pty` (teste). */
  terminal?: boolean;
  /** Intervalo do relógio do orquestrador (0 = sem timer). */
  intervaloTickMs?: number;
  /** Polling do Chamados (07 §8.1). `false` = desligado (teste). */
  polling?: boolean;
  /**
   * Sentinela de integridade (05 §4.9). Padrão: ligada, com os hashes reais.
   * `false` só em teste que não pode depender do `$HOME` da máquina.
   */
  sentinela?: false | ((repoDirUsuario: string) => Promise<Record<string, string>>);
  /**
   * MCP do Chamados para os agentes (FJ-030 §4). Padrão: `apps/mcp` localizado
   * no monorepo; `false` = sem MCP (teste).
   */
  mcp?: false;
  log?: (mensagem: string) => void;
}

export interface ForjaEmPe {
  app: FastifyInstance;
  banco: BancoForja;
  orq: Orquestrador;
  compat: CompatCli;
  diagnostico: DiagnosticoForja;
  conexoes: GerenteConexoes;
  terminal: GerenteSessoesTerminal | null;
  /** Porta efetiva depois do `listen`. */
  porta: number;
  encerrar(): Promise<void>;
}

/** Autoteste do servidor local (06 §4.10): Host e Origin forjados TÊM de dar 403. */
export function autotesteServidor(porta: number): Promise<{ ok: boolean; detalhe: string }> {
  const pedir = (headers: Record<string, string>, metodo: string): Promise<number> =>
    new Promise((ok) => {
      const req = request(
        { host: '127.0.0.1', port: porta, path: '/api/saude', method: metodo, headers },
        (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        },
      );
      req.on('error', () => ok(0));
      req.setTimeout(3000, () => req.destroy());
      req.end();
    });
  return Promise.all([
    pedir({ host: `forja.exemplo.invalid:${porta}` }, 'GET'),
    pedir({ host: `127.0.0.1:${porta}`, origin: 'http://forja.exemplo.invalid' }, 'POST'),
  ]).then(([host, origem]) => {
    const ok = host === 403 && origem === 403;
    return {
      ok,
      detalhe: ok
        ? 'Host e Origin forjados recusados (403)'
        : `Host forjado → ${host}, Origin forjado → ${origem} (esperado 403/403)`,
    };
  });
}

async function carregarTerminal(
  env: Env,
  locks: LocksSessaoMemoria,
  banco: BancoForja,
  log: (m: string) => void,
): Promise<{ terminal: GerenteSessoesTerminal | null; falha: string | null }> {
  try {
    // Import dinâmico: `node-pty` é nativo; se o binário não carregar a Forja
    // sobe sem Terminal e o Diagnóstico mostra o motivo (06 §4.10).
    const { GerenteSessoesTerminal } = await import('../terminal/sessoes');
    const terminal = new GerenteSessoesTerminal({
      locks,
      // `FORJA_PTY_COMANDO` só para smoke/teste: troca o `claude` da TUI por outro binário.
      comandoClaude: env.FORJA_PTY_COMANDO?.trim() || 'claude',
      ambienteOrigem: env,
      aoEvento: (ev) => {
        if (ev.tipo !== 'fechada') return;
        // Aba removida: a linha de `sessao_terminal` fecha (a reconciliação do
        // boot fecharia de qualquer jeito; aqui o Histórico fica certo já).
        void banco
          .transacao(async (r) => {
            const s = await r.terminais.obter(ev.sessao.id);
            if (s && !s.encerrada_em) await r.terminais.encerrar(ev.sessao.id);
          })
          .catch((e: unknown) => log(`sessao_terminal ${ev.sessao.id}: ${String(e)}`));
      },
    });
    return { terminal, falha: null };
  } catch (e) {
    return { terminal: null, falha: e instanceof Error ? e.message : String(e) };
  }
}

/** Uma rejeição sem `catch` nunca derruba o servidor com agentes em curso (só log). */
let rejeicoesRegistradas = false;
function registrarRejeicoesSemTratamento(log: (m: string) => void): void {
  if (rejeicoesRegistradas) return;
  rejeicoesRegistradas = true;
  process.on('unhandledRejection', (motivo) => {
    log(
      `promessa rejeitada sem tratamento: ${motivo instanceof Error ? motivo.stack : String(motivo)}`,
    );
  });
}

export async function iniciarForja(config: ConfigForja, op: OpcoesBoot): Promise<ForjaEmPe> {
  const log = op.log ?? ((m: string) => console.log(`[forja] ${m}`));
  registrarRejeicoesSemTratamento(log);
  const iniciadoEm = new Date().toISOString();

  // 1. SQLite: backup + migrations (lança ErroMigracao com o caminho do backup).
  const banco = await abrirBanco(config);
  if (banco.migracao.aplicadas.length > 0) {
    log(`migrations aplicadas: ${banco.migracao.aplicadas.join(', ')}`);
  }
  const fechadores: (() => Promise<void>)[] = [() => banco.fechar()];
  const desfazer = async () => {
    for (const f of fechadores.reverse()) await f().catch(() => {});
  };

  try {
    // 2. Segredos (keyring do SO ou arquivo 0600).
    const segredos = await abrirSegredos({
      dirDados: config.dirDados,
      semKeyring: op.env.FORJA_SEM_KEYRING === '1',
    });
    const seg = segredos.diagnostico();
    if (seg.motivo_fallback) log(`segredos em arquivo 0600 (${seg.motivo_fallback})`);

    // 3. Compat da CLI (custo zero).
    const exec = op.exec ?? criarExecPadrao(op.env);
    const compat = new CompatCli({
      exec,
      dirDados: config.dirDados,
      rodarSmoke: async (versao) =>
        rodarSmokePerfis({ dirDados: config.dirDados, versao, envOrigem: op.env }),
    });
    await compat.checar();
    log(
      `claude ${compat.versao.encontrada ?? 'não encontrado'} (fixada ${compat.fixada}) · ` +
        `login ${compat.auth.ok ? 'ok' : 'ausente'} · git ${compat.git.encontrada ?? '?'} · ` +
        `pipeline ${compat.pipelineLiberado() ? 'liberado' : 'BLOQUEADO (veja o Diagnóstico)'}`,
    );

    // 4. Locks únicos por session_id (runner + PTY) e o Terminal.
    const locks = new LocksSessaoMemoria();
    const { terminal, falha: falhaPty } =
      op.terminal === false
        ? { terminal: null, falha: 'desligado nesta instância' }
        : await carregarTerminal(op.env, locks, banco, log);
    if (falhaPty) log(`Terminal indisponível: ${falhaPty}`);
    const runner =
      op.runner ??
      new RunnerCli({
        locks: new LockSessoesCompartilhado(locks),
        versaoFixada: () =>
          compat.versaoLiberada()
            ? (compat.versao.encontrada ?? VERSAO_CLI_FIXADA)
            : VERSAO_CLI_FIXADA,
        aoVersaoDivergente: () => void compat.checar().catch(() => {}),
        verificarAuth: async () => (await verificarAuthCli(exec)).ok,
        varrerCwd: (dir) => varrerCwd(dir, () => terminal?.sessoesProtegidas() ?? new Set()),
      });

    // 5. Eventos: o `seq` continua o do banco depois do reboot (02 §4.8). O
    // redator conhece os valores sensíveis (token de boot, API keys do
    // ambiente; os `.env` copiados entram pelo orquestrador), 05 §8.2.
    const redator = new Redator(
      [op.token, op.env.ANTHROPIC_API_KEY, op.env.CLAUDE_CODE_OAUTH_TOKEN].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    );
    const persistencia = new PersistenciaEventosSqlite(banco);
    const barramento = new BarramentoEventos({
      seqInicial: await persistencia.ultimoSeq(),
      redator,
    });

    // 6. Conexões (o polling liga quando cada uma entra no cache, depois do orquestrador).
    const pollings = new Map<string, PollingChamados>();
    let orqPronto: Orquestrador | null = null;
    const ligarPolling = (id: string) => {
      if (op.polling === false || !orqPronto || pollings.has(id)) return;
      const p = orqPronto.criarPolling(id);
      if (!p) return;
      pollings.set(id, p);
      p.iniciar();
    };
    const conexoes = new GerenteConexoes({
      banco,
      segredos,
      fetch: op.fetch,
      aoCarregar: ligarPolling,
      log,
    });

    // 7. Orquestrador: reconciliação do boot com as ações aplicadas (03 §9.5).
    // Configurações globais (FJ-030 §2): arquivo corrompido para o boot com o
    // caminho na mensagem — nunca vira padrão em silêncio.
    const configuracoes = new ArmazemConfiguracoes(config.dirDados);
    configuracoes.ler();
    const servidorMcp = op.mcp === false ? null : localizarServidorMcp(op.env);
    if (op.mcp !== false && !servidorMcp) {
      log('MCP do Chamados não encontrado (apps/mcp): os agentes rodam sem ele');
    }
    const orq = new Orquestrador({
      banco,
      barramento,
      runner,
      dirDados: config.dirDados,
      chamados: (id) => conexoes.fonte(id),
      configuracoes,
      servidorMcp,
      mcpChamados: (id) => conexoes.credencialAgentes(id),
      forjaPrint: caminhoForjaPrint(),
      terminal,
      envOrigem: op.env,
      cliCompativel: () => compat.pipelineLiberado(),
      versaoCli: compat.versao.encontrada,
      varrerCwd: (dir) => varrerCwd(dir, () => terminal?.sessoesProtegidas() ?? new Set()),
      encerrarGrupo: async (pgid, escada) => {
        await encerrarGrupo(pgid, escadaPorNome(escada));
      },
      intervaloTickMs: op.intervaloTickMs,
      redator,
      // 05 §4.9: hashes antes/depois de toda etapa com Bash e de toda verificação.
      sentinela: op.sentinela === false ? undefined : (op.sentinela ?? criarSentinela()),
      log,
    });
    orq.n.registrarSegredos(
      [op.token, op.env.ANTHROPIC_API_KEY, op.env.CLAUDE_CODE_OAUTH_TOKEN].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    );
    fechadores.push(() => orq.parar());
    const acoes = await orq.iniciar();
    orqPronto = orq;
    if (acoes.length > 0) {
      const porTipo = new Map<string, number>();
      for (const a of acoes) porTipo.set(a.tipo, (porTipo.get(a.tipo) ?? 0) + 1);
      log(`reconciliação do boot: ${[...porTipo].map(([t, n]) => `${t} ×${n}`).join(', ')}`);
    }
    await conexoes.carregarTodas();
    // Retenção (02 §9) e outbox pendente: o primeiro tick roda já no boot.
    await orq.tick();

    // 8. Diagnóstico de boot e fachada.
    const diagnostico = new DiagnosticoForja({
      compat,
      exec,
      dirDados: config.dirDados,
      env: op.env,
      falhaPty,
      conexoes: () => conexoes.resumo(),
      host: config.host,
      mcpChamados: async () => {
        if (!servidorMcp) {
          return {
            ok: false,
            detalhe:
              op.mcp === false
                ? 'desligado nesta instância'
                : 'apps/mcp não encontrado (defina FORJA_MCP_CHAMADOS): os agentes leem só a entrada/ gravada pelo app',
          };
        }
        const ids = conexoes.resumo().map((c) => c.id);
        for (const id of ids) {
          if (await conexoes.credencialAgentes(id).catch(() => null)) {
            return {
              ok: true,
              detalhe: `somente leitura, token da conexão; servidor ${servidorMcp.entrada}`,
            };
          }
        }
        return {
          ok: false,
          detalhe: ids.length
            ? 'sem sessão válida no Chamados: os agentes rodam sem o MCP até o login'
            : 'nenhuma conexão cadastrada',
        };
      },
    });
    const servicos = new ServicosForja({
      orq,
      versao: config.versao,
      modo: config.modo,
      iniciadoEm,
      conexoes,
      diagnostico,
      terminal,
    });

    // 9. HTTP.
    const app = await criarServidor({
      config,
      barramento,
      token: op.token,
      iniciadoEm,
      servicos,
      terminal,
      eventos: {
        desde: async (seq, filtro) => {
          const lista = await persistencia.desde(seq, {
            predicado: filtro,
            limite: LIMITE_REPLAY + 1,
          });
          return lista.length > LIMITE_REPLAY ? null : (lista as EventoForja[]);
        },
        execucaoExiste: async (id) => (await banco.ler((r) => r.execucoes.obter(id))) !== null,
      },
    });
    await app.listen({ host: config.host, port: config.porta });
    const endereco = app.server.address();
    const porta = typeof endereco === 'object' && endereco ? endereco.port : config.porta;
    diagnostico.definirAutoteste(() => autotesteServidor(porta));
    await diagnostico.rodar();

    let encerrando: Promise<void> | null = null;
    const encerrar = (): Promise<void> => {
      encerrando ??= (async () => {
        await app.close().catch(() => {});
        for (const p of pollings.values()) p.parar();
        // Agentes em curso: escada (SIGINT → SIGTERM → SIGKILL) com teto, para o
        // desligamento nunca ficar preso a uma verificação longa.
        await Promise.race([
          orq.parar().catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 35_000).unref()),
        ]);
        await terminal?.encerrarTodas().catch(() => {});
        const sobras = await encerrarDescendentes();
        if (sobras > 0) log(`desligamento: ${sobras} processo(s) filho(s) encerrado(s) à força`);
        await banco.fechar();
      })();
      return encerrando;
    };

    return {
      app,
      banco,
      orq,
      compat,
      diagnostico,
      conexoes,
      terminal,
      porta,
      encerrar,
    };
  } catch (e) {
    await desfazer();
    throw e;
  }
}
