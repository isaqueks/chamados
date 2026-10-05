import { existsSync } from 'node:fs';
import type { RespostaDetalheChamado } from '@chamados/cliente-api';
import type { PlanoRegistrado, PlanoV1 } from '../../comum/contratos';
import type {
  AprovarDto,
  AprovarPlanoDto,
  ComandoAceitoDto,
  CriarExecucaoDto,
  DecidirDto,
  DescartarDto,
  ResolverPendenciaDto,
} from '../../comum/dto';
import { avaliarG0, resolverProjeto } from '../chamados/fila';
import {
  PollingChamados,
  paraEventoSinal,
  type AlvoPolling,
  type SinalChamado,
} from '../chamados/polling';
import { sinaisDoDetalhe } from '../chamados/sinais';
import {
  avaliarPublicacao,
  chavesDosMotivos,
  validarRespostaPublica,
  type TipoResposta,
} from '../chamados/validador-linguagem';
import { hashCorpo } from '../chamados/normalizacao';
import type { Execucao } from '../db/entidades/execucao';
import { SessaoTerminalSchema } from '../db/entidades/sessao-terminal';
import type { JsonLivre } from '../db/json';
import {
  commitCheckpoint,
  ErroCheckpointBranch,
  listarWorktrees,
  MENSAGEM_MANUAL,
  removerWorktree,
  shaHead,
} from '../git';
import { ehAncestral } from '../git/git';
import {
  reconciliarNoBoot,
  sondarProcesso,
  type AcaoReconciliacao,
  type EstadoSondado,
  type ProcessoParaSondar,
} from '../processos';
import {
  maisUmCicloPermitido,
  retomadasAutomaticas,
  seguirComAchadosPermitido,
} from './aplicacao-resultados';
import { maisUmCicloExigeConfirmacao } from './ciclos';
import {
  conversar,
  implementar,
  interromperProcesso,
  opcoesCheckpoint,
  planejar,
  planoOficial,
  preparar,
  reavaliarPlano,
  recapturarPrints,
  relatar,
  resolverConflito,
  revisar,
  verificar,
} from './etapas';
import { FilaMerge, type OpcoesFilaMerge } from './fila-merge';
import {
  avaliarFreio,
  bloqueiaInicio,
  LIMIARES_PADRAO,
  podeRetomarPausaCota,
  type Freio,
  type LimiaresCota,
} from './freio-cota';
import { avaliarG2, exigeReaprovacao, type ContextoG2 } from './gates';
import {
  chaveDestino,
  distribuirVagas,
  ordenarInicio,
  recursosDaEtapa,
  validarAprovacaoEmBloco,
  type CandidatoVaga,
} from './lote';
import {
  ESTADOS_ANTES_DE_MERGEADO,
  ESTADOS_COM_AGENTE,
  ESTADOS_PAUSAVEIS,
  type EventoMaquina,
} from './maquina-execucao';
import { ErroForja, etapaDoEstado, naoEncontrado, Nucleo, type DepsOrquestrador } from './nucleo';
import { DespachanteOutbox } from './outbox';
import { executarRetencao } from './retencao';
import { valoresDeArquivosLocais } from './segredos-locais';

/**
 * Orquestrador do pipeline (specs/forja/03 inteira; 01 §3.2, §6.7–§6.8): conduz
 * cada `execucao` pela máquina do domínio puro.
 *
 * Modelo de execução: um DESPACHANTE serializado olha todas as execuções não
 * terminais e, para cada uma sem tarefa em voo, decide o que fazer no estado
 * em que ela está — iniciar uma etapa (pedindo vaga a `distribuirVagas`, que
 * dá prioridade a quem está mais adiante e respeita freio de cota e CLI,
 * 03 §7.2/§7.6), aplicar um passo transitório (`plano_pronto`,
 * `retrabalho_humano`, `mergeado`) ou esperar o humano. Cada etapa roda como
 * tarefa assíncrona; ao terminar ela transiciona, e toda transição
 * re-despacha. Comandos humanos entram por métodos públicos (a fachada
 * `servicos.ts` chama) e também só transicionam: o trabalho segue pelo
 * despachante.
 *
 * Estado em memória (reconstruído no boot): vagas dos semáforos, processo de
 * agente em curso por execução, pausas pendentes, lotes pausados.
 */

export interface OpcoesOrquestrador extends DepsOrquestrador {
  filaMerge?: OpcoesFilaMerge;
  /** Sondagem de processo para a reconciliação (padrão: `/proc`). */
  sondar?: (p: ProcessoParaSondar) => EstadoSondado;
}

type Tarefa = Promise<void>;

/** O que a fachada lê do SQLite/git para o G2 (05 §7.1: conferido no servidor). */
export interface ContextoAprovacaoFinal {
  contexto: ContextoG2;
  tipo_resposta: TipoResposta;
  /** `corpo_hash` da resposta gerada: texto diferente = `aprovado_com_edicao`. */
  corpo_hash_original: string;
}

export class Orquestrador {
  readonly n: Nucleo;
  readonly outbox: DespachanteOutbox;
  readonly filaMerge: FilaMerge;
  private readonly tarefas = new Map<string, Tarefa>();
  private readonly naoAntesDe = new Map<string, number>();
  /** Tarefas seguidas que terminaram sem transição (defesa contra laço de despacho). */
  private readonly semProgresso = new Map<string, number>();
  private readonly transicoes = new Map<string, number>();
  private readonly lotesPausados = new Set<string>();
  /** "Cliente respondeu" visto pelo polling (badge, 03 §11 F14). */
  readonly clienteRespondeu = new Set<string>();
  private despachando = false;
  private denovo = false;
  private despachoEmCurso: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private parado = false;
  private ultimaRetencao = 0;
  private readonly sondar: (p: ProcessoParaSondar) => EstadoSondado;

