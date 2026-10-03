import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  configProjetoDeResolvida,
  configResolvidaPadrao,
  type ConfigResolvida,
} from '../../comum/config-projeto';
import type { ClassificacaoProcesso } from '../../comum/estados';
import type { NovoEventoForja } from '../../comum/protocolo-eventos';
import type { PlanoV1, RelatorioV1, ResumoImplV1, VereditoV1 } from '../../comum/contratos';
import { ChamadosFalso, detalheFalso, mensagemFalsa } from '../chamados/servidor-falso.test-apoio';
import type { NomePerfil, ComandoClaude } from '../claude/perfis';
import type {
  EntradaProcesso,
  EventoRunner,
  ExecucaoProcesso,
  ResultadoProcesso,
  Runner,
} from '../claude/runner';
import type { ResultadoFinal } from '../claude/telemetria';
import { abrirBanco } from '../db/data-source';
import type { BancoForja } from '../db/banco';
import { BarramentoEventos } from '../eventos/barramento';
import { criarRepoTemporario, type RepoTemporario } from '../git/apoio-testes';
import type { PortaVerificacao } from './nucleo';
import { Orquestrador, type OpcoesOrquestrador } from './orquestrador';
import { ServicosForja } from './servicos';

/**
 * Apoio dos testes do orquestrador (specs/forja/03 §12): SQLite real em
 * diretório temporário, git REAL num repositório de brinquedo (com um `origin`
 * bare para o `merge_e_push`), o Chamados falso de `server/chamados` e um
 * RUNNER ROTEIRIZADO no lugar da CLI — nenhum teste chama o `claude` real nem
 * a rede. O roteiro é uma fila de turnos por perfil: cada turno pode mexer na
 * worktree (como o implementador faria), emitir checkpoint e devolver a saída
 * estruturada (ou outra classificação: cota, timeout, interrompido…).
 */

// ---------------------------------------------------------------------------
// Runner roteirizado
// ---------------------------------------------------------------------------

export interface ContextoTurno {
  perfil: NomePerfil;
  conversar: boolean;
  cwd: string;
  prompt: string;
  args: string[];
  head(): string;
}

export interface Turno {
  /** Edita a worktree antes de "terminar" (o implementador). */
  antes?: (ctx: ContextoTurno) => void | Promise<void>;
  /** Emite `checkpoint` (um implementador retornou) depois de `antes`. */
  checkpoint?: boolean;
  saida?: unknown | ((ctx: ContextoTurno) => unknown);
  classificacao?: ClassificacaoProcesso;
  custoUsd?: number;
  resetsAt?: string;
  /** Não termina até `liberar()` (pausa/assumir/crash no meio). */
  segurar?: boolean;
  eventos?: NovoEventoForja[];
  /**
   * T2 (FJ-032): por padrão o runner emite no stream um Bash (`tool_use` +
   * `tool_result`) para cada `comandos_executados` da saída, como a CLI faria
   * se o revisor rodasse os comandos. `true` = o revisor só DECLAROU.
   */
  semBash?: boolean;
}

/** `agente.ferramenta` Bash + `agente.resultado_ferramenta` (o que a CLI emite ao rodar um comando). */
export function eventosBash(comando: string, ok = true, id = `bash-${comando}`): NovoEventoForja[] {
  const autoria = { papel_agente: 'condutor' as const, parent_tool_use_id: null };
  return [
    {
      execucao_id: '',
      etapa_id: null,
      tipo: 'agente.ferramenta',
      nivel: 'info',
      resumo: `Bash: ${comando}`,
      dados: {
        ...autoria,
        tool_use_id: id,
        ferramenta: 'Bash',
        resumo_entrada: comando,
        subagente: null,
      },
    },
    {
      execucao_id: '',
      etapa_id: null,
      tipo: 'agente.resultado_ferramenta',
      nivel: ok ? 'info' : 'aviso',
      resumo: ok ? 'Resultado: ok' : 'Erro: Exit code 1',
      dados: { ...autoria, tool_use_id: id, erro: !ok, resumo: ok ? 'ok' : 'Exit code 1' },
    },
  ] as NovoEventoForja[];
}

export interface ChamadaRunner {
  perfil: NomePerfil;
  conversar: boolean;
  args: string[];
  prompt: string;
  sessionId: string;
}

export class RunnerRoteirizado implements Runner {
  readonly chamadas: ChamadaRunner[] = [];
  private readonly filas = new Map<string, Turno[]>();
  private seguros: (() => void)[] = [];
  private acumulado = new Map<string, number>();
  pid = 50_000;