  constructor(readonly opcoes: OpcoesOrquestrador) {
    this.n = new Nucleo(opcoes);
    this.outbox = new DespachanteOutbox(this.n);
    this.filaMerge = new FilaMerge(this.n, opcoes.filaMerge);
    this.sondar = opcoes.sondar ?? ((p) => sondarProcesso(p));
    this.n.aoTransicionar = (id) => {
      this.transicoes.set(id, (this.transicoes.get(id) ?? 0) + 1);
      this.semProgresso.delete(id);
      this.agendar();
    };
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  /** Boot (01 §4.1, §6.7; 03 §9.5): reconcilia, reconstrói vagas e começa a despachar. */
  async iniciar(): Promise<AcaoReconciliacao[]> {
    const acoes = await this.reconciliarNoBoot();
    await this.reconstruirVagas();
    // Valores dos `.env` copiados das execuções em voo (05 §8.2): redigidos desde o boot.
    for (const e of await this.n.banco.ler((r) => r.execucoes.listar({ ativas: true }))) {
      if (!e.worktree_dir || !existsSync(e.worktree_dir)) continue;
      this.n.registrarSegredos(await valoresDeArquivosLocais(e.config_snapshot, e.worktree_dir));
    }
    const intervalo = this.opcoes.intervaloTickMs ?? 30_000;
    if (intervalo > 0) {
      this.timer = setInterval(() => void this.tick(), intervalo);
      this.timer.unref?.();
    }
    this.agendar();
    return acoes;
  }

  /**
   * Desligamento (01 §3.2): para de iniciar etapas e INTERROMPE (SIGINT, como a
   * pausa) os agentes em curso, todos em paralelo: a etapa fica `interrompida`
   * e o próximo boot retoma a sessão com o prompt de retomada (03 §3.3), em vez
   * de recomeçar o turno do zero numa sessão cortada no meio.
   */
  async parar(): Promise<void> {
    this.parado = true;
    if (this.timer) clearInterval(this.timer);
    const emCurso = [...this.n.emCurso.entries()];
    await Promise.all(
      emCurso.map(([id]) => interromperProcesso(this.n, id, 'pausa').catch(() => false)),
    );
    await Promise.all(
      emCurso.map(async ([id, p]) => {
        const e = await this.n.banco.ler((r) => r.execucoes.obter(id)).catch(() => null);
        if (!e) return;
        await commitCheckpoint(
          p.cwd,
          'forja: estado ao interromper',
          opcoesCheckpoint(e, e.config_snapshot),
        ).catch(() => null);
      }),
    );
    await this.ocioso();
  }

  /** Relógio: freio liberado, backoff do outbox, cópia suja (03 §7.6, §8.2, §9.3). */
  async tick(): Promise<void> {
    if (this.parado) return;
    await this.outbox.processarTodos().catch((e: unknown) => this.n.log(`outbox: ${String(e)}`));
    // Retenção (02 §9): no boot e depois 1×/dia.
    const agora = this.n.agora().getTime();
    if (agora - this.ultimaRetencao >= 86_400_000) {
      this.ultimaRetencao = agora;
      await executarRetencao(this.n).catch((e: unknown) => this.n.log(`retenção: ${String(e)}`));
    }
    this.agendar();
  }

  /**
   * Espera não haver tarefa nem despacho pendente (testes e desligamento).
   * Estourar o limite é ERRO: um laço de despacho sem fim nunca passa calado.
   */
  async ocioso(limite = 1000): Promise<void> {
    for (let i = 0; i < limite; i++) {
      await this.despachoEmCurso;
      const emVoo = [...this.tarefas.values()];
      if (emVoo.length === 0 && !this.despachando && !this.denovo) {
        await new Promise((r) => setImmediate(r));
        if (this.tarefas.size === 0 && !this.despachando && !this.denovo) return;
        continue;
      }
      await Promise.allSettled(emVoo);
    }
    throw new Error(`orquestrador não ficou ocioso em ${limite} voltas (laço de despacho?)`);
  }

  /** Adia o próximo despacho da execução e garante que ele aconteça (sem depender do relógio). */
  private adiar(execucaoId: string, ms: number): void {
    this.naoAntesDe.set(execucaoId, this.n.agora().getTime() + ms);
    const t = setTimeout(() => this.agendar(), ms + 5);
    t.unref?.();
  }

  /** Pede um despacho (coalescido). */
  agendar(): void {
    if (this.parado) return;
    if (this.despachando) {
      this.denovo = true;
      return;
    }
    this.despachando = true;
    this.despachoEmCurso = (async () => {
      try {
        do {
          this.denovo = false;
          await this.rodadaDespacho();
        } while (this.denovo && !this.parado);
      } catch (e) {
        this.n.log(`despacho: ${String(e)}`);
      } finally {
        this.despachando = false;
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Despacho (03 §2.4 linhas "código"; §7.2 vagas)
  // -------------------------------------------------------------------------

  /** Freio de cota com os limiares de um projeto (U-8: `limites.freio_cota`); padrão = global. */
  async freio(limiares: LimiaresCota = LIMIARES_PADRAO): Promise<Freio> {
    const leitura = await this.n.banco.ler((r) => r.usoAssinatura.ultimo());
    return avaliarFreio(
      leitura ? { ...leitura, medido_em: leitura.criado_em } : null,
      limiares,
      this.n.agora(),
    );
  }

  private async rodadaDespacho(): Promise<void> {
    const n = this.n;
    const execs = await n.banco.ler((r) => r.execucoes.listar({ ativas: true }));
    const leitura = await n.banco.ler((r) => r.usoAssinatura.ultimo());
    const freioDe = (e: Execucao): Freio =>
      avaliarFreio(
        leitura ? { ...leitura, medido_em: leitura.criado_em } : null,
        e.config_snapshot.limites.freio_cota ?? LIMIARES_PADRAO,
        n.agora(),
      );
    const travados = await this.outbox.projetosTravados();
    const agora = n.agora().getTime();
    const candidatos: CandidatoVaga[] = [];
    const ordem = await this.ordemDeInicio(execs);
    for (const e of execs) {
      if (this.tarefas.has(e.id)) continue;
      if ((this.naoAntesDe.get(e.id) ?? 0) > agora) continue;
      const chave = chaveDestino(e.projeto_id, e.branch_destino);
      switch (e.estado) {
        case 'plano_pronto':
          this.lancar(e.id, () => reavaliarPlano(n, e.id));
          continue;
        case 'retrabalho_humano':
          this.lancar(e.id, async () => {
            await n.transicionar(e.id, { tipo: 'retrabalho_iniciado' });
          });
          continue;
        case 'mergeado':
          this.lancar(e.id, () => this.iniciarComunicacao(e.id));
          continue;
        case 'pausado_cota': {
          const freio = freioDe(e);
          if (podeRetomarPausaCota(freio.ate, freio, n.agora())) {
            this.lancar(e.id, async () => {
              await n.transicionar(e.id, { tipo: 'cota_liberada' });
            });
          }
          continue;
        }
        case 'interrompido':
          if (this.opcoes.retomadaAutomatica !== false) {
            const etapas = await n.banco.ler((r) => r.etapas.listar(e.id));
            const tipo = etapaDoEstado(e.estado_anterior ?? 'na_fila') ?? 'implementar';
            const ja = retomadasAutomaticas(etapas, tipo) > 0;
            this.lancar(e.id, async () => {
              await n.transicionar(e.id, {
                tipo: 'retomada_automatica',
                ja_retomada_nesta_etapa: ja,
              });
            });
          }
          continue;
        case 'na_fila':
          if (e.lote_id && this.lotesPausados.has(e.lote_id)) continue;
          break;
        case 'integrando': {
          // Sentinela não reconhecida trava a fila de merge do projeto (03 §2.5).
          if (travados.has(e.projeto_id)) continue;
          const item = await n.banco.ler((r) => r.filaMerge.ativoDaExecucao(e.id));
          if (item && !this.filaMerge.prontoParaTentar(item.id)) continue;
          if (n.vagas.tentar({ execucao_id: e.id, recurso: 'merge', chave })) {
            this.lancar(e.id, () => this.integrar(e.id, false), [
              { execucao_id: e.id, recurso: 'merge', chave },
            ]);
          }
          continue;
        }
        case 'na_fila_merge': {
          const proximo = await n.banco.ler((r) =>
            r.filaMerge.proximo(e.projeto_id, e.branch_destino),
          );
          if (!proximo || proximo.execucao_id !== e.id) continue;
          // Schema imprevisto (03 §7.3): quem altera o banco espera o dono do
          // token do destino mergear — duas migrations nunca entram fora de ordem.
          const dono = n.vagas.donoSchema(chave);
          if (e.selos?.altera_banco && dono && dono !== e.id) continue;
          break;
        }
      }
      const etapa = etapaDoEstado(e.estado);
      if (!etapa) continue;
      // Os prints `antes` são do próprio T1 desde FJ-030 §3 (B7): nada a despachar antes dele.
      const schema =
        e.estado === 'implementando'
          ? ((await planoOficial(n, e.id))?.schema_banco.altera ?? false)
          : false;
      candidatos.push({
        execucao_id: e.id,
        estado: e.estado,
        etapa,
        ordem: ordem.get(e.id) ?? Number.MAX_SAFE_INTEGER,
        chave_destino: chave,
        precisa_token_schema: schema,
      });
    }
    if (candidatos.length === 0) return;
    const dist = distribuirVagas({
      candidatos: candidatos.filter((c) => {
        const e = execs.find((x) => x.id === c.execucao_id);
        if (!e) return true;
        // Freio com os limiares DO PROJETO (overage autorizado e limiares próprios valem).
        if (bloqueiaInicio(freioDe(e), c.etapa).bloqueia) return false;
        return c.etapa !== 'integrar' || !travados.has(e.projeto_id);
      }),
      semaforos: n.vagas.semaforos,
      freio_ativo: false,
      cli_compativel: n.cliCompativel(),
    });
    n.vagas.definir(dist.semaforos);
    for (const ini of dist.iniciar) {
      const c = candidatos.find((x) => x.execucao_id === ini.execucao_id)!;
      // A vaga de `schema` fica presa até mergeado/descartado/cancelado (03 §7.3).
      const soltar = recursosDaEtapa(ini.etapa, c)
        .filter((p) => p.recurso !== 'schema')
        .map((p) => ({ ...p, execucao_id: ini.execucao_id }));
      this.lancar(
        ini.execucao_id,
        () => this.rodarEtapa(ini.execucao_id, c.estado, ini.etapa),
        soltar,
      );
    }
  }

  /** Ordem de início (03 §7.2): prioridade, complexidade, idade do chamado. */
  private async ordemDeInicio(execs: Execucao[]): Promise<Map<string, number>> {
    const itens = await this.n.banco.ler(async (r) => {
      const out = [];
      for (const e of execs) {
        const c = await r.chamados.obter(e.chamado_cache_id);
        out.push({
          execucao_id: e.id,
          prioridade: c?.prioridade ?? 'media',
          complexidade: c?.complexidade ?? null,
          chamado_criado_em: c?.criado_em ?? e.criado_em,
        });
      }
      return out;
    });
    return new Map(ordenarInicio(itens).map((id, i) => [id, i]));
  }

  private lancar(
    execucaoId: string,
    fn: () => Promise<void>,
    soltar: Parameters<Nucleo['vagas']['soltar']>[0][] = [],
  ): void {
    const antes = this.transicoes.get(execucaoId) ?? 0;
    const tarefa = (async () => {
      try {
        await fn();
      } catch (e) {
        await this.falhaInterna(execucaoId, e);
      } finally {
        for (const p of soltar) this.n.vagas.soltar(p);
        this.tarefas.delete(execucaoId);
        await this.aplicarPausaPendente(execucaoId);
        // Defesa: tarefas seguidas sem transição (etapa que "não pôde" rodar)
        // ganham um recuo crescente — o despachante nunca relança em laço só
        // de microtasks, que pararia o event loop (HTTP, SSE, relogin).
        if ((this.transicoes.get(execucaoId) ?? 0) === antes) {
          const k = (this.semProgresso.get(execucaoId) ?? 0) + 1;
          this.semProgresso.set(execucaoId, k);
          if (k >= 3 && (this.naoAntesDe.get(execucaoId) ?? 0) <= this.n.agora().getTime()) {
            this.adiar(execucaoId, Math.min(60_000, 1000 * 2 ** (k - 3)));
          }
        }
        this.agendar();
      }
    })();
    this.tarefas.set(execucaoId, tarefa);
  }

  /**
   * Bug ou erro inesperado numa tarefa: nunca deixa a execução "rodando" sem
   * processo nem em retentativa silenciosa. A saída depende do estado (a
   * tabela 03 §2.4 só aceita `falhou` com o motivo do estado), a etapa aberta
   * é finalizada e o motivo aparece no feed.
   */
  private async falhaInterna(execucaoId: string, e: unknown): Promise<void> {
    const n = this.n;
    const texto = `erro interno: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    n.log(`execução ${execucaoId}: ${texto}`);
    const atual = await n.banco.ler((r) => r.execucoes.obter(execucaoId)).catch(() => null);
    if (!atual) return;
    // Etapa que ficou `executando` sem processo (o índice por sessão travaria a próxima).
    await n.banco
      .transacao(async (r) => {
        for (const et of await r.etapas.listar(execucaoId)) {
          if (et.estado === 'executando' && n.emCurso.get(execucaoId)?.etapaId !== et.id) {
            await r.etapas.finalizar(et.id, { estado: 'falhou', motivo_fim: 'erro_execucao' });
          }
        }
      })
      .catch(() => undefined);
    if (atual.estado === 'integrando') {
      // Item que ficou em processamento volta a `aguardando` (a fila do destino
      // não pode travar); "Tentar de novo" o retoma do passo 1.
      await n.banco
        .transacao(async (repo) => {
          const item = await repo.filaMerge.ativoDaExecucao(execucaoId);
          if (item && ['integrando', 'verificando', 'publicando'].includes(item.estado)) {
            await repo.filaMerge.mudarEstado(item.id, 'aguardando', { motivo: texto });
          }
        })
        .catch(() => undefined);
    }
    const evento: EventoMaquina =
      atual.estado === 'integrando'
        ? { tipo: 'integracao_concluida', resultado: 'setup_falhou', texto }
        : { tipo: 'falha_infra', motivo: 'setup_falhou', texto };
    const r = await n.transicionar(execucaoId, evento).catch(() => null);
    if (r?.decisao.tipo === 'transicao') return;
    // Sem saída na tabela (pós-merge, laterais): retenta com recuo, mas VISÍVEL.
    await n
      .publicar({
        execucao_id: execucaoId,
        etapa_id: null,
        tipo: 'cli.alerta',
        nivel: 'erro',
        resumo: `#${atual.numero} (${atual.estado}): ${texto}`,
        dados: { codigo: 'erro_interno', bloqueante: false },
      })
      .catch(() => undefined);
    this.adiar(execucaoId, 60_000);
  }

  private async aplicarPausaPendente(execucaoId: string): Promise<void> {
    if (!this.n.pausasPendentes.has(execucaoId)) return;
    this.n.pausasPendentes.delete(execucaoId);
    const e = await this.n.banco.ler((r) => r.execucoes.obter(execucaoId));
    if (e && ESTADOS_PAUSAVEIS.includes(e.estado)) {
      await this.n.transicionar(execucaoId, { tipo: 'pausar' }).catch(() => null);
    }
  }

  private async rodarEtapa(
    execucaoId: string,
    estado: Execucao['estado'],
    etapa: string,
  ): Promise<void> {
    const n = this.n;
    // A decisão do despacho foi tomada sobre uma foto com vários `await` no
    // meio: um comando humano (Pausar, Descartar) pode ter mudado o estado.
    const agora = await n.banco.ler((r) => r.execucoes.obter(execucaoId));
    if (!agora || agora.estado !== estado) return;
    switch (etapa) {
      case 'planejar': {
        if (estado === 'na_fila') {
          const t = await n.transicionar(execucaoId, {
            tipo: 'tentar_iniciar',
            vaga_livre: true,
            freio_liberado: true,
            ordem_lote_ok: true,
            cli_compativel: n.cliCompativel(),
          });
          if (t.execucao.estado !== 'preparando') return;
          estado = 'preparando';
        }
        if (estado === 'preparando') {
          const r = await preparar(n, execucaoId, async (id) => {
            await this.outbox.criarRodadaInicio(id);
            await this.outbox.processarExecucao(id);
          });
          if (r === 'aguardar') {
            this.adiar(execucaoId, 30_000);
            return;
          }
          if (r !== 'planejando') return;
        }
        if ((await planejar(n, execucaoId)) === 'aguardar') this.adiar(execucaoId, 30_000);
        return;
      }
      case 'implementar':
        await implementar(n, execucaoId);
        return;
      case 'verificar':
        await verificar(n, execucaoId);
        return;
      case 'revisar':
        await revisar(n, execucaoId);
        return;
      case 'relatar':
        await relatar(n, execucaoId);
        return;
      case 'resolver_conflito':
        await resolverConflito(n, execucaoId, () => this.filaMerge.baseDestino(execucaoId));
        return;
      case 'integrar':
        await this.integrar(execucaoId, true);
        return;
    }
  }

  /** `na_fila_merge` → `integrando` → passos de 03 §8.1. */
  private async integrar(execucaoId: string, entrar: boolean): Promise<void> {
    if (entrar) {
      const t = await this.n.transicionar(execucaoId, {
        tipo: 'vez_na_fila_merge',
        proximo_da_fila: true,
        semaforo_merge_livre: true,
      });
      if (t.execucao.estado !== 'integrando') return;
    }
    const r = await this.filaMerge.processar(execucaoId);
    if (r === 'travado') this.adiar(execucaoId, 60_000);
  }

  /** `mergeado` → `comunicando` com a rodada de encerramento (03 §9.1). */
  private async iniciarComunicacao(execucaoId: string): Promise<void> {
    await this.outbox.criarRodadaEncerramento(execucaoId);
    await this.n.transicionar(execucaoId, { tipo: 'outbox_iniciado' });
    await this.outbox.processarExecucao(execucaoId);
    const e = await this.n.banco.ler((r) => r.execucoes.exigir(execucaoId));
    if (e.estado === 'concluido') await this.limparAoConcluir(e);
  }

  /** 02 §9: worktree de execução `concluido` sai logo após o outbox + push confirmado. */
  private async limparAoConcluir(e: Execucao): Promise<void> {
    if (!e.worktree_dir || !existsSync(e.worktree_dir)) return;
    const projeto = await this.n.banco.ler((r) => r.projetos.exigir(e.projeto_id));
    await removerWorktree(projeto.repo_dir, e.worktree_dir, {
      dirDados: this.n.deps.dirDados,
    }).catch((err: unknown) => this.n.log(`limpar worktree: ${String(err)}`));
  }

  // -------------------------------------------------------------------------
  // Boot (03 §9.5; 01 §6.7)
  // -------------------------------------------------------------------------

  async reconciliarNoBoot(): Promise<AcaoReconciliacao[]> {
    const n = this.n;
    const banco = n.banco;
    const acoes = await reconciliarNoBoot(
      {
        etapasExecutando: () =>
          banco.ler(async (r) =>
            (await r.etapas.executando()).map((e) => ({
              etapa_id: e.id,
              execucao_id: e.execucao_id,
              tipo: e.tipo,
              pid: e.pid,
              pgid: e.pgid,
              session_id: e.session_id,
            })),
          ),
        sessoesTerminalAbertas: () =>
          banco.ler(async (r) =>
            (await r.terminais.abertas()).map((s) => ({
              sessao_terminal_id: s.id,
              tipo: s.tipo,
              pid: s.pid,
              pgid: s.pgid,
              execucao_id: s.execucao_id,
              session_id_claude: s.session_id_claude,
            })),
          ),
        execucoesAtivas: () =>
          banco.ler(async (r) =>
            (await r.execucoes.listar({ ativas: true }))
              .filter((e) => e.worktree_dir)
              .map((e) => ({ execucao_id: e.id, caminho_worktree: e.worktree_dir as string })),
          ),
        worktrees: async () => {
          const projetos = await banco.ler((r) => r.projetos.listar());
          const out = [];
          for (const p of projetos) {
            if (!existsSync(p.repo_dir)) continue;
            const lista = await listarWorktrees(p.repo_dir).catch(() => []);
            for (const w of lista) {
              out.push({
                repositorio: p.repo_dir,
                caminho: w.caminho,
                branch: w.branch,
                prunable: w.prunable,
              });
            }
          }
          return out;
        },
        itensMergeIntegrando: async () => [],
        outboxEnviando: () =>
          banco.ler(async (r) =>
            (await r.outbox.emEnvio()).map((o) => ({
              outbox_id: o.id,
              execucao_id: o.execucao_id,
              passo: o.passo,
            })),
          ),
      },
      {
        sondar: this.sondar,
        ehAncestral: (repo, sha, ref) => ehAncestral(repo, sha, ref),
      },
      { raizWorktrees: `${n.deps.dirDados}/worktrees` },
    );
    const execucoesWorktree = new Map(
      (await banco.ler((r) => r.execucoes.listar({ ativas: true }))).map((e) => [
        e.id,
        e.worktree_dir,
      ]),
    );
    for (const a of acoes) {
      switch (a.tipo) {
        case 'encerrar_grupo': {
          await n.deps.encerrarGrupo?.(a.pgid, a.escada).catch(() => {});
          // [V S4] SIGKILL no grupo não alcança o Bash do agente: varre o cwd.
          if (a.origem === 'etapa' && n.deps.varrerCwd) {
            const etapa = await banco.ler((r) => r.etapas.obter(a.ref_id));
            const dir = etapa ? execucoesWorktree.get(etapa.execucao_id) : null;
            if (dir) await n.deps.varrerCwd(dir).catch(() => 0);
          }
          break;
        }
        case 'varrer_cwd': {
          // 01 §3.2 [V S4]: toda etapa (viva, morta ou sem pid) que não seja
          // `integrar` deixa a worktree varrida antes de ser marcada.
          const dir = execucoesWorktree.get(a.execucao_id);
          if (dir && n.deps.varrerCwd) await n.deps.varrerCwd(dir).catch(() => 0);
          break;
        }
        case 'etapa_interrompida':
          await banco.transacao(async (r) => {
            const e = await r.etapas.obter(a.etapa_id);
            if (e?.estado === 'executando') {
              await r.etapas.finalizar(a.etapa_id, {
                estado: 'interrompida',
                motivo_fim: 'interrompido',
              });
            }
          });
          break;
        case 'execucao_interrompida':
          if (a.recuperacao === 'retomar_agente') {
            await n.transicionar(a.execucao_id, { tipo: 'processo_interrompido' });
          }
          // `refazer_verificacao`: a coleta recomeça do zero (o despachante a roda de novo).
          break;
        case 'sessao_terminal_encerrada':
          await banco.transacao((r) => r.terminais.encerrar(a.sessao_terminal_id));
          break;
        default:
          break;
      }
    }
    await this.filaMerge.reconciliar();
    await this.outbox.reconciliarEnviando();
    return acoes;
  }

  /** Vagas presas que sobrevivem ao reboot: o token de `schema` (03 §7.3). */
  private async reconstruirVagas(): Promise<void> {
    const n = this.n;
    const execs = await n.banco.ler((r) => r.execucoes.listar({ ativas: true }));
    for (const e of execs) {
      const temImpl = await n.banco.ler(async (r) =>
        (await r.etapas.listar(e.id)).some((x) => x.tipo === 'implementar'),
      );
      if (!temImpl) continue;
      const plano = await planoOficial(n, e.id);
      // Token também do schema IMPREVISTO (selo `altera_banco` sem o plano prever, 03 §7.3).
      if (plano?.schema_banco.altera || e.selos?.altera_banco) {
        n.vagas.tentar({
          execucao_id: e.id,
          recurso: 'schema',
          chave: chaveDestino(e.projeto_id, e.branch_destino),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // G0: Implementar e Implementar em lote (03 §4.1; 07 §3)
  // -------------------------------------------------------------------------

  private async detalheChamado(
    conexaoId: string,
    chamadoId: string,
  ): Promise<RespostaDetalheChamado> {
    const fonte = this.n.fonte(conexaoId);
    if (!fonte || !fonte.podeUsar()) {
      throw new ErroForja(
        'chamados_indisponivel',
        'a conexão com o Chamados não está utilizável',
        503,
      );
    }
    try {
      return await fonte.api.obterChamado(chamadoId, { formato: 'markdown' });
    } catch (e) {
      throw new ErroForja('chamados_indisponivel', `Chamados: ${(e as Error).message}`, 503);
    }
  }

  /** Cria a execução em `na_fila` (G0, nunca automático). */
  async criarExecucao(
    dto: CriarExecucaoDto,
    opcoes: { lote_id?: string | null } = {},
  ): Promise<{ execucao_id: string; estado: Execucao['estado'] }> {
    const n = this.n;
    const projeto = await n.banco.ler((r) => r.projetos.obter(dto.projeto_id));
    if (!projeto) throw naoEncontrado('projeto');
    const fonte = n.fonte(projeto.conexao_id);
    const detalhe = await this.detalheChamado(projeto.conexao_id, dto.chamado_id);
    const c = detalhe.chamado;
    const sinais = sinaisDoDetalhe(detalhe);
    const mapeamentos = await n.banco.ler((r) =>
      r.projetos.listarTodosMapeamentos(projeto.conexao_id),
    );
    const resolucao = resolverProjeto(c, mapeamentos);
    const ativa = await n.banco.ler((r) => r.execucoes.ativaDoChamado(projeto.conexao_id, c.id));
    const g0 = avaliarG0({
      chamado: { status: c.status, natureza: c.natureza },
      projeto: resolucao.projeto_id === projeto.id ? resolucao : { ...resolucao },
      execucaoAtiva: ativa !== null,
      conexaoOk: fonte?.podeUsar() ?? false,
      pipelineDesbloqueado: n.cliCompativel(),
      prIa: sinais.tem_pr_ia
        ? { branch: sinais.branch_ia, pr_url: sinais.pr_url_ia, numero_na_branch: c.numero }
        : null,
    });
    if (resolucao.projeto_id !== null && resolucao.projeto_id !== projeto.id) {
      throw new ErroForja(
        'pre_condicao_falhou',
        'o sistema do chamado está mapeado para outro projeto',
        409,
      );
    }
    if (!g0.implementavel) {
      throw new ErroForja(
        'pre_condicao_falhou',
        'pré-condições do G0 não atendidas',
        409,
        g0.pre_condicoes,
      );
    }
    if (c.status === 'aguardando_cliente' && !dto.confirmar_aguardando_cliente) {
      throw new ErroForja(
        'pre_condicao_falhou',
        'o chamado aguarda o cliente: confirme explicitamente',
        409,
        g0.pre_condicoes,
      );
    }
    // Snapshot resolvido com o repositório relido AGORA (FJ-030 §1): scripts,
    // lockfile e branch podem ter mudado desde o cadastro. Nada de git na transação.
    const snapshot = n.configDoProjeto(await n.redetectar(projeto));
    const criada = await n.banco.transacao(async (r) => {
      const cache = await r.chamados.gravarDaLista({
        conexao_id: projeto.conexao_id,
        chamado_id: c.id,
        numero: c.numero,
        titulo: c.titulo,
        status: c.status,
        natureza: c.natureza,
        prioridade: c.prioridade,
        complexidade: c.complexidade ?? null,
        sistema_nome: c.sistema_nome,
        ia_silenciada: c.ia_silenciada ?? null,
        atualizado_em_remoto: c.updated_at,
      });
      await r.chamados.gravarDetalhe(cache.id, {
        sinais: {
          tem_spec_ia: sinais.tem_spec_ia,
          tem_diagnostico_ia: sinais.tem_diagnostico_ia,
          tem_pr_ia: sinais.tem_pr_ia,
          branch_ia: sinais.branch_ia,
        },
        ia_silenciada: sinais.ia_silenciada,
        ultima_mensagem_id: detalhe.mensagens.at(-1)?.id ?? null,
        ultima_mensagem_em: detalhe.mensagens.at(-1)?.created_at ?? null,
      });
      const e = await r.execucoes.criar({
        conexao_id: projeto.conexao_id,
        chamado_id: c.id,
        chamado_cache_id: cache.id,
        projeto_id: projeto.id,
        lote_id: opcoes.lote_id ?? null,
        numero: c.numero,
        config_snapshot: snapshot,
      });
      const ev = await r.eventos.acrescentar(
        {
          execucao_id: e.id,
          etapa_id: null,
          tipo: 'execucao.estado',
          nivel: 'info',
          resumo: `#${e.numero}: G0 → na_fila (tentativa ${e.tentativa})`,
          dados: {
            estado: 'na_fila',
            estado_anterior: null,
            motivo_estado: null,
            numero: e.numero,
            projeto_id: e.projeto_id,
          },
        },
        { origem: 'humano' },
      );
      return { e, ev };
    });
    n.deps.barramento.difundir(criada.ev);
    this.agendar();
    return { execucao_id: criada.e.id, estado: criada.e.estado };
  }

  /** Lote (03 §7): cada chamado vira uma execução; G1 por risco (FJ-033), a mesa recebe quem cair no gate. */
  async criarLote(
    projetoId: string,
    chamadoIds: readonly string[],
  ): Promise<{ lote_id: string; execucao_ids: string[] }> {
    const projeto = await this.n.banco.ler((r) => r.projetos.obter(projetoId));
    if (!projeto) throw naoEncontrado('projeto');
    if (chamadoIds.length === 0) throw new ErroForja('entrada_invalida', 'lote vazio', 400);
    const lote = await this.n.banco.transacao((r) =>
      r.lotes.criar({
        projeto_id: projetoId,
        concorrencia_planos: this.n.configDoProjeto(projeto).limites.concorrencia.planejadores,
        concorrencia_impl: this.n.configDoProjeto(projeto).limites.concorrencia.agentes,
      }),
    );
    const ids: string[] = [];
    for (const chamado_id of chamadoIds) {
      try {
        const c = await this.criarExecucao(
          { projeto_id: projetoId, chamado_id },
          { lote_id: lote.id },
        );
        ids.push(c.execucao_id);
      } catch (e) {
        this.n.log(`lote ${lote.id}: ${chamado_id} ficou de fora: ${(e as Error).message}`);
      }
    }
    return { lote_id: lote.id, execucao_ids: ids };
  }

  pausarLote(loteId: string): void {
    this.lotesPausados.add(loteId);
  }

  async cancelarPendentesDoLote(loteId: string, ids: readonly string[]): Promise<void> {
    const execs = await this.n.banco.ler((r) =>
      r.execucoes.listar({ lote_id: loteId, ativas: true }),
    );
    for (const e of execs) {
      if (!ids.includes(e.id)) continue;
      const etapas = await this.n.banco.ler((r) => r.etapas.listar(e.id));
      if (etapas.some((x) => x.tipo === 'implementar')) continue;
      await this.encerrar(e.id, 'cancelado no lote');
    }
  }

  /** Mesa de planos: aprovação em bloco SÓ de planos limpos (03 §7.4). */
  async aprovarLimpos(loteId: string, ids: readonly string[]): Promise<void> {
    const execs = await this.n.banco.ler((r) => r.execucoes.listar({ lote_id: loteId }));
    const itens = [];
    for (const e of execs)
      itens.push({
        execucao_id: e.id,
        estado: e.estado,
        plano: (await planoOficial(this.n, e.id)) as PlanoV1 | null,
      });
    const v = validarAprovacaoEmBloco(ids, itens);
    if (!v.ok)
      throw new ErroForja(
        'pre_condicao_falhou',
        'há planos fora da aprovação em bloco',
        409,
        v.erros,
      );
    for (const id of ids) {
      const plano = await this.n.banco.ler((r) => r.artefatos.ultimaVersao(id, 'plano'));
      await this.n.transicionar(
        id,
        { tipo: 'aprovar_plano' },
        {
          exigir: true,
          dentro: async (r) => {
            await r.aprovacoes.registrar({
              execucao_id: id,
              tipo: 'plano',
              decisao: 'aprovado',
              artefato_id: plano?.id ?? null,
              em_bloco: true,
              lote_id: loteId,
            });
          },
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // G1 / Gdec (03 §4)
  // -------------------------------------------------------------------------

  async aprovarPlano(id: string, dto: AprovarPlanoDto): Promise<ComandoAceitoDto> {
    const n = this.n;
    const atual = await n.banco.ler((r) => r.artefatos.ultimaVersao(id, 'plano'));
    if (!atual) throw naoEncontrado('plano');
    if (atual.id !== dto.artefato_id) {
      throw new ErroForja(
        'conflito',
        'há uma versão mais nova do plano: reabra antes de aprovar',
        409,
      );
    }
    const r = await n.transicionar(
      id,
      { tipo: 'aprovar_plano' },
      {
        exigir: true,
        dentro: async (repo) => {
          let artefatoId = atual.id;
          if (dto.plano_editado) {
            const base = atual.conteudo as unknown as PlanoRegistrado;
            const editado = await repo.artefatos.criar({
              execucao_id: id,
              tipo: 'plano',
              contrato: 'plano.v1',
              editado_por_humano: true,
              conteudo: {
                ...base,
                ...dto.plano_editado,
                editado_pelo_operador: true,
              } as unknown as JsonLivre,
            });
            artefatoId = editado.id;
          }
          await repo.aprovacoes.registrar({
            execucao_id: id,
            tipo: 'plano',
            decisao: dto.plano_editado ? 'aprovado_com_edicao' : 'aprovado',
            artefato_id: artefatoId,
          });
        },
      },
    );
    return aceito(r.execucao);
  }

  async comentarPlano(id: string, texto: string): Promise<ComandoAceitoDto> {
    if (!texto.trim()) throw new ErroForja('entrada_invalida', 'comentário vazio', 400);
    const r = await this.n.transicionar(
      id,
      { tipo: 'comentar_plano' },
      {
        exigir: true,
        dentro: async (repo, e) => {
          await repo.comentarios.criar({
            execucao_id: id,
            alvo: 'plano',
            texto,
            ciclo_destino: e.ciclo_total + 1,
          });
        },
      },
    );
    return aceito(r.execucao);
  }

  async decidir(id: string, dto: DecidirDto): Promise<ComandoAceitoDto> {
    const n = this.n;
    if (dto.modo === 'perguntar_cliente') {
      const v = validarRespostaPublica(dto.texto_pergunta, 'pergunta');
      const pub = avaliarPublicacao(
        v,
        dto.publicar_mesmo_assim ? { motivos: chavesDosMotivos(v) } : null,
      );
      if (!pub.permitido) {
        throw new ErroForja(
          'entrada_invalida',
          'a pergunta não passou no validador de linguagem',
          422,
          v,
        );
      }
      await n.transicionar(
        id,
        { tipo: 'perguntar_cliente', texto_valido: true },
        {
          exigir: true,
          dentro: async (repo) => {
            await repo.aprovacoes.registrar({
              execucao_id: id,
              tipo: 'decisao',
              decisao: 'aprovado',
              texto_resposta: dto.texto_pergunta,
              comentario: 'perguntar_cliente',
            });
          },
        },
      );
      await this.outbox.criarRodadaPergunta(
        id,
        dto.texto_pergunta,
        dto.publicar_mesmo_assim ? chavesDosMotivos(v) : [],
      );
      await this.outbox.processarExecucao(id);
      this.clienteRespondeu.delete(id);
      return aceito((await n.carregar(id)).execucao);
    }
    const plano = await planoOficial(n, id);
    const linhas = dto.respostas.map((x) => {
      const q =
        x.tipo === 'pergunta'
          ? plano?.perguntas_ao_cliente[x.indice]?.pergunta
          : plano?.decisoes_do_operador[x.indice]?.questao;
      return `- ${q ?? `${x.tipo} ${x.indice + 1}`}: ${x.resposta}`;
    });
    const texto = `Decisões do operador:\n${linhas.join('\n')}`;
    const r = await n.transicionar(
      id,
      { tipo: 'operador_decidiu' },
      {
        exigir: true,
        dentro: async (repo, e) => {
          await repo.comentarios.criar({
            execucao_id: id,
            alvo: 'plano',
            texto,
            ciclo_destino: e.ciclo_total + 1,
          });
          await repo.aprovacoes.registrar({
            execucao_id: id,
            tipo: 'decisao',
            decisao: 'aprovado',
            comentario: texto,
          });
        },
      },
    );
    return aceito(r.execucao);
  }

  /** Cliente respondeu → `em_atendimento` → `planejando` com a resposta como dado (07 §8.2). */
  async replanejar(id: string): Promise<ComandoAceitoDto> {
    const n = this.n;
    const { execucao } = await n.carregar(id);
    if (execucao.estado === 'aguardando_cliente_resposta') {
      const respondeu =
        this.clienteRespondeu.has(id) || (await this.clienteRespondeuDesdePergunta(execucao));
      if (!respondeu) throw new ErroForja('conflito', 'o cliente ainda não respondeu', 409);
      await this.outbox.criarRodadaReplanejar(id);
      await this.outbox.processarExecucao(id);
      const depois = await n.carregar(id);
      if (depois.execucao.estado !== 'aguardando_cliente_resposta') return aceito(depois.execucao);
      const r = await n.transicionar(
        id,
        { tipo: 'replanejar', cliente_respondeu: true },
        { exigir: true },
      );
      this.clienteRespondeu.delete(id);
      return aceito(r.execucao);
    }
    const existeCommit = execucao.sha_atual !== null && execucao.sha_atual !== execucao.sha_base;
    const r = await n.transicionar(
      id,
      { tipo: 'replanejar', existe_commit: existeCommit },
      { exigir: true },
    );
    return aceito(r.execucao);
  }

  private async clienteRespondeuDesdePergunta(e: Execucao): Promise<boolean> {
    const pergunta = await this.n.banco.ler(async (r) =>
      (await r.outbox.listar(e.id))
        .filter((l) => l.passo === 'pergunta_publica' && l.estado === 'enviado')
        .at(-1),
    );
    if (!pergunta?.enviado_em) return false;
    const detalhe = await this.detalheChamado(e.conexao_id, e.chamado_id);
    return detalhe.mensagens.some(
      (m) => m.autor_papel === 'cliente' && (m.created_at ?? '') > (pergunta.enviado_em ?? ''),
    );
  }

  // -------------------------------------------------------------------------
  // Intervenção humana (03 §10)
  // -------------------------------------------------------------------------

  async pausar(id: string): Promise<ComandoAceitoDto> {
    const n = this.n;
    const e = (await n.carregar(id)).execucao;
    if (!ESTADOS_PAUSAVEIS.includes(e.estado)) {
      throw new ErroForja('conflito', `não dá para pausar em "${e.estado}"`, 409);
    }
    if (n.emCurso.has(id)) {
      const r = await n.transicionar(id, { tipo: 'pausar' }, { exigir: true });
      await interromperProcesso(n, id, 'pausa');
      await commitCheckpoint(
        e.worktree_dir as string,
        'forja: estado ao interromper',
        opcoesCheckpoint(e, e.config_snapshot),
      ).catch(() => null);
      return aceito(r.execucao);
    }
    if (this.tarefas.has(id) && !ESTADOS_COM_AGENTE.includes(e.estado)) {
      // Verificação/integração: vale ao fim do passo corrente (o app não interrompe um CAS ou push).
      n.pausasPendentes.add(id);
      return aceito(e);
    }
    // Etapa de agente SEM processo agora (prelúdio, entre dois turnos): pausa na
    // hora — `rodarTurno` confere o estado antes de cada spawn e não sobe o próximo.
    const r = await n.transicionar(id, { tipo: 'pausar' }, { exigir: true });
    return aceito(r.execucao);
  }

  /** Parar: escada completa no grupo → `pausado_usuario`. */
  async pararExecucao(id: string): Promise<ComandoAceitoDto> {
    const n = this.n;
    const e = (await n.carregar(id)).execucao;
    if (!n.emCurso.has(id)) return this.pausar(id);
    const r = await n.transicionar(id, { tipo: 'pausar' }, { exigir: true });
    await interromperProcesso(n, id, 'parar');
    await commitCheckpoint(
      e.worktree_dir as string,
      'forja: estado ao interromper',
      opcoesCheckpoint(e, e.config_snapshot),
    ).catch(() => null);
    return aceito(r.execucao);
  }

  async retomar(id: string, mesmoAssim = false): Promise<ComandoAceitoDto> {
    const r = await this.n.transicionar(
      id,
      { tipo: 'retomar', creditos_extras_autorizados: mesmoAssim },
      { exigir: true },
    );
    return aceito(r.execucao);
  }

  async conversar(id: string, texto: string): Promise<ComandoAceitoDto> {
    const n = this.n;
    const e = (await n.carregar(id)).execucao;
    if (e.estado !== 'pausado_usuario') {
      throw new ErroForja('conflito', 'converse com a etapa pausada (Pausar antes)', 409);
    }
    if (!texto.trim()) throw new ErroForja('entrada_invalida', 'mensagem vazia', 400);
    if (this.tarefas.has(id)) throw new ErroForja('conflito', 'a sessão está ocupada', 409);
    this.lancar(id, () => conversar(n, id, texto));
    return aceito(e);
  }

  /** Assumir (03 §10): PTY `claude --resume` (lock da sessão); nada do pipeline roda enquanto aberto. */
  async assumir(id: string): Promise<{ sessao_terminal_id: string; session_id: string }> {
    const n = this.n;
    const terminal = n.deps.terminal;
    if (!terminal) throw new ErroForja('nao_implementado', 'terminal indisponível', 501);
    const { execucao, config } = await n.carregar(id);
    const sessionId = execucao.session_id_condutor ?? execucao.session_id_planejador;
    if (!sessionId || !execucao.worktree_dir) {
      throw new ErroForja('pre_condicao_falhou', 'não há sessão para assumir', 409);
    }
    if (n.emCurso.has(id)) {
      await n.transicionar(id, { tipo: 'pausar' }).catch(() => null);
      await interromperProcesso(n, id, 'pausa');
    }
    const etapas = await n.banco.ler((r) => r.etapas.listar(id));
    const etapa = [...etapas].reverse().find((x) => x.session_id === sessionId);
    if (!etapa) throw new ErroForja('pre_condicao_falhou', 'nenhuma etapa da sessão', 409);
    const settings = `${n.dirExecucao(id)}/settings.${etapa.n}.json`;
    await n.transicionar(id, { tipo: 'assumir' }, { exigir: true });
    const info = terminal.assumir({
      session_id: sessionId,
      settings,
      modelo: config.modelos.condutor.modelo,
      cwd: execucao.worktree_dir,
      titulo: `#${execucao.numero} · ${etapa.tipo} (assumida)`,
      execucao_id: id,
      etapa_id: etapa.id,
    });
    // A linha de `sessao_terminal` usa o MESMO id do gerente de PTY (a UI navega
    // para `/terminal?sessao=<id>` e o WebSocket resolve pelo gerente).
    await n.banco.transacao(async (repo) => {
      const linha = await repo.terminais.abrir({
        tipo: 'assumida',
        cwd: execucao.worktree_dir as string,
        execucao_id: id,
        etapa_id: etapa.id,
        session_id_claude: sessionId,
        pid: info.pid,
        pgid: info.pid,
      });
      await repo.m.update(SessaoTerminalSchema, { id: linha.id }, { id: info.id });
    });
    return { sessao_terminal_id: info.id, session_id: sessionId };
  }

  /** Devolver (03 §10): PTY fechado → commit manual → `verificando` (ciclo_total += 1). */
  async devolver(id: string): Promise<ComandoAceitoDto> {
    const n = this.n;
    const { execucao } = await n.carregar(id);
    if (execucao.estado !== 'assumido_manual')
      throw new ErroForja('conflito', 'a execução não está assumida', 409);
    const sessao = await n.banco.ler((r) => r.terminais.assumidaAbertaDaExecucao(id));
    if (sessao && n.deps.terminal) {
      try {
        await n.deps.terminal.devolver(sessao.id);
      } catch {
        // Aba já fechada/devolvida no gerente: segue com o registro do banco.
      }
    }
    const dir = execucao.worktree_dir as string;
    let cp;
    try {
      cp = await commitCheckpoint(
        dir,
        MENSAGEM_MANUAL,
        opcoesCheckpoint(execucao, execucao.config_snapshot),
      );
    } catch (e) {
      if (e instanceof ErroCheckpointBranch) {
        throw new ErroForja(
          'pre_condicao_falhou',
          `${e.message}: volte para ${execucao.branch} antes de devolver`,
          409,
        );
      }
      throw e;
    }
    const head = await shaHead(dir);
    const r = await n.transicionar(
      id,
      { tipo: 'devolver', pty_fechado: true },
      {
        exigir: true,
        patch: { sha_atual: head },
        dentro: async (repo) => {
          if (sessao) await repo.terminais.encerrar(sessao.id, { sha_ao_devolver: head });
        },
      },
    );
    if (cp) {
      await n.publicar(
        {
          execucao_id: id,
          etapa_id: null,
          tipo: 'git.checkpoint',
          nivel: 'info',
          resumo: `Alterações manuais: ${cp.sha.slice(0, 8)}`,
          dados: { sha: cp.sha, passo: null, mensagem: cp.mensagem, arquivos: cp.arquivos },
        },
        'humano',
      );
    }
    return aceito(r.execucao);
  }

  /**
   * Integração em voo (03 §8.1): Descartar/Encerrar no meio de um passo de
   * integração deixaria o push seguir e o `mergeado` ser descartado em silêncio.
   */
  private async integracaoEmVoo(e: Execucao): Promise<boolean> {
    if (e.estado !== 'integrando') return false;
    if (this.tarefas.has(e.id)) return true;
    const item = await this.n.banco.ler((r) => r.filaMerge.ativoDaExecucao(e.id));
    return !!item && ['integrando', 'verificando', 'publicando'].includes(item.estado);
  }

  private async exigirSemIntegracaoEmVoo(e: Execucao): Promise<void> {
    if (await this.integracaoEmVoo(e)) {
      throw new ErroForja(
        'conflito',
        'a integração está em andamento: espere o passo terminar (o push pode já ter saído)',
        409,
      );
    }
  }

  /** Descartar (03 §2.4): qualquer não terminal antes de `mergeado`; rodada de descarte no outbox. */
  async descartar(id: string, dto: DescartarDto): Promise<ComandoAceitoDto> {
    const n = this.n;
    const { execucao, projeto } = await n.carregar(id);
    if (!ESTADOS_ANTES_DE_MERGEADO.includes(execucao.estado)) {
      throw new ErroForja(
        'conflito',
        'depois do merge não há descarte (o código já está no destino)',
        409,
      );
    }
    await this.exigirSemIntegracaoEmVoo(execucao);
    await this.encerrarProcessos(id);
    const r = await n
      .transicionar(
        id,
        { tipo: 'descartar' },
        {
          exigir: true,
          dentro: async (repo) => {
            await repo.aprovacoes.registrar({
              execucao_id: id,
              tipo: 'final',
              decisao: 'descartado',
              comentario: dto.motivo,
              patch_id: 'descartado',
              sha: execucao.sha_atual ?? execucao.sha_base ?? '0'.repeat(40),
            });
          },
        },
      )
      .catch(async (e: unknown) => {
        if (e instanceof ErroForja) throw e;
        // CHECK de aprovação final sem patch: registra só a transição.
        return n.transicionar(id, { tipo: 'descartar' }, { exigir: true });
      });
    await this.outbox.criarRodadaDescarte(id, dto.nota_interna, dto.motivo);
    await this.outbox.processarExecucao(id);
    if (dto.remover_worktree && execucao.worktree_dir) {
      await removerWorktree(projeto.repo_dir, execucao.worktree_dir, {
        dirDados: n.deps.dirDados,
        apagarBranch: execucao.branch,
      }).catch((e: unknown) => n.log(`remover worktree: ${String(e)}`));
    }
    return aceito(r.execucao);
  }

  /** Encerrar sem trabalho a preservar → `cancelado` (03 §2.2). */
  async encerrar(id: string, motivo: string): Promise<ComandoAceitoDto> {
    await this.exigirSemIntegracaoEmVoo((await this.n.carregar(id)).execucao);
    await this.encerrarProcessos(id);
    const r = await this.n.transicionar(id, { tipo: 'encerrar' }, { exigir: true });
    await this.outbox.criarRodadaDescarte(id, null, motivo);
    await this.outbox.processarExecucao(id);
    return aceito(r.execucao);
  }

  private async encerrarProcessos(id: string): Promise<void> {
    await interromperProcesso(this.n, id, 'cancelar').catch(() => false);
    const sessao = await this.n.banco.ler((r) => r.terminais.assumidaAbertaDaExecucao(id));
    if (sessao) {
      await this.n.deps.terminal?.fechar(sessao.id, { liberarLock: true }).catch(() => {});
      await this.n.banco.transacao((r) => r.terminais.encerrar(sessao.id));
    }
  }

  async tentarNovamente(id: string): Promise<ComandoAceitoDto> {
    const e = (await this.n.carregar(id)).execucao;
    if (e.estado === 'mergeado_pendente_chamado') {
      await this.outbox.tentarAgora(id);
      await this.outbox.processarExecucao(id);
      return aceito((await this.n.carregar(id)).execucao);
    }
    if (e.estado === 'precisa_humano' && e.motivo_estado === 'push_recusado') {
      const vigente = await this.n.banco.ler((r) => r.aprovacoes.vigente(id));
      const r = await this.n.transicionar(
        id,
        { tipo: 'tentar_merge_de_novo', aprovacao_vigente: vigente !== null },
        {
          exigir: true,
          dentro: async (repo) => {
            if (vigente && !(await repo.filaMerge.ativoDaExecucao(id))) {
              await repo.filaMerge.enfileirar({
                projeto_id: e.projeto_id,
                branch_destino: e.branch_destino,
                execucao_id: id,
                aprovacao_id: vigente.id,
              });
            }
          },
        },
      );
      return aceito(r.execucao);
    }
    this.naoAntesDe.delete(id);
    this.semProgresso.delete(id);
    const existeCommit = e.sha_atual !== null && e.sha_atual !== e.sha_base;
    const ultimaEtapa = (await this.n.banco.ler((r) => r.etapas.listar(id))).at(-1) ?? null;
    const r = await this.n.transicionar(
      id,
      {
        tipo: 'tentar_novamente',
        existe_commit: existeCommit,
        etapa_anterior: ultimaEtapa?.tipo ?? null,
      },
      {
        exigir: true,
        // `falhou` vindo de `integrando` (setup/ambiente): o item foi devolvido;
        // volta à fila com a aprovação vigente (03 §11 "Tentar de novo").
        dentro: async (repo, depois) => {
          if (depois.estado !== 'integrando') return;
          const vigente = await repo.aprovacoes.vigente(id);
          if (vigente && !(await repo.filaMerge.ativoDaExecucao(id))) {
            await repo.filaMerge.enfileirar({
              projeto_id: e.projeto_id,
              branch_destino: e.branch_destino,
              execucao_id: id,
              aprovacao_id: vigente.id,
            });
          }
        },
      },
    );
    return aceito(r.execucao);
  }

  /** `precisa_humano`: mais um ciclo, seguir com achados, replanejar (03 §2.4, §6). */
  async resolverPendencia(id: string, dto: ResolverPendenciaDto): Promise<ComandoAceitoDto> {
    const n = this.n;
    const { execucao, config } = await n.carregar(id);
    if (execucao.estado !== 'precisa_humano') throw new ErroForja('conflito', 'nada pendente', 409);
    if (execucao.motivo_estado === 'push_recusado' && dto.acao === 'mais_um_ciclo') {
      return this.tentarNovamente(id);
    }
    // Ações conforme `motivo_estado` (03 §2.4), conferidas no servidor.
    const etapas = await n.banco.ler((r) => r.etapas.listar(id));
    const existeCommit = execucao.sha_atual !== null && execucao.sha_atual !== execucao.sha_base;
    if (
      dto.acao === 'mais_um_ciclo' &&
      !maisUmCicloPermitido(execucao.motivo_estado, existeCommit, etapas)
    ) {
      throw new ErroForja(
        'pre_condicao_falhou',
        '"mais um ciclo" só com plano aprovado (nunca pula o G1 nem implementa plano não implementável)',
        409,
      );
    }
    if (dto.acao === 'seguir_com_achados' && !seguirComAchadosPermitido(execucao, etapas)) {
      throw new ErroForja(
        'pre_condicao_falhou',
        '"seguir com achados" só com o HEAD verificado e revisado (o relatório sairia sobre outro código)',
        409,
      );
    }
    let evento: EventoMaquina;
    switch (dto.acao) {
      case 'mais_um_ciclo':
        evento = {
          tipo: 'mais_um_ciclo',
          exige_confirmacao: maisUmCicloExigeConfirmacao(execucao, config.limites.ciclos),
          confirmado: dto.confirmar_orcamento === true,
        };
        break;
      case 'seguir_com_achados':
        evento = { tipo: 'seguir_com_achados' };
        break;
      case 'replanejar':
        evento = {
          tipo: 'replanejar',
          existe_commit: execucao.sha_atual !== null && execucao.sha_atual !== execucao.sha_base,
        };
        break;
    }
    const r = await n.transicionar(id, evento, {
      exigir: true,
      dentro: async (repo, e) => {
        if (dto.instrucao?.trim()) {
          await repo.comentarios.criar({
            execucao_id: id,
            alvo: dto.acao === 'replanejar' ? 'plano' : 'diff',
            texto: dto.instrucao,
            ciclo_destino: e.ciclo_total + 1,
          });
        }
      },
    });
    return aceito(r.execucao);
  }

  async cienteMensagem(id: string, mensagemId: string): Promise<ComandoAceitoDto> {
    const e = await this.n.banco.transacao((r) =>
      r.execucoes.atualizar(id, { ultima_mensagem_ciente_id: mensagemId }),
    );
    await this.n.publicar(
      {
        execucao_id: id,
        etapa_id: null,
        tipo: 'chamado.sinal',
        nivel: 'info',
        resumo: `#${e.numero}: "li a mensagem nova"`,
        dados: { numero: e.numero, sinal: 'mensagem_nova', detalhe: 'ciente registrado' },
      },
      'humano',
    );
    return aceito(e);
  }

  async recapturarPrints(id: string): Promise<ComandoAceitoDto> {
    const e = (await this.n.carregar(id)).execucao;
    if (this.tarefas.has(id)) throw new ErroForja('conflito', 'a execução está ocupada', 409);
    this.lancar(id, () => recapturarPrints(this.n, id));
    return aceito(e);
  }

  async reconhecerSentinela(id: string): Promise<ComandoAceitoDto> {
    const e = await this.n.banco.transacao(async (r) => {
      const atual = await r.execucoes.exigir(id);
      if (!atual.sentinela) throw new ErroForja('conflito', 'não há divergência da sentinela', 409);
      return r.execucoes.atualizar(id, {
        sentinela: { ...atual.sentinela, reconhecida_em: this.n.iso() },
      });
    });
    this.agendar();
    return aceito(e);
  }

  // -------------------------------------------------------------------------
  // G2 / G2' (03 §4; 06 §4.3) e pedir ajustes
  // -------------------------------------------------------------------------

  async aprovarFinal(
    id: string,
    dto: AprovarDto,
    ctxG2: ContextoAprovacaoFinal,
  ): Promise<ComandoAceitoDto> {
    const n = this.n;
    const { execucao } = await n.carregar(id);
    const v = validarRespostaPublica(dto.texto_resposta, ctxG2.tipo_resposta);
    const publicacao = avaliarPublicacao(
      v,
      dto.publicar_mesmo_assim ? { motivos: chavesDosMotivos(v) } : null,
    );
    const g2 = avaliarG2(ctxG2.contexto, {
      relatorio_artefato_id: dto.relatorio_artefato_id,
      patch_id: dto.patch_id,
      sha: dto.sha,
      ciente_mensagem_id: dto.ciente_mensagem_id ?? null,
      publicacao,
    });
    if (!g2.ok) {
      const patch = g2.erros.some(
        (e) => e.codigo === 'patch_id_divergente' || e.codigo === 'sha_divergente',
      );
      // FJ-034: só dado velho (409, a tela recarrega) ou resposta inválida — nunca exigência.
      throw new ErroForja(
        patch ? 'patch_id_divergente' : 'pre_condicao_falhou',
        g2.erros.map((e) => e.mensagem).join(' '),
        409,
        g2.erros,
      );
    }
    const editada = hashCorpo(dto.texto_resposta) !== ctxG2.corpo_hash_original;
    const r = await n.transicionar(
      id,
      { tipo: 'aprovar_final', exigencias_ok: true },
      {
        exigir: true,
        patch: g2.ciente_mensagem_id ? { ultima_mensagem_ciente_id: g2.ciente_mensagem_id } : {},
        dentro: async (repo) => {
          const ap = await repo.aprovacoes.registrar({
            execucao_id: id,
            tipo: g2.tipo,
            decisao: editada ? 'aprovado_com_edicao' : 'aprovado',
            artefato_id: dto.relatorio_artefato_id,
            patch_id: dto.patch_id,
            sha: dto.sha,
            texto_resposta: dto.texto_resposta,
            validacao_resposta: {
              tecnico: v.tecnico,
              promessa: v.promessa,
              lexico: v.lexico,
              disponibilidade: v.disponibilidade,
              ok: v.ok,
              publicar_mesmo_assim: dto.publicar_mesmo_assim,
            },
            aprovado_sem_prints: g2.aprovado_sem_prints,
            politica_status: dto.politica_status,
            ciente_mensagem_id: g2.ciente_mensagem_id,
          });
          await repo.filaMerge.enfileirar({
            projeto_id: execucao.projeto_id,
            branch_destino: execucao.branch_destino,
            execucao_id: id,
            aprovacao_id: ap.id,
          });
        },
      },
    );
    return aceito(r.execucao);
  }

  async pedirAjustes(
    id: string,
    comentario: string,
    arquivos: readonly string[] = [],
  ): Promise<ComandoAceitoDto> {
    const r = await this.n.transicionar(
      id,
      { tipo: 'pedir_ajustes', comentario },
      {
        exigir: true,
        dentro: async (repo, e) => {
          const alvos = arquivos.length ? arquivos : [null];
          for (const arquivo of alvos) {
            await repo.comentarios.criar({
              execucao_id: id,
              alvo: 'diff',
              arquivo,
              texto: comentario,
              ciclo_destino: e.ciclo_total + 1,
            });
          }
        },
      },
    );
    return aceito(r.execucao);
  }

  // -------------------------------------------------------------------------
  // Fila de merge e Gdeploy (03 §8, §9.4)
  // -------------------------------------------------------------------------

  async publicadoProducao(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.n.transicionar(
        id,
        { tipo: 'publicado_producao' },
        {
          exigir: true,
          dentro: async (repo) => {
            await repo.outbox.liberarRetidos(id);
            await repo.aprovacoes.registrar({
              execucao_id: id,
              tipo: 'publicado_producao',
              decisao: 'aprovado',
            });
          },
        },
      );
      await this.outbox.processarExecucao(id);
    }
  }

  liberarTokenSchema(projetoId: string): string | null {
    const s = this.n.vagas.semaforos.schema.ocupantes;
    for (const chave of Object.keys(s)) {
      if (!chave.startsWith(`${projetoId}\u0000`)) continue;
      const dono = s[chave]?.[0];
      if (dono) {
        this.n.vagas.soltarSchema(dono);
        this.agendar();
        return dono;
      }
    }
    return null;
  }

  async outboxTentarAgora(id: string): Promise<ComandoAceitoDto> {
    return this.tentarNovamente(id);
  }

  async reordenarItem(itemId: string, novaOrdem: number): Promise<void> {
    await this.n.banco.transacao(async (r) => {
      const item = await r.filaMerge.exigir(itemId);
      const fila = (await r.filaMerge.fila(item.projeto_id, item.branch_destino)).filter(
        (i) => i.estado === 'aguardando',
      );
      const ids = fila.map((i) => i.id).filter((x) => x !== itemId);
      ids.splice(Math.max(0, Math.min(ids.length, novaOrdem - 1)), 0, itemId);
      await r.filaMerge.reordenar(item.projeto_id, item.branch_destino, ids);
    });
  }

  // -------------------------------------------------------------------------
  // Polling do Chamados ligado aos sinais (07 §8; 03 §11)
  // -------------------------------------------------------------------------

  /** Um `PollingChamados` por conexão; os sinais viram badges e transições. */
  criarPolling(conexaoId: string, opcoes: { intervaloMs?: number } = {}): PollingChamados | null {
    const n = this.n;
    const fonte = n.fonte(conexaoId);
    if (!fonte) return null;
    return new PollingChamados({
      api: fonte.api,
      intervaloMs: opcoes.intervaloMs,
      identidade: () => fonte.identidade(),
      conexaoValida: () => fonte.podeUsar(),
      listarEmVoo: async () => this.alvosPolling(conexaoId),
      salvar: async (alvo, snap, detalhe) => {
        const sinais = sinaisDoDetalhe(detalhe);
        await n.banco.transacao(async (r) => {
          const cache = await r.chamados.obterPorChamado(conexaoId, alvo.chamado_ref);
          if (!cache) return;
          await r.chamados.gravarDaLista({
            conexao_id: conexaoId,
            chamado_id: alvo.chamado_ref,
            numero: detalhe.chamado.numero,
            titulo: detalhe.chamado.titulo,
            status: snap.status,
            natureza: detalhe.chamado.natureza,
            prioridade: detalhe.chamado.prioridade,
            atualizado_em_remoto: detalhe.chamado.updated_at,
          });
          await r.chamados.gravarDetalhe(cache.id, {
            sinais: {
              tem_spec_ia: sinais.tem_spec_ia,
              tem_diagnostico_ia: sinais.tem_diagnostico_ia,
              tem_pr_ia: sinais.tem_pr_ia,
              branch_ia: sinais.branch_ia,
            },
            ia_silenciada: snap.ia_silenciada,
            ultima_mensagem_id: snap.ultima_mensagem_id,
            ultima_mensagem_em: snap.ultima_mensagem_em,
          });
        });
      },
      emitir: async (alvo, sinais) => {
        const execs = await n.banco.ler((r) =>
          r.execucoes.listar({ conexao_id: conexaoId, chamado_id: alvo.chamado_ref, ativas: true }),
        );
        for (const s of sinais) {
          const exec = execs[0] ?? null;
          await n.publicar(
            {
              execucao_id: exec?.id ?? null,
              etapa_id: null,
              tipo: 'chamado.sinal',
              nivel: s.tipo === 'chamado_inacessivel' ? 'aviso' : 'info',
              resumo: paraEventoSinal(s, alvo.numero).detalhe,
              dados: paraEventoSinal(s, alvo.numero),
            },
            'chamados',
          );
          if (exec) await this.reagirAoSinal(exec, s);
        }
      },
    });
  }

  private async alvosPolling(conexaoId: string): Promise<AlvoPolling[]> {
    return this.n.banco.ler(async (r) => {
      const execs = await r.execucoes.listar({ conexao_id: conexaoId, ativas: true });
      const out: AlvoPolling[] = [];
      for (const e of execs) {
        const c = await r.chamados.obter(e.chamado_cache_id);
        out.push({
          chamado_ref: e.chamado_id,
          numero: e.numero,
          snapshot: c
            ? {
                status: c.status,
                ia_silenciada: c.ia_silenciada,
                ultima_mensagem_id: c.ultima_mensagem_id,
                ultima_mensagem_em: c.ultima_mensagem_em,
                branch_ia: c.sinais.branch_ia,
              }
            : null,
        });
      }
      return out;
    });
  }

  /**
   * Sinal → efeito (03 §11): badge, `chamado_mudou_no_servidor`. Sinais da IA
   * do servidor (`ia_reativada`, `pr_ia_apareceu`) são só o evento informativo
   * já publicado — nunca estado (FJ-031); o PR da IA continua como aviso no
   * plano (`trabalho_existente`) e no G2.
   */
  async reagirAoSinal(exec: Execucao, s: SinalChamado): Promise<void> {
    const n = this.n;
    switch (s.tipo) {
      case 'cliente_respondeu':
        this.clienteRespondeu.add(exec.id);
        return;
      case 'status_mudou': {
        const esperado =
          s.para === 'em_atendimento' ||
          (s.para === 'aguardando_cliente' && exec.estado === 'aguardando_cliente_resposta') ||
          (s.para === 'em_triagem' && exec.estado === 'aguardando_cliente_resposta') ||
          ((s.para === 'resolvido' || s.para === 'fechado') &&
            !ESTADOS_ANTES_DE_MERGEADO.includes(exec.estado));
        if (!esperado || s.terminal) {
          // `integrando`: o passo pode já ter feito o push — o outbox trata depois (03 §9.3).
          if (ESTADOS_ANTES_DE_MERGEADO.includes(exec.estado) && exec.estado !== 'integrando') {
            await this.pararAgenteSeRodando(exec.id);
            await n.transicionar(exec.id, {
              tipo: 'chamado_mudou_no_servidor',
              texto: `o chamado foi para "${s.para}" no servidor`,
            });
          }
        }
        return;
      }
      case 'chamado_inacessivel':
        if (ESTADOS_ANTES_DE_MERGEADO.includes(exec.estado) && exec.estado !== 'integrando') {
          await this.pararAgenteSeRodando(exec.id);
          await n.transicionar(exec.id, {
            tipo: 'chamado_mudou_no_servidor',
            texto: 'chamado inacessível',
          });
        }
        return;
      default:
        return;
    }
  }

  private async pararAgenteSeRodando(id: string): Promise<void> {
    if (this.n.emCurso.has(id))
      await interromperProcesso(this.n, id, 'cancelar').catch(() => false);
  }

  /** Para a fachada: há tarefa em voo? */
  ocupada(id: string): boolean {
    return this.tarefas.has(id);
  }

  /** G2' exige reaprovação? (fachada). */
  exigeReaprovacao(aprovado: string, integrado: string): boolean {
    return exigeReaprovacao(aprovado, integrado);
  }
}

function aceito(e: Pick<Execucao, 'id' | 'estado'>): ComandoAceitoDto {
  return { ok: true, execucao_id: e.id, estado: e.estado };
}

/** Mensagens novas do cliente desde o início da execução (G2 "li a mensagem nova"). */
export function mensagensNovasDoCliente(
  detalhe: RespostaDetalheChamado,
  desde: string | null,
): RespostaDetalheChamado['mensagens'] {
  return detalhe.mensagens.filter(
    (m) =>
      m.autor_papel === 'cliente' &&
      m.visibilidade !== 'interna' &&
      (!desde || (m.created_at ?? '') > desde),
  );
}

/**
 * Mensagens novas do cliente DEPOIS da última marcada como "li" (G2, 02 §4.6).
 * A ordem é a do servidor (`created_at`, depois a posição na lista) — nunca a
 * ordem lexicográfica do id, que é um UUID v4 aleatório. Ciente desconhecida
 * (apagada no servidor) → todas continuam novas.
 */
export function mensagensDepoisDaCiente(
  detalhe: RespostaDetalheChamado,
  e: Pick<Execucao, 'iniciado_em' | 'ultima_mensagem_ciente_id'>,
): RespostaDetalheChamado['mensagens'] {
  const novas = mensagensNovasDoCliente(detalhe, e.iniciado_em);
  if (!e.ultima_mensagem_ciente_id) return novas;
  const idxCiente = detalhe.mensagens.findIndex((m) => m.id === e.ultima_mensagem_ciente_id);
  if (idxCiente < 0) return novas;
  const corte = detalhe.mensagens[idxCiente]?.created_at ?? '';
  return novas.filter((m) => {
    const em = m.created_at ?? '';
    return em > corte || (em === corte && detalhe.mensagens.indexOf(m) > idxCiente);
  });
}