  /** Enfileira turnos para um perfil (`conversa` = mensagens do humano). */
  roteiro(perfil: NomePerfil | 'conversa', ...turnos: Turno[]): this {
    this.filas.set(perfil, [...(this.filas.get(perfil) ?? []), ...turnos]);
    return this;
  }

  pendentes(perfil: NomePerfil | 'conversa'): number {
    return this.filas.get(perfil)?.length ?? 0;
  }

  liberarSegurados(): void {
    const s = this.seguros;
    this.seguros = [];
    for (const f of s) f();
  }

  chamadasDe(perfil: NomePerfil): ChamadaRunner[] {
    return this.chamadas.filter((c) => c.perfil === perfil && !c.conversar);
  }

  iniciar(comando: ComandoClaude, entrada: EntradaProcesso): ExecucaoProcesso {
    const perfil = comando.esperado.perfil;
    const conversar = comando.contrato === null;
    const chave = conversar ? 'conversa' : perfil;
    const fila = this.filas.get(chave) ?? [];
    const turno: Turno = fila.shift() ?? { classificacao: 'erro_execucao' };
    this.chamadas.push({
      perfil,
      conversar,
      args: comando.args,
      prompt: entrada.prompt,
      sessionId: comando.sessionId,
    });
    const ctx: ContextoTurno = {
      perfil,
      conversar,
      cwd: comando.cwd,
      prompt: entrada.prompt,
      args: comando.args,
      head: () =>
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: comando.cwd, encoding: 'utf8' }).trim(),
    };
    const pid = this.pid++;
    let parada: 'pausado' | 'cancelado' | null = null;
    let soltar: () => void = () => {};
    const segurado = turno.segurar
      ? new Promise<void>((ok) => {
          soltar = ok;
          this.seguros.push(ok);
        })
      : Promise.resolve();
    const eventos: EventoRunner[] = [];
    const resultado = (async (): Promise<ResultadoProcesso> => {
      await segurado;
      if (!parada && turno.antes) await turno.antes(ctx);
      if (!parada && turno.checkpoint)
        eventos.push({ tipo: 'checkpoint', toolUseId: `tu-${pid}`, emVoo: 0 });
      const classificacaoPrevia: ClassificacaoProcesso =
        parada ?? turno.classificacao ?? 'concluido';
      const saidaPrevia =
        classificacaoPrevia === 'concluido' && turno.saida !== undefined
          ? typeof turno.saida === 'function'
            ? (turno.saida as (c: ContextoTurno) => unknown)(ctx)
            : turno.saida
          : null;
      const bashT2 =
        perfil === 'condutor_t2' && !turno.semBash && saidaPrevia
          ? (
              (
                saidaPrevia as {
                  comandos_executados?: { comando: string; exit_code: number | null }[];
                }
              ).comandos_executados ?? []
            ).flatMap((c, i) => eventosBash(c.comando, c.exit_code === 0, `bash-${pid}-${i}`))
          : [];
      for (const ev of [...(turno.eventos ?? []), ...bashT2]) {
        eventos.push({
          tipo: 'evento',
          evento: {
            ...ev,
            execucao_id: entrada.execucaoId,
            etapa_id: entrada.etapaId,
          } as NovoEventoForja,
        });
      }
      const classificacao = classificacaoPrevia;
      const saida = saidaPrevia;
      const custo = (this.acumulado.get(comando.sessionId) ?? 0) + (turno.custoUsd ?? 0.1);
      this.acumulado.set(comando.sessionId, custo);
      const final: ResultadoFinal = {
        subtype: classificacao === 'concluido' ? 'success' : 'error_during_execution',
        is_error: classificacao !== 'concluido',
        terminal_reason: null,
        structured_output: saida,
        total_cost_usd: custo,
        usage: {},
        modelUsage: { [comando.esperado.modelo]: { costUSD: custo } },
        subagent_stats: null,
        num_turns: 3,
        duration_ms: 10,
        permission_denials: [],
        result_index: 0,
        texto: null,
      };
      return {
        classificacao,
        sessionId: comando.sessionId,
        contrato: comando.contrato,
        saida: classificacao === 'concluido' ? saida : null,
        errosContrato: [],
        final: classificacao === 'interrompido' ? null : final,
        totalResults: 1,
        resetsAt: turno.resetsAt ?? null,
        init: {
          ok: true,
          divergencias: [],
          versaoDivergente: false,
          agentesForaDoPapel: [],
          alertas: [],
          capabilities: [],
          recorte: {
            model: comando.esperado.modelo,
            tools: [...comando.esperado.ferramentas],
            permissionMode: comando.esperado.permissionMode,
            apiKeySource: 'none',
            mcp_servers: [],
            agents: [],
            claude_code_version: '2.1.288',
          },
        },
        agentesForaDoPapel: [],
        modelosInesperados: [],
        exitCode: classificacao === 'concluido' ? 0 : 1,
        sinal: null,
        duracaoMs: 10,
        stderrFinal: '',
      };
    })();
    const iteravel: AsyncIterable<EventoRunner> = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        let fim = false;
        void resultado.then(() => {
          fim = true;
        });
        return {
          next: async () => {
            for (;;) {
              if (i < eventos.length) return { value: eventos[i++]!, done: false };
              if (fim) {
                if (i < eventos.length) continue;
                return { value: undefined, done: true };
              }
              await new Promise((r) => setTimeout(r, 1));
            }
          },
        };
      },
    };
    return {
      sessionId: comando.sessionId,
      pid,
      pgid: pid,
      eventos: iteravel,
      pausar: async () => {
        parada = 'pausado';
        soltar();
        return resultado;
      },
      cancelar: async () => {
        parada = 'cancelado';
        soltar();
        return resultado;
      },
      resultado,
    };
  }
}

// ---------------------------------------------------------------------------
// Contratos de exemplo (válidos nas regras de 04 §6)
// ---------------------------------------------------------------------------

export function planoExemplo(p: Partial<PlanoV1> = {}): PlanoV1 {
  return {
    versao: 1,
    entendimento: 'O cliente quer que o relatório mostre o total do mês.',
    natureza_confirmada: 'alteracao',
    motivo_nao_implementavel: null,
    confianca: 'alta',
    justificativa_confianca: 'O código do relatório é simples e está isolado.',
    evidencias: ['src/app.ts:1'],
    suposicoes: [],
    perguntas_ao_cliente: [],
    decisoes_do_operador: [],
    criterios_de_aceite: [
      { id: 'CA1', descricao: 'O total aparece no relatório.', verificacao: 'unit' },
    ],
    passos: [
      {
        id: 'P1',
        descricao: 'Somar o total no relatório.',
        arquivos_previstos: ['src/app.ts', 'ok.txt'],
        depende_de: [],
      },
    ],
    arquivos_previstos: ['src/app.ts', 'ok.txt'],
    areas: ['regra_negocio'],
    telas_afetadas: [],
    regras_de_negocio: [],
    schema_banco: { altera: false, mudancas: [] },
    dependencias_previstas: [],
    plano_de_testes: { unit: ['testa o total'], e2e: [] },
    riscos: [],
    fora_de_escopo: [],
    trabalho_existente: {
      pr_ia_detectado: false,
      recomendacao: 'nao_se_aplica',
      motivo: 'Não há PR da IA.',
    },
    alertas_seguranca: [],
    ...p,
  };
}

export function resumoExemplo(ciclo = 1, arquivos = ['src/app.ts', 'ok.txt']): ResumoImplV1 {
  return {
    versao: 1,
    ciclo,
    passos: [
      {
        id: 'P1',
        status: 'concluido',
        executor: 'implementador',
        arquivos_alterados: arquivos,
        comandos: [],
        observacao: 'Total somado.',
      },
    ],
    desvios_do_plano: [],
    dependencias_adicionadas: [],
    telas_afetadas: [],
    achados_tratados: [],
    bloqueios: [],
    resumo_tecnico: 'Somei o total no relatório.',
  };
}

export function vereditoExemplo(sha: string, ciclo = 1, p: Partial<VereditoV1> = {}): VereditoV1 {
  return {
    versao: 1,
    ciclo,
    sha_avaliado: sha,
    revisores: ['revisor_correcao'],
    decisao: 'aprovado',
    recomendacao: 'seguir',
    motivo_recomendacao: 'Tudo certo com o diff.',
    achados: [],
    criterios: [
      { id: 'CA1', status: 'atendido', evidencia: 'Teste do total passou.', evidencia_ref: null },
    ],
    falhas_de_verificacao: [],
    fora_do_plano: [],
    comandos_executados: [{ comando: 'npm test', exit_code: 0, resumo: 'passou' }],
    alteracoes_sensiveis: [],
    instrucoes_para_retrabalho: '',
    ...p,
  };
}

export function reprovadoExemplo(sha: string, ciclo: number, descricao: string): VereditoV1 {
  return vereditoExemplo(sha, ciclo, {
    decisao: 'reprovado',
    recomendacao: 'retrabalhar',
    motivo_recomendacao: 'O total não considera descontos.',
    achados: [
      {
        id: 'A1',
        revisor: 'revisor_correcao',
        severidade: 'bloqueante',
        categoria: 'correcao',
        arquivo: 'src/app.ts',
        linha: 3,
        descricao,
        sugestao: 'Subtraia os descontos antes de somar.',
      },
    ],
    criterios: [
      {
        id: 'CA1',
        status: 'nao_atendido',
        evidencia: 'O total ignora descontos.',
        evidencia_ref: null,
      },
    ],
    instrucoes_para_retrabalho: 'Considere os descontos no total.',
  });
}

export const TEXTO_RESPOSTA =
  'Olá, Maria! O total do mês passa a aparecer no relatório. A mudança será liberada na próxima atualização do sistema e avisaremos você por aqui.';

export function relatorioExemplo(p: Partial<RelatorioV1> = {}): RelatorioV1 {
  return {
    versao: 1,
    titulo: 'Total do mês no relatório',
    resumo: 'O relatório passa a mostrar o total do mês.',
    o_que_muda_para_quem_usa: ['Quem abre o relatório vê o total do mês no rodapé.'],
    suposicoes_assumidas: [],
    regras_de_negocio_alteradas: {
      houve: false,
      itens: [],
      declaracao: 'Nenhuma regra de negócio mudou.',
    },
    alteracoes_no_schema_do_banco: {
      houve: false,
      itens: [],
      declaracao: 'O banco de dados não foi alterado.',
      exige_migracao_no_deploy: false,
    },
    alteracoes_de_interface: { houve: false, telas: [], declaracao: 'Nenhuma tela foi alterada.' },
    como_foi_testado: { cenarios: [{ criterio: 'CA1', resultado: 'ok', evidencia_ref: null }] },
    como_testar_manualmente: ['Abra o relatório e confira o total no rodapé.'],
    riscos_e_o_que_observar: [],
    o_que_nao_foi_feito: [],
    dependencias_novas: [],
    mudou_desde_a_ultima_versao: null,
    resposta_ao_cliente: {
      versao: 1,
      tipo: 'aguardando_publicacao',
      corpo_markdown: TEXTO_RESPOSTA,
      cita_prazo: false,
    },
    ...p,
  };
}

// ---------------------------------------------------------------------------
// Ambiente completo
// ---------------------------------------------------------------------------

export interface AmbienteOrquestrador {
  repo: RepoTemporario;
  remoto: string;
  banco: BancoForja;
  barramento: BarramentoEventos;
  chamados: ChamadosFalso;
  runner: RunnerRoteirizado;
  orq: Orquestrador;
  projetoId: string;
  conexaoId: string;
  config: ConfigResolvida;
  relogio: { agora: Date; avancar(ms: number): void };
  limpar(): Promise<void>;
}

export interface OpcoesAmbiente {
  config?: (c: ConfigResolvida) => ConfigResolvida;
  chamados?: number[];
  verificacao?: Partial<PortaVerificacao>;
  orquestrador?: Partial<OpcoesOrquestrador>;
}

export async function montarAmbiente(op: OpcoesAmbiente = {}): Promise<AmbienteOrquestrador> {
  const repo = criarRepoTemporario();
  // Remoto bare: o `merge_e_push` empurra para cá (nunca a rede).
  const remoto = join(repo.raiz, 'remoto.git');
  mkdirSync(remoto);
  repo.g(['init', '-q', '--bare', '-b', 'main'], remoto);
  repo.g(['remote', 'add', 'origin', remoto]);
  repo.g(['push', '-q', 'origin', 'main']);

  const relogio = {
    agora: new Date('2026-10-02T12:00:00.000Z'),
    avancar(ms: number) {
      this.agora = new Date(this.agora.getTime() + ms);
    },
  };
  const banco = await abrirBanco({ dirDados: repo.dados }, { relogio: () => relogio.agora });
  const barramento = new BarramentoEventos({ agora: () => relogio.agora });
  const chamados = new ChamadosFalso();
  chamados.agora = relogio.agora.toISOString();
  for (const numero of op.chamados ?? [12]) {
    chamados.adicionar({
      detalhe: detalheFalso({
        numero,
        id: `uuid-${numero}`,
        status: 'em_atendimento',
        sistema_nome: 'ERP',
      }),
      mensagens: [
        mensagemFalsa({
          corpo: 'O relatório precisa mostrar o total do mês.',
          autor_papel: 'cliente',
          autor_nome: 'Maria Souza',
          visibilidade: 'publica',
        }),
      ],
    });
  }
  const cliente = chamados.cliente();
  let config = configResolvidaPadrao({
    dir: repo.repo,
    remoto: 'origin',
    branch_destino: 'main',
    prefixo_branch: 'forja/',
  });
  config.comandos.verificacao = [{ nome: 'teste', comando: 'test -f ok.txt', timeout_s: 30 }];
  config = op.config ? op.config(config) : config;
  const { conexaoId, projetoId } = await banco.transacao(async (r) => {
    const conexao = await r.conexoes.criar({
      nome: 'acme',
      url_base: 'https://suporte.acme.com',
      ambiente: 'dev',
      email: 'forja@acme.com',
      local_senha: 'keyring',
    });
    const projeto = await r.projetos.criar({
      nome: 'ERP',
      slug: 'erp',
      conexao_id: conexao.id,
      config: configProjetoDeResolvida('ERP', config),
    });
    await r.projetos.definirSistemas(projeto.id, [{ sistema_nome: 'ERP' }]);
    return { conexaoId: conexao.id, projetoId: projeto.id };
  });
  const runner = new RunnerRoteirizado();
  let sessao = 0;
  const orq = new Orquestrador({
    banco,
    barramento,
    runner,
    dirDados: repo.dados,
    agora: () => relogio.agora,
    novoSessionId: () => `00000000-0000-4000-8000-${String(++sessao).padStart(12, '0')}`,
    envOrigem: { PATH: process.env.PATH, HOME: process.env.HOME },
    intervaloTickMs: 0,
    sondar: () => 'morto',
    verificacao: { ...op.verificacao },
    chamados: () => ({
      api: cliente,
      identidade: () => ({ usuarioId: chamados.usuario.id, nome: chamados.usuario.nome }),
      d036: () => chamados.d036,
      podeUsar: () => true,
      urlBase: 'https://suporte.acme.com',
    }),
    ...op.orquestrador,
  });
  return {
    repo,
    remoto,
    banco,
    barramento,
    chamados,
    runner,
    orq,
    projetoId,
    conexaoId,
    config,
    relogio,
    async limpar() {
      await orq.parar();
      await banco.fechar();
      repo.limpar();
    },
  };
}

/** Roteiro padrão de um ciclo completo feliz (J1). */
export function roteiroFeliz(runner: RunnerRoteirizado, plano: PlanoV1 = planoExemplo()): void {
  runner
    .roteiro('planejador', { saida: plano })
    .roteiro('condutor_t1', {
      antes: (c) => {
        mkdirSync(c.cwd, { recursive: true });
        execFileSync(
          'sh',
          ['-c', 'echo ok > ok.txt && echo "export const total = 1;" >> src/app.ts'],
          { cwd: c.cwd },
        );
      },
      checkpoint: true,
      saida: resumoExemplo(),
    })
    .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
    .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
}

/**
 * Relatório com a ref do comando que o revisor rodou e o stream confirmou
 * (`comando:1@<sha8>`, FJ-032; 04 §6: refs fora da lista são recusadas).
 */
export function relatorioComRef(sha: string, p: Partial<RelatorioV1> = {}): RelatorioV1 {
  return relatorioExemplo({
    como_foi_testado: {
      cenarios: [
        { criterio: 'CA1', resultado: 'ok', evidencia_ref: `comando:1@${sha.slice(0, 8)}` },
      ],
    },
    ...p,
  });
}

// ---------------------------------------------------------------------------
// Fachada
// ---------------------------------------------------------------------------

export function servicos(a: AmbienteOrquestrador): ServicosForja {
  return new ServicosForja({
    orq: a.orq,
    versao: '0.0.0',
    modo: 'dev',
    iniciadoEm: a.relogio.agora.toISOString(),
  });
}

/** Aprova pelo caminho da UI (FJ-034: um clique, sem exigências). */
export async function aprovarG2(
  a: AmbienteOrquestrador,
  id: string,
  extra: { texto?: string } = {},
) {
  const s = servicos(a);
  const ap = await s.aprovacao_obter({ id });
  return s.aprovacao_aprovar(
    { id },
    {
      relatorio_artefato_id: ap.relatorio_artefato_id,
      patch_id: ap.patch_id,
      sha: ap.sha,
      texto_resposta: extra.texto ?? ap.resposta.corpo_markdown,
      politica_status: ap.politica_padrao,
      publicar_mesmo_assim: false,
      ciente_mensagem_id: ap.mensagens_novas_cliente.at(-1)?.id ?? null,
    },
  );
}
