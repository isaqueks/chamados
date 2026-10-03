import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConfigProjetoSchema,
  configuracoesGlobaisPadrao,
  detectadoVazio,
  nomeDaPasta,
  type ConfigProjeto,
  type ConfiguracoesGlobais,
} from '../../comum/config-projeto';
import type {
  PlanoRegistrado,
  RelatorioRegistrado,
  RespostaRegistrada,
  ResumoImplRegistrado,
  VereditoRegistrado,
} from '../../comum/contratos';
import {
  ROTAS_API,
  type ChamadoResumoDto,
  type ConexaoDto,
  type DiagnosticoDto,
  type DiffArquivoDto,
  type DiffDto,
  type EntradaRota,
  type EtapaDto,
  type EvidenciaTelaDto,
  type ExecucaoDto,
  type ExecucaoResumoDto,
  type FilaMergeDestinoDto,
  type ItemFilaMergeDto,
  type MensagemClienteDto,
  type NoTrilhaDto,
  type NomeRota,
  type ParametrosRota,
  type PassoPlanoDto,
  type PlanoExecucaoDto,
  type PreCondicaoDto,
  type ProjetoDto,
  type SistemaCasadoDto,
  type SaidaRota,
  type SeloArquivo,
  type SessaoTerminalDto,
  type TesteConexaoDto,
  type WorktreeDto,
} from '../../comum/dto';
import {
  contaEmAguardandoVoce,
  GRUPO_ESTADO_EXECUCAO,
  type EstadoExecucao,
  type ModoForja,
} from '../../comum/estados';
import type { RespostaDetalheChamado } from '@chamados/cliente-api';
import { erroDeExcecao } from '../chamados/conexao';
import { avaliarG0, consultarFila, resolverProjeto } from '../chamados/fila';
import { montarNotaConclusao } from '../chamados/notas';
import { sinaisParaDto } from '../chamados/sinais';
import { avaliarPublicacao, validarRespostaPublica } from '../chamados/validador-linguagem';
import type { ChamadoCache } from '../db/entidades/chamado-cache';
import type { Etapa } from '../db/entidades/etapa';
import type { Execucao } from '../db/entidades/execucao';
import type { Projeto } from '../db/entidades/projeto';
import { SessaoTerminalSchema } from '../db/entidades/sessao-terminal';
import { ErroConfiguracoes } from '../configuracoes/armazem';
import { configDoProjeto } from '../db/repositorios/projeto';
import {
  autodetectarProjeto,
  casarSistemas,
  ErroRepositorio,
  montarCasamento,
  raizDoRepositorio,
  sistemasDoProjeto,
  type SistemaDoChamados,
} from '../projetos/autodeteccao';
import {
  detectarOrfas,
  git,
  listarWorktrees,
  preChecarConflito,
  removerWorktree,
  resolverSha,
  selosDoDiff,
} from '../git';
import type { GerenteSessoesTerminal } from '../terminal/sessoes';
import { motivoGeralDoMotivo } from '../verificacao';
import { capturarUrlRemoto } from './fila-merge';
import {
  acoesDisponiveis,
  achadosEmAberto,
  maisUmCicloPermitido,
  seguirComAchadosPermitido,
  sha8,
} from './aplicacao-resultados';
import { planoComUi } from './etapas';
import { avaliarFreio, LIMIARES_PADRAO, montarCotaDto } from './freio-cota';
import { avisosG2, type ContextoG2 } from './gates';
import { arquivosEmComum, chaveDestino, faseDoLote, montarMesa, planoLimpo } from './lote';
import { estadoTerminal } from './maquina-execucao';
import { ErroForja, naoEncontrado } from './nucleo';
import {
  mensagensDepoisDaCiente,
  type ContextoAprovacaoFinal,
  type Orquestrador,
} from './orquestrador';

/**
 * Fachada tipada que as rotas HTTP chamam (specs/forja/06; `comum/dto.ts`
 * `ROTAS_API`): UMA função por rota JSON, devolvendo exatamente o DTO de saída
 * — a próxima fase só liga `HTTP → fachada`. Erros saem como `ErroForja`
 * (`codigo` estável de `CodigoErroApi` + status HTTP), que o registrador de
 * rotas traduz em `ErroApiDto`.
 *
 * POR QUE `FachadaJson` é um tipo mapeado sobre `ROTAS_API`: se uma rota JSON
 * nova entrar no contrato e não houver função aqui, o typecheck quebra (o mesmo
 * truque de `HandlersRotas`). Rotas `sse`/`ws`/`binario` têm auxiliares à parte
 * (`imagemEvidencia`, `logArtefato`); o SSE e o WebSocket usam o barramento e o
 * gerente de PTY diretamente.
 *
 * A fachada LÊ e monta DTOs; quem MUDA estado é o orquestrador (comandos) ou o
 * banco direto quando não há máquina envolvida (projeto, conexão, lembrete).
 */

type RotaJson = {
  [N in NomeRota]: (typeof ROTAS_API)[N]['transporte'] extends 'json' ? N : never;
}[NomeRota];

export type FachadaJson = {
  [N in RotaJson]: (params: ParametrosRota<N>, entrada: EntradaRota<N>) => Promise<SaidaRota<N>>;
};

/** Conexões com o Chamados: estado da sessão e ações de tela (produção: `ConexaoChamados`). */
export interface PortaConexoes {
  estado(conexaoId: string): {
    estado: ConexaoDto['estado'];
    erro: ConexaoDto['erro'];
    avisos: string[];
  };
  /** Senha ao keyring/arquivo 0600 (05 §8); nunca volta em DTO. */
  guardarSenha(conexaoId: string, senha: string, local: ConexaoDto['local_senha']): Promise<void>;
  testar(conexaoId: string): Promise<TesteConexaoDto>;
  relogar(conexaoId: string, senha?: string): Promise<TesteConexaoDto>;
  esquecer(conexaoId: string): Promise<void>;
  /** A conexão mudou (URL/email): descarta a sessão em memória. */
  recarregar(conexaoId: string): void;
}

export interface PortaDiagnostico {
  obter(): Promise<DiagnosticoDto>;
  rodar(): Promise<DiagnosticoDto>;
  aceitarVersaoCli(versao: string): Promise<DiagnosticoDto>;
}

export interface DepsServicos {
  orq: Orquestrador;
  versao: string;
  modo: ModoForja;
  iniciadoEm: string;
  conexoes?: PortaConexoes;
  diagnostico?: PortaDiagnostico;
  terminal?: GerenteSessoesTerminal | null;
}

/** "Portal do Cliente" → `portal-do-cliente` (slug do projeto, 02 §4.2). */
export function slugDe(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const naoDisponivel = (o_que: string) =>
  new ErroForja('nao_implementado', `${o_que} não está disponível nesta instância`, 501);

const PASSO_TRILHA: { chave: NoTrilhaDto['chave']; estados: readonly EstadoExecucao[] }[] = [
  { chave: 'preparar', estados: ['na_fila', 'preparando'] },
  { chave: 'planejar', estados: ['planejando', 'plano_pronto', 'aguardando_plano'] },
  { chave: 'decisao', estados: ['aguardando_decisao', 'aguardando_cliente_resposta'] },
  { chave: 'implementar', estados: ['implementando', 'retrabalho_humano'] },
  { chave: 'verificar', estados: ['verificando'] },
  { chave: 'revisar', estados: ['revisando'] },
  { chave: 'relatar', estados: ['relatando'] },
  { chave: 'aprovacao', estados: ['aguardando_aprovacao'] },
  { chave: 'merge', estados: ['na_fila_merge', 'integrando', 'resolvendo_conflito', 'mergeado'] },
  {
    chave: 'chamados',
    estados: ['comunicando', 'mergeado_pendente_chamado', 'aguardando_deploy', 'concluido'],
  },
];

const TIPO_ETAPA_TRILHA: Partial<Record<Etapa['tipo'], NoTrilhaDto['chave']>> = {
  planejar: 'planejar',
  implementar: 'implementar',
  verificar: 'verificar',
  revisar: 'revisar',
  relatar: 'relatar',
  integrar: 'merge',
};

function indiceTrilha(estado: EstadoExecucao): number {
  return PASSO_TRILHA.findIndex((p) => p.estados.includes(estado));
}

function resumoChamado(c: ChamadoCache | null, e?: Execucao): ChamadoResumoDto {
  return {
    chamado_id: c?.chamado_id ?? e?.chamado_id ?? '',
    numero: c?.numero ?? e?.numero ?? 0,
    titulo: c?.titulo ?? `Chamado #${e?.numero ?? '?'}`,
    status: c?.status ?? 'em_atendimento',
    natureza: c?.natureza ?? 'alteracao',
    prioridade: c?.prioridade ?? 'media',
    complexidade: c?.complexidade ?? null,
    sistema_nome: c?.sistema_nome ?? null,
    atualizado_em_remoto: c?.atualizado_em_remoto ?? null,
  };
}

function etapaDto(e: Etapa): EtapaDto {
  return {
    id: e.id,
    n: e.n,
    ciclo: e.ciclo,
    tipo: e.tipo,
    papel: e.papel,
    estado: e.estado,
    motivo_fim: e.motivo_fim,
    session_id: e.session_id,
    retomada: e.retomada,
    modelo: e.modelo,
    inicio: e.inicio,
    fim: e.fim,
    custo_micro_usd: e.custo_micro_usd,
    negacoes: Array.isArray(e.permission_denials) ? e.permission_denials.length : 0,
    condutor_editou: e.condutor_editou,
  };
}

function mensagemCliente(m: RespostaDetalheChamado['mensagens'][number]): MensagemClienteDto {
  return {
    id: m.id,
    autor_nome: m.autor_nome ?? '(sem nome)',
    em: m.created_at ?? '',
    corpo_markdown: m.corpo,
    dado_do_cliente: true,
  };
}

function hojeIso(agora: Date): string {
  return agora.toISOString().slice(0, 10);
}

export class ServicosForja implements FachadaJson {
  /** Último erro de `fila_sincronizar` por conexão (FJ-031: a Fila mostra o erro real). */
  private readonly errosSincronizacao = new Map<string, { codigo: string; mensagem: string }>();

  constructor(private readonly deps: DepsServicos) {}

  /**
   * Por que a fila está no cache (null = a conexão responde). Conexão ainda
   * não carregada, sessão inutilizável ou a última sincronização falhou.
   */
  private erroDaConexao(conexaoId: string): { codigo: string; mensagem: string } | null {
    const fonte = this.n.fonte(conexaoId);
    if (!fonte) {
      return { codigo: 'outro', mensagem: 'A conexão com o Chamados ainda não foi carregada.' };
    }
    if (!fonte.podeUsar()) {
      return (
        fonte.erro?.() ?? {
          codigo: 'outro',
          mensagem: 'A sessão com o Chamados não está válida.',
        }
      );
    }
    return this.errosSincronizacao.get(conexaoId) ?? null;
  }

  private get orq(): Orquestrador {
    return this.deps.orq;
  }

  private get banco() {
    return this.deps.orq.n.banco;
  }

  private get n() {
    return this.deps.orq.n;
  }

  // -------------------------------------------------------------------------
  // Montagem de DTOs comuns
  // -------------------------------------------------------------------------

  private async exec(id: string): Promise<Execucao> {
    const e = await this.banco.ler((r) => r.execucoes.obter(id));
    if (!e) throw naoEncontrado('execução');
    return e;
  }

  private async retomaEm(e: Execucao): Promise<string | null> {
    if (e.estado !== 'pausado_cota') return null;
    return (await this.orq.freio()).ate;
  }

  async resumoExecucao(e: Execucao): Promise<ExecucaoResumoDto> {
    const n = this.n;
    const [etapas, plano] = await Promise.all([
      this.banco.ler((r) => r.etapas.listar(e.id)),
      this.banco.ler((r) => r.artefatos.ultimaVersao(e.id, 'plano')),
    ]);
    const p = plano?.conteudo as unknown as PlanoRegistrado | null;
    const feitos = etapas.filter(
      (x) => x.tipo === 'implementar' && x.estado === 'concluida',
    ).length;
    const ultima = [...etapas].reverse().find((x) => x.tipo !== 'conversar');
    const prevUi = planoComUi(p, e.config_snapshot);
    return {
      id: e.id,
      numero: e.numero,
      tentativa: e.tentativa,
      estado: e.estado,
      grupo: GRUPO_ESTADO_EXECUCAO[e.estado],
      estado_anterior: e.estado_anterior,
      motivo_estado: e.motivo_estado,
      etapa_atual: ultima?.estado === 'executando' ? ultima.tipo : null,
      progresso: p ? { feitos: Math.min(feitos, p.passos.length), total: p.passos.length } : null,
      ciclo_auto: e.ciclo_auto,
      ciclo_total: e.ciclo_total,
      custo_micro_usd: e.custo_micro_usd,
      altera_ui: (e.selos?.altera_ui ?? false) || prevUi,
      ...(p ? { telas_ui: p.telas_afetadas.length } : {}),
      evidencia_visual: e.evidencia_visual,
      retoma_em: await this.retomaEm(e),
      atualizado_em: e.atualizado_em,
    };
    void n;
  }

  private trilha(e: Execucao, etapas: readonly Etapa[]): NoTrilhaDto[] {
    const atual = indiceTrilha(
      estadoTerminal(e.estado) || PASSO_TRILHA.every((p) => !p.estados.includes(e.estado))
        ? (e.estado_anterior ?? e.estado)
        : e.estado,
    );
    const lateral = PASSO_TRILHA.some((p) => p.estados.includes(e.estado)) ? null : e.estado;
    const ui = e.selos?.altera_ui ?? false;
    return PASSO_TRILHA.map((p, i) => {
      const daChave = etapas.filter((x) => TIPO_ETAPA_TRILHA[x.tipo] === p.chave);
      const duracao = daChave.reduce(
        (s, x) => s + (x.fim ? Date.parse(x.fim) - Date.parse(x.inicio) : 0),
        0,
      );
      const custo = daChave.reduce((s, x) => s + (x.custo_micro_usd ?? 0), 0);
      let estado: NoTrilhaDto['estado'] =
        e.estado === 'concluido'
          ? 'feito'
          : i < atual
            ? 'feito'
            : i === atual
              ? 'atual'
              : 'pendente';
      if (p.chave === 'decisao' && i < atual && !etapas.length) estado = 'pulado';
      if (i === atual && (e.estado === 'falhou' || e.estado === 'precisa_humano'))
        estado = 'falhou';
      const ev = etapas.filter((x) => x.tipo === 'evidenciar');
      return {
        chave: p.chave,
        estado,
        duracao_ms: daChave.length ? duracao : null,
        custo_micro_usd: daChave.length ? custo : null,
        modelo: daChave.at(-1)?.modelo ?? null,
        subnos:
          ui && (p.chave === 'implementar' || p.chave === 'verificar')
            ? [
                {
                  chave: p.chave === 'implementar' ? 'prints_antes' : 'prints_depois',
                  estado: ev.some(
                    (x) => x.telas?.momento === (p.chave === 'implementar' ? 'antes' : 'depois'),
                  )
                    ? 'feito'
                    : 'pendente',
                  detalhe: null,
                },
              ]
            : [],
        lateral: i === atual ? lateral : null,
      };
    });
  }

  private async planoDto(e: Execucao): Promise<PlanoExecucaoDto | null> {
    const dados = await this.banco.ler(async (r) => ({
      plano: await r.artefatos.ultimaVersao(e.id, 'plano'),
      aprovs: await r.aprovacoes.listar(e.id, { tipo: 'plano' }),
      etapas: await r.etapas.listar(e.id),
    }));
    if (!dados.plano) return null;
    const p = dados.plano.conteudo as unknown as PlanoRegistrado;
    const implementou = dados.etapas.some(
      (x) => x.tipo === 'implementar' && x.estado === 'concluida',
    );
    const passos: PassoPlanoDto[] = p.passos.map((ps) => ({
      id: ps.id,
      descricao: ps.descricao,
      estado: implementou ? 'feito' : e.estado === 'implementando' ? 'em_andamento' : 'pendente',
      sha_commit: null,
    }));
    return {
      artefato_id: dados.plano.id,
      versao: dados.plano.versao,
      plano: p,
      editado_por_humano: dados.plano.editado_por_humano,
      aprovado_em: dados.aprovs.at(-1)?.criado_em ?? null,
      passos,
    };
  }

  private async detalheOuNulo(e: Execucao): Promise<RespostaDetalheChamado | null> {
    const fonte = this.n.fonte(e.conexao_id);
    if (!fonte || !fonte.podeUsar()) return null;
    try {
      return await fonte.api.obterChamado(e.chamado_id, { formato: 'markdown' });
    } catch {
      return null;
    }
  }

  private async preCondicoes(c: ChamadoCache): Promise<PreCondicaoDto[]> {
    const fonte = this.n.fonte(c.conexao_id);
    const mapeamentos = await this.banco.ler((r) =>
      r.projetos.listarTodosMapeamentos(c.conexao_id),
    );
    const ativa = await this.banco.ler((r) =>
      r.execucoes.ativaDoChamado(c.conexao_id, c.chamado_id),
    );
    const resol = resolverProjeto(
      { sistema_nome: c.sistema_nome, sistema_alvo_id: c.sistema_alvo_id },
      mapeamentos,
    );
    return avaliarG0({
      chamado: { status: c.status, natureza: c.natureza },
      projeto: resol,
      execucaoAtiva: ativa !== null,
      conexaoOk: fonte?.podeUsar() ?? false,
      pipelineDesbloqueado: this.n.cliCompativel(),
      prIa: null,
    }).pre_condicoes;
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  async saude(): Promise<SaidaRota<'saude'>> {
    return {
      ok: true,
      versao: this.deps.versao,
      modo: this.deps.modo,
      iniciado_em: this.deps.iniciadoEm,
    };
  }

  private async cotaECusto() {
    const agora = this.n.agora();
    const leitura = await this.banco.ler((r) => r.usoAssinatura.ultimo());
    const cota = montarCotaDto(
      leitura ? { ...leitura, medido_em: leitura.criado_em } : null,
      LIMIARES_PADRAO,
      agora,
    );
    const hoje = hojeIso(agora);
    const ativas = await this.banco.ler((r) => r.execucoes.listar());
    const porModelo = new Map<string, number>();
    const porExec: { execucao_id: string; numero: number; micro_usd: number }[] = [];
    let total = 0;
    for (const e of ativas) {
      const etapas = await this.banco.ler((r) => r.etapas.listar(e.id));
      let soma = 0;
      for (const x of etapas) {
        if (!x.inicio.startsWith(hoje) || !x.custo_micro_usd) continue;
        soma += x.custo_micro_usd;
        porModelo.set(x.modelo ?? '?', (porModelo.get(x.modelo ?? '?') ?? 0) + x.custo_micro_usd);
      }
      if (soma > 0) porExec.push({ execucao_id: e.id, numero: e.numero, micro_usd: soma });
      total += soma;
    }
    return {
      cota,
      custo_dia: {
        micro_usd: total,
        por_modelo: [...porModelo].map(([modelo, micro_usd]) => ({ modelo, micro_usd })),
      },
      por_execucao: porExec,
    };
  }

  async shell_obter(): Promise<SaidaRota<'shell_obter'>> {
    const { cota, custo_dia } = await this.cotaECusto();
    const dados = await this.banco.ler(async (r) => ({
      projetos: await r.projetos.listar({ ativos: true }),
      ativas: await r.execucoes.listar({ ativas: true }),
      lotes: await r.lotes.listar({ ativos: true }),
      merge: await r.filaMerge.ativos(),
      terminais: await r.terminais.abertas(),
    }));
    const aguardando = [];
    for (const e of dados.ativas) {
      if (!contaEmAguardandoVoce(e.estado, this.orq.clienteRespondeu.has(e.id))) continue;
      const c = await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id));
      aguardando.push({
        execucao_id: e.id,
        numero: e.numero,
        titulo: c?.titulo ?? `#${e.numero}`,
        tipo:
          e.estado === 'aguardando_aprovacao'
            ? ('aprovar' as const)
            : e.estado === 'aguardando_plano'
              ? ('decidir_plano' as const)
              : e.estado === 'aguardando_decisao'
                ? ('decisao' as const)
                : e.estado === 'aguardando_cliente_resposta'
                  ? ('pergunta_respondida' as const)
                  : e.estado === 'mergeado_pendente_chamado'
                    ? ('outbox_falhou' as const)
                    : ('precisa_de_voce' as const),
        desde: e.atualizado_em,
        href:
          e.estado === 'aguardando_aprovacao'
            ? `/execucoes/${e.id}/aprovacao`
            : `/execucoes/${e.id}`,
      });
    }
    const banners: SaidaRota<'shell_obter'>['banners'] = [];
    if (!this.n.cliCompativel()) {
      banners.push({
        tipo: 'pipeline_bloqueado',
        nivel: 'erro',
        mensagem: 'A CLI do Claude não está na versão compatível: nenhuma etapa nova começa.',
        acao: { rotulo: 'Diagnóstico', href: '/diagnostico' },
      });
    }
    const interrompidas = dados.ativas.filter((e) => e.estado === 'interrompido').length;
    if (interrompidas > 0) {
      banners.push({
        tipo: 'execucoes_interrompidas',
        nivel: 'aviso',
        mensagem: `${interrompidas} execução(ões) interrompida(s) — retomadas automaticamente 1×.`,
        acao: null,
      });
    }
    const conexaoErro = dados.projetos.some((p) => {
      const f = this.n.fonte(p.conexao_id);
      return !f || !f.podeUsar();
    });
    if (conexaoErro) {
      banners.push({
        tipo: 'conexao_chamados',
        nivel: 'aviso',
        mensagem: 'A conexão com o Chamados precisa de atenção.',
        acao: { rotulo: 'Conexão', href: '/conexao' },
      });
    }
    return {
      versao: this.deps.versao,
      modo: this.deps.modo,
      projetos: dados.projetos.map((p) => ({ id: p.id, nome: p.nome, slug: p.slug })),
      cota,
      custo_dia,
      aguardando_voce: aguardando,
      contadores: {
        fila_em_voo: dados.ativas.length,
        lotes_ativos: dados.lotes.length,
        merge_na_fila: dados.merge.length,
        merge_a_publicar: dados.ativas.filter((e) => e.estado === 'aguardando_deploy').length,
        terminais_abertos: dados.terminais.length,
        conexao_com_erro: conexaoErro,
        diagnostico_bloqueante: !this.n.cliCompativel(),
        worktrees_orfas: 0,
      },
      banners,
    };
  }

  async uso_obter(): Promise<SaidaRota<'uso_obter'>> {
    return this.cotaECusto();
  }

  // -------------------------------------------------------------------------
  // Fila (06 §4.1)
  // -------------------------------------------------------------------------

  async fila_listar(
    _p: ParametrosRota<'fila_listar'>,
    f: EntradaRota<'fila_listar'>,
  ): Promise<SaidaRota<'fila_listar'>> {
    const projetos = await this.banco.ler((r) => r.projetos.listar({ ativos: true }));
    const projeto = f.projeto_id
      ? (projetos.find((p) => p.id === f.projeto_id) ?? null)
      : (projetos[0] ?? null);
    if (!projeto) {
      return {
        projeto: null,
        itens: [],
        sincronizado_em: null,
        fonte: 'cache',
        erro_sincronizacao: null,
        contagens: { status: {}, natureza: {}, prioridade: {}, complexidade: {} },
      };
    }
    const mapeamentos = await this.banco.ler((r) => r.projetos.listarMapeamentos(projeto.id));
    const todos = await this.banco.ler((r) => r.chamados.listar(projeto.conexao_id));
    const doProjeto = todos.filter((c) => {
      const res = resolverProjeto(
        { sistema_nome: c.sistema_nome, sistema_alvo_id: c.sistema_alvo_id },
        mapeamentos,
      );
      return res.projeto_id === projeto.id;
    });
    const busca = f.busca?.trim().toLowerCase();
    const filtrados = doProjeto.filter(
      (c) =>
        (!f.status?.length || f.status.includes(c.status)) &&
        (!f.natureza?.length || f.natureza.includes(c.natureza)) &&
        (!f.prioridade?.length || f.prioridade.includes(c.prioridade)) &&
        (!f.complexidade?.length ||
          (c.complexidade !== null && f.complexidade.includes(c.complexidade))) &&
        (!busca || c.titulo.toLowerCase().includes(busca) || String(c.numero) === busca),
    );
    const itens = [];
    for (const c of filtrados) {
      const pre = await this.preCondicoes(c);
      const implementavel = pre.every((p) => p.ok);
      if (f.so_implementaveis && !implementavel) continue;
      const ativa = await this.banco.ler((r) =>
        r.execucoes.ativaDoChamado(c.conexao_id, c.chamado_id),
      );
      itens.push({
        chamado: resumoChamado(c),
        sinais: sinaisParaDto(c.detalhe_sincronizado_em ? c.sinais : null, {
          ia_silenciada: c.ia_silenciada,
          cliente_respondeu: ativa ? this.orq.clienteRespondeu.has(ativa.id) : false,
        }),
        pre_condicoes: pre,
        implementavel,
        execucao: ativa ? await this.resumoExecucao(ativa) : null,
      });
    }
    const contar = <K extends string>(chave: (c: ChamadoCache) => K | null) => {
      const out: Partial<Record<K, number>> = {};
      for (const c of doProjeto) {
        const k = chave(c);
        if (k !== null) out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };
    const erroSinc = this.erroDaConexao(projeto.conexao_id);
    return {
      projeto: { id: projeto.id, nome: projeto.nome, tem_mapeamento: mapeamentos.length > 0 },
      itens,
      sincronizado_em: doProjeto.reduce<string | null>(
        (m, c) => (m === null || c.sincronizado_em > m ? c.sincronizado_em : m),
        null,
      ),
      // FJ-031: `cache` só quando o Chamados de fato não responde — e com o motivo.
      fonte: erroSinc ? 'cache' : 'servidor',
      erro_sincronizacao: erroSinc,
      contagens: {
        status: contar((c) => c.status),
        natureza: contar((c) => c.natureza),
        prioridade: contar((c) => c.prioridade),
        complexidade: contar((c) => c.complexidade),
      },
    };
  }

  async fila_sincronizar(
    _p: ParametrosRota<'fila_sincronizar'>,
    e: EntradaRota<'fila_sincronizar'>,
  ): Promise<SaidaRota<'fila_sincronizar'>> {
    const projetos = await this.banco.ler((r) => r.projetos.listar({ ativos: true }));
    const alvo = e.projeto_id ? projetos.filter((p) => p.id === e.projeto_id) : projetos;
    const conexoes = [...new Set(alvo.map((p) => p.conexao_id))];
    // FJ-031: falha de conexão é ERRO TIPADO (503 `chamados_indisponivel`, com o
    // motivo real), nunca `fonte: 'cache'` silencioso — a Fila mostra o erro.
    const erros: { conexao_id: string; codigo: string; mensagem: string }[] = [];
    for (const id of conexoes) {
      const fonte = this.n.fonte(id);
      if (!fonte || !fonte.podeUsar()) {
        const erro = this.erroDaConexao(id) ?? {
          codigo: 'outro',
          mensagem: 'A sessão com o Chamados não está válida.',
        };
        erros.push({ conexao_id: id, ...erro });
        continue;
      }
      try {
        const res = await consultarFila(fonte.api, { d036: fonte.d036() });
        await this.banco.transacao(async (r) => {
          for (const c of res.itens) {
            await r.chamados.gravarDaLista({
              conexao_id: id,
              chamado_id: c.id,
              numero: c.numero,
              titulo: c.titulo,
              status: c.status,
              natureza: c.natureza,
              prioridade: c.prioridade,
              complexidade: c.complexidade ?? null,
              sistema_nome: c.sistema_nome,
              ...(c.sistema_alvo_id !== undefined ? { sistema_alvo_id: c.sistema_alvo_id } : {}),
              ...(c.ia_silenciada !== undefined ? { ia_silenciada: c.ia_silenciada } : {}),
              atualizado_em_remoto: c.updated_at,
            });
          }
        });
        this.errosSincronizacao.delete(id);
      } catch (e) {
        const erro = erroDeExcecao(e);
        this.errosSincronizacao.set(id, erro);
        erros.push({ conexao_id: id, ...erro });
      }
    }
    if (erros.length > 0) {
      throw new ErroForja(
        'chamados_indisponivel',
        `Não foi possível sincronizar com o Chamados: ${erros.map((e) => e.mensagem).join('; ')}`,
        503,
        { erros, link: { rotulo: 'Conexão', href: '/conexao' } },
      );
    }
    return { sincronizado_em: this.n.iso(), fonte: 'servidor' };
  }

  async chamado_obter(p: ParametrosRota<'chamado_obter'>): Promise<SaidaRota<'chamado_obter'>> {
    const projetos = await this.banco.ler((r) => r.projetos.listar());
    for (const conexaoId of [...new Set(projetos.map((x) => x.conexao_id))]) {
      const cache = await this.banco.ler((r) =>
        r.chamados.obterPorChamado(conexaoId, p.chamado_id),
      );
      if (!cache) continue;
      const fonte = this.n.fonte(conexaoId);
      if (!fonte || !fonte.podeUsar()) {
        throw new ErroForja('chamados_indisponivel', 'o Chamados não está acessível', 503);
      }
      const d = await fonte.api.obterChamado(p.chamado_id, { formato: 'markdown' });
      return {
        chamado: resumoChamado(cache),
        sinais: sinaisParaDto(cache.sinais, { ia_silenciada: d.chamado.ia_silenciada ?? null }),
        pre_condicoes: await this.preCondicoes(cache),
        corpo_markdown: d.chamado.descricao,
        mensagens: d.mensagens.filter((m) => m.visibilidade !== 'interna').map(mensagemCliente),
        url_no_chamados: `${fonte.urlBase}/chamados/${d.chamado.numero}`,
        dado_do_cliente: true,
      };
    }
    throw naoEncontrado('chamado');
  }

  async execucao_criar(
    _p: ParametrosRota<'execucao_criar'>,
    e: EntradaRota<'execucao_criar'>,
  ): Promise<SaidaRota<'execucao_criar'>> {
    return this.orq.criarExecucao(e);
  }

  // -------------------------------------------------------------------------
  // Execução (06 §4.2)
  // -------------------------------------------------------------------------

  async execucao_obter(p: ParametrosRota<'execucao_obter'>): Promise<SaidaRota<'execucao_obter'>> {
    const e = await this.exec(p.id);
    const dados = await this.banco.ler(async (r) => ({
      projeto: await r.projetos.exigir(e.projeto_id),
      chamado: await r.chamados.obter(e.chamado_cache_id),
      etapas: await r.etapas.listar(e.id),
      terminal: await r.terminais.assumidaAbertaDaExecucao(e.id),
      aprovs: await r.aprovacoes.listar(e.id),
    }));
    const plano = await this.planoDto(e);
    const conversa = [];
    for (const x of dados.etapas.filter((y) => y.tipo === 'conversar')) {
      const eventos = await this.banco.ler((r) =>
        r.eventos.desde(0, { execucao_id: e.id, etapa_id: x.id, tipos: ['agente.texto'] }),
      );
      for (const ev of eventos) {
        if (ev.tipo !== 'agente.texto' || ev.dados.pensamento) continue;
        conversa.push({
          id: String(ev.seq),
          autor: 'condutor' as const,
          texto: ev.dados.texto,
          em: ev.em,
          etapa_id: x.id,
        });
      }
    }
    let decisao: ExecucaoDto['decisao'] = null;
    if (
      plano &&
      (e.estado === 'aguardando_decisao' || e.estado === 'aguardando_cliente_resposta')
    ) {
      const pergunta = dados.aprovs
        .filter((a) => a.tipo === 'decisao' && a.comentario === 'perguntar_cliente')
        .at(-1);
      decisao = {
        perguntas: plano.plano.perguntas_ao_cliente,
        decisoes: plano.plano.decisoes_do_operador,
        rascunho_pergunta: null,
        pergunta_publicada_em: pergunta?.criado_em ?? null,
        resposta_cliente: null,
      };
    }
    const ultimaAtividade = dados.etapas
      .filter((x) => x.estado === 'executando')
      .map((x) => x.ultimo_evento_em ?? x.inicio)
      .sort()
      .at(-1);
    const avisoMin = e.config_snapshot.limites.timeout_min.aviso_inatividade;
    const parada =
      ultimaAtividade && this.n.agora().getTime() - Date.parse(ultimaAtividade) >= avisoMin * 60_000
        ? ultimaAtividade
        : null;
    const sentinela = e.sentinela
      ? {
          divergencias: e.sentinela.divergencias,
          detectada_em: e.sentinela.detectada_em,
          reconhecida_em: e.sentinela.reconhecida_em,
        }
      : null;
    return {
      id: e.id,
      chamado: resumoChamado(dados.chamado, e),
      projeto: { id: dados.projeto.id, nome: dados.projeto.nome, slug: dados.projeto.slug },
      lote_id: e.lote_id,
      tentativa: e.tentativa,
      estado: e.estado,
      grupo: GRUPO_ESTADO_EXECUCAO[e.estado],
      estado_anterior: e.estado_anterior,
      motivo_estado: e.motivo_estado,
      motivo_texto: e.motivo_texto,
      branch: e.branch,
      branch_destino: e.branch_destino,
      worktree_dir: e.worktree_dir,
      sha_base: e.sha_base,
      sha_atual: e.sha_atual,
      sha_verificado: e.sha_verificado,
      nivel_verificacao: e.nivel_verificacao,
      ciclo_auto: e.ciclo_auto,
      ciclo_total: e.ciclo_total,
      limites_ciclo: {
        max_auto: e.config_snapshot.limites.ciclos.max_auto,
        max_total: e.config_snapshot.limites.ciclos.max_total,
      },
      custo_micro_usd: e.custo_micro_usd,
      iniciado_em: e.iniciado_em,
      concluido_em: e.concluido_em,
      selos: e.selos,
      altera_ui:
        (e.selos?.altera_ui ?? false) || planoComUi(plano?.plano ?? null, e.config_snapshot),
      evidencia_visual: e.evidencia_visual,
      evidencia_visual_motivo: e.evidencia_visual_motivo,
      trilha: this.trilha(e, dados.etapas),
      etapas: dados.etapas.map(etapaDto),
      plano,
      decisao,
      conversa,
      conversa_bloqueada: dados.terminal
        ? 'a sessão está assumida no terminal'
        : e.estado !== 'pausado_usuario'
          ? 'pause a execução para conversar'
          : null,
      acoes: acoesDisponiveis({
        estado: e.estado,
        estado_anterior: e.estado_anterior,
        motivo: e.motivo_estado,
        processo_vivo: this.n.emCurso.has(e.id),
        assumida: dados.terminal !== null,
        existe_commit: e.sha_atual !== null && e.sha_atual !== e.sha_base,
        tem_sessao: !!(e.session_id_condutor ?? e.session_id_planejador),
        cliente_respondeu: this.orq.clienteRespondeu.has(e.id),
        sentinela_pendente:
          !!e.sentinela && !e.sentinela.reconhecida_em && e.sentinela.divergencias.length > 0,
        altera_ui: e.selos?.altera_ui ?? false,
        teve_implementacao: maisUmCicloPermitido(
          null,
          e.sha_atual !== null && e.sha_atual !== e.sha_base,
          dados.etapas,
        ),
        seguir_com_achados_ok: seguirComAchadosPermitido(e, dados.etapas),
      }),
      sem_atividade_desde: parada,
      retoma_em: await this.retomaEm(e),
      mensagens_novas_cliente: [],
      sessao_assumida: dados.terminal ? { sessao_terminal_id: dados.terminal.id } : null,
      sentinela,
    };
  }

  async execucao_feed(
    p: ParametrosRota<'execucao_feed'>,
    f: EntradaRota<'execucao_feed'>,
  ): Promise<SaidaRota<'execucao_feed'>> {
    await this.exec(p.id);
    const limite = Math.min(Math.max(1, f.limite ?? 200), 2000);
    const todos = await this.banco.ler((r) =>
      r.eventos.desde(f.depois_de_seq ?? 0, {
        execucao_id: p.id,
        ...(f.etapa_id ? { etapa_id: f.etapa_id } : {}),
      }),
    );
    const { ehMarco } = await import('../../comum/protocolo-eventos');
    let lista = f.modo === 'marcos' ? todos.filter(ehMarco) : todos;
    if (f.antes_de_seq !== undefined)
      lista = lista.filter((e) => e.seq < (f.antes_de_seq as number));
    const pagina = f.depois_de_seq !== undefined ? lista.slice(0, limite) : lista.slice(-limite);
    return {
      eventos: pagina,
      ultimo_seq: pagina.at(-1)?.seq ?? f.depois_de_seq ?? 0,
      ha_mais_antigos: f.depois_de_seq === undefined && lista.length > pagina.length,
    };
  }

  async execucao_transcript(
    p: ParametrosRota<'execucao_transcript'>,
    f: EntradaRota<'execucao_transcript'>,
  ): Promise<SaidaRota<'execucao_transcript'>> {
    const etapa = await this.banco.ler((r) => r.etapas.obter(p.etapa_id));
    if (!etapa || etapa.execucao_id !== p.id) throw naoEncontrado('etapa');
    const POR_PAGINA = 500;
    let linhas: string[] = [];
    if (etapa.transcript_path) {
      const arq = join(this.n.dirExecucao(p.id), etapa.transcript_path);
      if (existsSync(arq)) linhas = (await readFile(arq, 'utf8')).split('\n').filter(Boolean);
    }
    const total = Math.max(1, Math.ceil(linhas.length / POR_PAGINA));
    const pagina = Math.min(Math.max(1, f.pagina ?? 1), total);
    return {
      etapa_id: etapa.id,
      pagina,
      total_paginas: total,
      linhas: linhas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA),
    };
  }

  async execucao_plano(p: ParametrosRota<'execucao_plano'>): Promise<SaidaRota<'execucao_plano'>> {
    const e = await this.exec(p.id);
    const atual = await this.planoDto(e);
    if (!atual) throw naoEncontrado('plano');
    const versoes = await this.banco.ler((r) => r.artefatos.listar(e.id, { tipo: 'plano' }));
    return {
      atual,
      versoes: versoes.map((v) => ({
        artefato_id: v.id,
        versao: v.versao,
        editado_por_humano: v.editado_por_humano,
        criado_em: v.criado_em,
      })),
    };
  }

  execucao_aprovar_plano(
    p: ParametrosRota<'execucao_aprovar_plano'>,
    e: EntradaRota<'execucao_aprovar_plano'>,
  ) {
    return this.orq.aprovarPlano(p.id, e);
  }

  execucao_comentar_plano(
    p: ParametrosRota<'execucao_comentar_plano'>,
    e: EntradaRota<'execucao_comentar_plano'>,
  ) {
    return this.orq.comentarPlano(p.id, e.texto);
  }

  execucao_decidir(p: ParametrosRota<'execucao_decidir'>, e: EntradaRota<'execucao_decidir'>) {
    return this.orq.decidir(p.id, e);
  }

  execucao_replanejar(p: ParametrosRota<'execucao_replanejar'>) {
    return this.orq.replanejar(p.id);
  }

  execucao_pausar(p: ParametrosRota<'execucao_pausar'>) {
    return this.orq.pausar(p.id);
  }

  execucao_retomar(p: ParametrosRota<'execucao_retomar'>, e: EntradaRota<'execucao_retomar'>) {
    return this.orq.retomar(p.id, e.mesmo_assim === true);
  }

  execucao_parar(p: ParametrosRota<'execucao_parar'>) {
    return this.orq.pararExecucao(p.id);
  }

  execucao_conversar(
    p: ParametrosRota<'execucao_conversar'>,
    e: EntradaRota<'execucao_conversar'>,
  ) {
    return this.orq.conversar(p.id, e.texto);
  }

  execucao_assumir(p: ParametrosRota<'execucao_assumir'>) {
    return this.orq.assumir(p.id);
  }

  execucao_devolver(p: ParametrosRota<'execucao_devolver'>) {
    return this.orq.devolver(p.id);
  }

  execucao_descartar(
    p: ParametrosRota<'execucao_descartar'>,
    e: EntradaRota<'execucao_descartar'>,
  ) {
    return this.orq.descartar(p.id, e);
  }

  execucao_encerrar(p: ParametrosRota<'execucao_encerrar'>, e: EntradaRota<'execucao_encerrar'>) {
    return this.orq.encerrar(p.id, e.motivo);
  }

  execucao_tentar_novamente(p: ParametrosRota<'execucao_tentar_novamente'>) {
    return this.orq.tentarNovamente(p.id);
  }

  execucao_resolver_pendencia(
    p: ParametrosRota<'execucao_resolver_pendencia'>,
    e: EntradaRota<'execucao_resolver_pendencia'>,
  ) {
    return this.orq.resolverPendencia(p.id, e);
  }

  execucao_ciente_mensagem(
    p: ParametrosRota<'execucao_ciente_mensagem'>,
    e: EntradaRota<'execucao_ciente_mensagem'>,
  ) {
    return this.orq.cienteMensagem(p.id, e.mensagem_id);
  }

  execucao_recapturar_prints(p: ParametrosRota<'execucao_recapturar_prints'>) {
    return this.orq.recapturarPrints(p.id);
  }

  execucao_reconhecer_sentinela(p: ParametrosRota<'execucao_reconhecer_sentinela'>) {
    return this.orq.reconhecerSentinela(p.id);
  }

  /** "Apagar dados deste chamado" (05 §11): só de execução encerrada, confirmado pelo número. */
  async execucao_apagar_dados(
    p: ParametrosRota<'execucao_apagar_dados'>,
    e: EntradaRota<'execucao_apagar_dados'>,
  ): Promise<SaidaRota<'execucao_apagar_dados'>> {
    const ex = await this.exec(p.id);
    if (e.confirmar_numero !== ex.numero) {
      throw new ErroForja('entrada_invalida', 'o número digitado não confere', 400);
    }
    if (!estadoTerminal(ex.estado)) {
      throw new ErroForja('conflito', 'só dá para apagar os dados de uma execução encerrada', 409);
    }
    const apagados: string[] = [];
    for (const sub of ['entrada', 'evidencias', 'etapas', 'logs']) {
      const dir = join(this.n.dirExecucao(ex.id), sub);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        apagados.push(sub);
      }
    }
    await this.banco.transacao((r) => r.eventos.expurgar([ex.id]));
    apagados.push('eventos_brutos');
    return { apagados };
  }

  // -------------------------------------------------------------------------
  // Aprovação G2 (06 §4.3)
  // -------------------------------------------------------------------------

  /** Tudo o que o G2 amarra (05 §7.1: conferido no servidor também ao aprovar). */
  async contextoAprovacao(id: string): Promise<{
    e: Execucao;
    projeto: Projeto;
    relatorio: { id: string; versao: number; conteudo: RelatorioRegistrado };
    resposta: RespostaRegistrada;
    diff: {
      patch_id: string;
      sha: string;
      base: string;
      por_arquivo: { caminho: string; selos: SeloArquivo[] }[];
    };
    ctx: ContextoAprovacaoFinal;
    mensagensNovas: MensagemClienteDto[];
    reaprovacao: { patch_anterior: string; patch_atual: string } | null;
  }> {
    const e = await this.exec(id);
    const d = await this.banco.ler(async (r) => ({
      projeto: await r.projetos.exigir(e.projeto_id),
      rel: await r.artefatos.ultimaVersao(e.id, 'relatorio'),
      resp: await r.artefatos.ultimaVersao(e.id, 'resposta'),
      diffs: await r.artefatos.listar(e.id, { tipo: 'diff' }),
      aprovs: await r.aprovacoes.listar(e.id),
      plano: await r.artefatos.ultimaVersao(e.id, 'plano'),
    }));
    if (!d.rel || !d.resp || d.diffs.length === 0) throw naoEncontrado('relatório');
    const diffArt = d.diffs.at(-1)!;
    const relatorio = d.rel.conteudo as unknown as RelatorioRegistrado;
    const resposta = d.resp.conteudo as unknown as RespostaRegistrada;
    const dc = (diffArt.conteudo ?? {}) as {
      base?: string;
      sha?: string;
      por_arquivo?: { caminho: string; selos: SeloArquivo[] }[];
    };
    const porArquivo =
      dc.por_arquivo ??
      (d.diffs.find((x) => (x.conteudo as typeof dc)?.por_arquivo)?.conteudo as typeof dc)
        ?.por_arquivo ??
      [];
    const detalhe = await this.detalheOuNulo(e);
    const novas = detalhe ? mensagensDepoisDaCiente(detalhe, e) : [];
    const invalidada = d.aprovs
      .filter((a) => (a.tipo === 'final' || a.tipo === 'reaprovacao') && a.invalidada_em)
      .at(-1);
    const reaprovacao =
      invalidada?.patch_id && diffArt.patch_id && invalidada.patch_id !== diffArt.patch_id
        ? { patch_anterior: invalidada.patch_id, patch_atual: diffArt.patch_id }
        : null;
    const contexto: ContextoG2 = {
      relatorio: {
        artefato_id: d.rel.id,
        versao: d.rel.versao,
        patch_id: diffArt.patch_id ?? '',
        sha: diffArt.sha_git ?? relatorio.sha,
      },
      altera_ui: e.selos?.altera_ui ?? false,
      evidencia_visual: e.evidencia_visual,
      evidencia_visual_motivo: e.evidencia_visual_motivo,
      arquivos_selo: porArquivo.filter((a) => a.selos.length > 0).map((a) => a.caminho),
      sensiveis: porArquivo.filter((a) => a.selos.includes('sensivel')).map((a) => a.caminho),
      mensagem_nova_cliente_id: novas.at(-1)?.id ?? null,
      achados_em_aberto: relatorio.achados_em_aberto.length,
      reaprovacao: reaprovacao !== null,
      incoerencias: relatorio.incoerencias,
      // FJ-034: riscos do plano que não pararam no G1 (planos antigos não têm o campo).
      avisos_plano:
        ((d.plano?.conteudo as unknown as PlanoRegistrado | undefined)?.avisos as
          string[] | undefined) ?? [],
    };
    return {
      e,
      projeto: d.projeto,
      relatorio: { id: d.rel.id, versao: d.rel.versao, conteudo: relatorio },
      resposta,
      diff: {
        patch_id: diffArt.patch_id ?? '',
        sha: diffArt.sha_git ?? relatorio.sha,
        base: dc.base ?? e.sha_base ?? '',
        por_arquivo: porArquivo,
      },
      ctx: { contexto, tipo_resposta: resposta.tipo, corpo_hash_original: resposta.corpo_hash },
      mensagensNovas: novas.map(mensagemCliente),
      reaprovacao,
    };
  }

  async aprovacao_obter(
    p: ParametrosRota<'aprovacao_obter'>,
  ): Promise<SaidaRota<'aprovacao_obter'>> {
    const c = await this.contextoAprovacao(p.id);
    const { e, projeto, relatorio } = c;
    const chamado = await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id));
    const fonte = this.n.fonte(e.conexao_id);
    const cfg = e.config_snapshot;
    let conflito: SaidaRota<'aprovacao_obter'>['conflito'] = null;
    const destinoSha = await resolverSha(projeto.repo_dir, `refs/heads/${e.branch_destino}`);
    if (destinoSha && e.branch) {
      const pre = await preChecarConflito(projeto.repo_dir, destinoSha, e.branch).catch(() => null);
      if (pre)
        conflito = { conflita: pre.conflito, sha_destino: destinoSha, arquivos: pre.arquivos };
    }
    const alertas: SaidaRota<'aprovacao_obter'>['alertas'] = [];
    if (e.sentinela && e.sentinela.divergencias.length && !e.sentinela.reconhecida_em) {
      alertas.push({
        tipo: 'sentinela',
        nivel: 'erro',
        mensagem: 'A sentinela de integridade viu mudança fora da worktree.',
        detalhes: e.sentinela.divergencias,
      });
    }
    if (c.mensagensNovas.length) {
      alertas.push({
        tipo: 'cliente_escreveu',
        nivel: 'aviso',
        mensagem: 'O cliente escreveu desde o início da implementação.',
        detalhes: [],
      });
    }
    if (conflito?.conflita) {
      alertas.push({
        tipo: 'conflito_destino',
        nivel: 'aviso',
        mensagem: 'Conflita com o destino atual.',
        detalhes: conflito.arquivos,
      });
    }
    if (relatorio.conteudo.incoerencias.length) {
      alertas.push({
        tipo: 'relatorio_contradiz',
        // FJ-034: depois de 1 regeneração o relatório segue com aviso (não bloqueia).
        nivel: 'aviso',
        mensagem: 'O relatório diverge do diff nestes pontos (confira no Diff).',
        detalhes: relatorio.conteudo.incoerencias,
      });
    }
    if (
      c.ctx.contexto.altera_ui &&
      (e.evidencia_visual === 'parcial' || e.evidencia_visual === 'sem_evidencia_visual')
    ) {
      alertas.push({
        tipo: 'ui_sem_prints',
        nivel: 'aviso',
        mensagem: `Alteração de interface sem prints completos: ${e.evidencia_visual_motivo ?? e.evidencia_visual}.`,
        detalhes: [],
      });
    }
    if (c.reaprovacao) {
      alertas.push({
        tipo: 'reaprovacao',
        nivel: 'aviso',
        mensagem: 'O patch mudou depois da aprovação: confira o interdiff.',
        detalhes: [],
      });
    }
    if (relatorio.conteudo.achados_em_aberto.length) {
      alertas.push({
        tipo: 'achados_abertos',
        nivel: 'aviso',
        mensagem: 'Há achados da revisão em aberto.',
        detalhes: relatorio.conteudo.achados_em_aberto,
      });
    }
    const politica = cfg.politica_status.ao_concluir;
    const ajustes = (await this.banco.ler((r) => r.comentarios.listar(e.id))).filter(
      (x) => x.alvo === 'diff',
    ).length;
    return {
      execucao_id: e.id,
      chamado: resumoChamado(chamado, e),
      versao: relatorio.versao,
      relatorio_artefato_id: relatorio.id,
      relatorio: relatorio.conteudo,
      resposta: c.resposta,
      autor_publico: fonte?.identidade()?.nome ?? null,
      patch_id: c.diff.patch_id,
      sha: c.diff.sha,
      branch_destino: e.branch_destino,
      remoto: cfg.repo.remoto,
      modo_entrega: cfg.entrega.modo,
      descricao_entrega:
        cfg.entrega.modo === 'merge_e_push'
          ? `merge na ${e.branch_destino} e push para ${cfg.repo.remoto ?? 'o remoto'}`
          : cfg.entrega.modo === 'merge_local'
            ? `merge na ${e.branch_destino} local (sem push)`
            : 'pull request (Fase 2)',
      revisao: {
        decisao: relatorio.conteudo.achados_em_aberto.length ? 'aprovado com achados' : 'aprovado',
        bloqueantes: 0,
        achados_abertos: relatorio.conteudo.achados_em_aberto.length,
      },
      ciclos: { auto: e.ciclo_auto, humano: ajustes },
      custo_micro_usd: e.custo_micro_usd,
      alertas,
      mensagens_novas_cliente: c.mensagensNovas,
      conflito,
      opcoes_status: (['resolvido', 'fechado_imediato', 'aguardar_deploy'] as const).map(
        (valor) => ({
          valor,
          rotulo: {
            resolvido: 'Resolvido',
            fechado_imediato: 'Fechado já',
            aguardar_deploy: 'Aguardar publicação',
          }[valor],
          consequencia: {
            resolvido: 'O chamado vai a "resolvido" e fecha sozinho em 3 dias.',
            fechado_imediato: 'O chamado é fechado logo depois da mensagem.',
            aguardar_deploy:
              'Só a nota interna sai agora; mensagem e status esperam "Publicado em produção".',
          }[valor],
          habilitada: true,
        }),
      ),
      politica_padrao: politica,
      avisos: avisosG2({
        ...c.ctx.contexto,
        conflito_arquivos: conflito?.conflita ? conflito.arquivos : [],
      }),
      reaprovacao: c.reaprovacao,
    };
  }

  /** Diff por arquivo (arquivos com selo primeiro, 06 §4.3). */
  private async montarDiff(
    dir: string,
    de: string,
    para: string,
    porArquivo: { caminho: string; selos: SeloArquivo[] }[],
    patchId: string | null,
  ): Promise<DiffDto> {
    const LIMITE = 2 * 1024 * 1024;
    const bruto = (
      await git(['diff', '--no-color', '--no-ext-diff', `${de}..${para}`], {
        cwd: dir,
        aceitar: [0, 128],
      })
    ).stdout;
    const truncado = bruto.length > LIMITE;
    const texto = truncado ? bruto.slice(0, LIMITE) : bruto;
    const status = (
      await git(['diff', '--name-status', `${de}..${para}`], { cwd: dir, aceitar: [0, 128] })
    ).stdout;
    const nums = (
      await git(['diff', '--numstat', `${de}..${para}`], { cwd: dir, aceitar: [0, 128] })
    ).stdout;
    const blocos = texto.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));
    const selos = new Map(porArquivo.map((a) => [a.caminho, a.selos]));
    const arquivos: DiffArquivoDto[] = blocos.map((b) => {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(b);
      const caminho = m?.[2] ?? '?';
      const anterior = m && m[1] !== m[2] ? (m[1] ?? null) : null;
      const linhaStatus = status.split('\n').find((l) => l.split('\t').at(-1) === caminho) ?? '';
      const letra = (linhaStatus[0] ?? 'M') as DiffArquivoDto['status'];
      const linhaNum = nums.split('\n').find((l) => l.split('\t').at(-1) === caminho);
      const [ad, rm_] = linhaNum?.split('\t') ?? ['0', '0'];
      return {
        caminho,
        caminho_anterior: anterior,
        status: ['A', 'M', 'D', 'R'].includes(letra) ? letra : 'M',
        adicoes: ad === '-' ? 0 : Number(ad ?? 0),
        remocoes: rm_ === '-' ? 0 : Number(rm_ ?? 0),
        selos: selos.get(caminho) ?? [],
        binario: /^Binary files /m.test(b),
        patch: b,
      };
    });
    arquivos.sort(
      (a, b) =>
        (b.selos.length > 0 ? 1 : 0) - (a.selos.length > 0 ? 1 : 0) ||
        a.caminho.localeCompare(b.caminho),
    );
    return { sha_de: de, sha_para: para, patch_id: patchId, arquivos, truncado };
  }

  async aprovacao_diff(p: ParametrosRota<'aprovacao_diff'>): Promise<SaidaRota<'aprovacao_diff'>> {
    const c = await this.contextoAprovacao(p.id);
    return this.montarDiff(
      c.projeto.repo_dir,
      c.e.sha_base ?? c.diff.base,
      c.e.sha_verificado ?? c.diff.sha,
      c.diff.por_arquivo,
      c.diff.patch_id,
    );
  }

  async aprovacao_interdiff(
    p: ParametrosRota<'aprovacao_interdiff'>,
  ): Promise<SaidaRota<'aprovacao_interdiff'>> {
    const e = await this.exec(p.id);
    const projeto = await this.banco.ler((r) => r.projetos.exigir(e.projeto_id));
    const rels = await this.banco.ler((r) => r.artefatos.listar(e.id, { tipo: 'relatorio' }));
    const atual = rels.at(-1)?.sha_git ?? e.sha_verificado;
    const aprovs = await this.banco.ler((r) => r.aprovacoes.listar(e.id));
    const anterior =
      aprovs.filter((a) => a.sha && (a.tipo === 'final' || a.tipo === 'reaprovacao')).at(-1)?.sha ??
      rels.at(-2)?.sha_git ??
      null;
    if (!atual || !anterior) throw naoEncontrado('versão anterior');
    return this.montarDiff(projeto.repo_dir, anterior, atual, [], null);
  }

  async aprovacao_evidencias(
    p: ParametrosRota<'aprovacao_evidencias'>,
  ): Promise<SaidaRota<'aprovacao_evidencias'>> {
    const e = await this.exec(p.id);
    const d = await this.banco.ler(async (r) => ({
      evid: await r.artefatos.listar(e.id, { tipo: 'evidencia' }),
      logs: await r.artefatos.listar(e.id, { tipo: 'log' }),
      rel: await r.artefatos.ultimaVersao(e.id, 'relatorio'),
      plano: await r.artefatos.ultimaVersao(e.id, 'plano'),
    }));
    const relatorio = d.rel?.conteudo as unknown as RelatorioRegistrado | null;
    const plano = d.plano?.conteudo as unknown as PlanoRegistrado | null;
    const imagem = (a: (typeof d.evid)[number] | undefined) => {
      if (!a) return null;
      const cont = a.conteudo as { largura?: number; altura?: number } | null;
      return {
        artefato_id: a.id,
        url: `/api/execucoes/${e.id}/evidencias/${a.id}/imagem`,
        largura: cont?.largura ?? 0,
        altura: cont?.altura ?? 0,
        sha_git: a.sha_git ?? '',
        expirada: !a.caminho || !existsSync(join(this.n.dirExecucao(e.id), a.caminho)),
      };
    };
    const ultima = (tela: string, momento: 'antes' | 'depois') =>
      [...d.evid].reverse().find((a) => {
        const c = a.conteudo as { tela_id?: string; momento?: string } | null;
        return (
          c?.tela_id === tela &&
          c?.momento === momento &&
          (momento === 'antes' || a.sha_git === e.sha_verificado)
        );
      });
    // Telas: as do plano e as que o agente fotografou (FJ-030 §3), por `tela_id`.
    const basicas = new Map<string, { descricao: string; rota: string }>();
    for (const t of plano?.telas_afetadas ?? []) basicas.set(t.id, t);
    for (const a of d.evid) {
      const c = a.conteudo as { tela_id?: string; rota?: string; descricao?: string } | null;
      if (c?.tela_id && !basicas.has(c.tela_id)) {
        basicas.set(c.tela_id, { descricao: c.descricao ?? '', rota: c.rota ?? '' });
      }
    }
    const telas: EvidenciaTelaDto[] = [...basicas].map(([id, t]) => {
      const antes = ultima(id, 'antes');
      const depois = ultima(id, 'depois');
      const cont = (a: typeof antes) =>
        a?.conteudo as {
          resultado?: EvidenciaTelaDto['resultado_antes'];
          antes_suspeito?: boolean;
          motivo_sem_antes?: string | null;
        } | null;
      const avisos = [
        cont(antes)?.antes_suspeito ? 'antes tirado depois do primeiro checkpoint' : null,
        !antes && !cont(depois)?.motivo_sem_antes ? 'sem print antes' : null,
        !depois ? 'sem print depois' : null,
      ].filter((x): x is string => x !== null);
      return {
        tela_id: id,
        descricao: t.descricao,
        rota: t.rota,
        o_que_mudou:
          relatorio?.alteracoes_de_interface.telas.find((x) => x.tela_id === id)
            ?.o_que_mudou_para_quem_usa ?? null,
        antes: imagem(antes),
        depois: imagem(depois),
        resultado_antes: cont(antes)?.resultado ?? null,
        resultado_depois: cont(depois)?.resultado ?? null,
        aviso: avisos.length ? avisos.join('; ') : null,
        antes_suspeito: cont(antes)?.antes_suspeito === true,
        motivo_sem_antes: cont(antes)?.motivo_sem_antes ?? cont(depois)?.motivo_sem_antes ?? null,
      };
    });
    const primeira = telas.find((t) => t.depois)?.depois;
    return {
      sha_antes: e.sha_base,
      sha_depois: e.sha_verificado,
      // Quem fotografou foi o agente: o viewport é o da imagem; o tema não é controlado (FJ-030 §3).
      ...(primeira ? { viewport: { largura: primeira.largura, altura: primeira.altura } } : {}),
      evidencia_visual: e.evidencia_visual ?? 'nao_se_aplica',
      motivo: e.evidencia_visual_motivo,
      motivo_geral: motivoGeralDoMotivo(e.evidencia_visual_motivo),
      telas,
      logs: d.logs
        .filter((l) => l.sha_git === e.sha_verificado)
        .map((l) => {
          const c = l.conteudo as {
            nome?: string;
            exit_code?: number | null;
            duracao_ms?: number;
          } | null;
          return {
            nome: c?.nome ?? l.caminho ?? '?',
            exit_code: c?.exit_code ?? null,
            duracao_ms: c?.duracao_ms ?? 0,
            artefato_id: l.id,
            url: `/api/execucoes/${e.id}/artefatos/${l.id}/log`,
          };
        }),
    };
  }

  async aprovacao_tecnico(
    p: ParametrosRota<'aprovacao_tecnico'>,
  ): Promise<SaidaRota<'aprovacao_tecnico'>> {
    const e = await this.exec(p.id);
    const d = await this.banco.ler(async (r) => ({
      ver: await r.artefatos.ultimaVersao(e.id, 'veredito'),
      res: await r.artefatos.ultimaVersao(e.id, 'resumo_impl'),
      rel: await r.artefatos.ultimaVersao(e.id, 'relatorio'),
      diff: await r.artefatos.ultimaVersao(e.id, 'diff'),
      etapas: await r.etapas.listar(e.id),
    }));
    const relatorio = d.rel?.conteudo as unknown as RelatorioRegistrado | null;
    const negacoes = d.etapas.flatMap((x) =>
      (Array.isArray(x.permission_denials) ? x.permission_denials : []).map((neg) => {
        const o = (neg ?? {}) as { tool_name?: string; tool_input?: unknown };
        return {
          etapa_n: x.n,
          ferramenta: o.tool_name ?? '?',
          resumo: JSON.stringify(o.tool_input ?? {}).slice(0, 200),
          em: x.fim ?? x.inicio,
        };
      }),
    );
    return {
      veredito: (d.ver?.conteudo as unknown as VereditoRegistrado) ?? null,
      resumo_impl: (d.res?.conteudo as unknown as ResumoImplRegistrado) ?? null,
      negacoes,
      etapas: d.etapas.map(etapaDto),
      branch: e.branch,
      sha_base: e.sha_base,
      sha_atual: e.sha_atual,
      patch_id: d.diff?.patch_id ?? null,
      nota_interna_preview: montarNotaConclusao({
        execucaoId: e.id,
        branch: e.branch ?? '',
        shaMerge: e.sha_merge ?? '(após o merge)',
        destino: e.branch_destino,
        modoEntrega: e.config_snapshot.entrega.modo,
        nivelVerificacao: e.nivel_verificacao ?? 'nao_verificado',
        resumo: relatorio?.resumo ?? '',
        arquivos: [],
        alteraUi: e.selos?.altera_ui ?? false,
        evidenciaVisual: e.evidencia_visual ?? 'nao_se_aplica',
        telas: (relatorio?.alteracoes_de_interface.telas ?? []).map((t) => ({
          titulo: t.tela_id,
          o_que_mudou_para_quem_usa: t.o_que_mudou_para_quem_usa,
        })),
        motivoSemPrints: e.evidencia_visual_motivo,
      }),
      sentinela: e.sentinela
        ? {
            divergencias: e.sentinela.divergencias,
            detectada_em: e.sentinela.detectada_em,
            reconhecida_em: e.sentinela.reconhecida_em,
          }
        : null,
    };
  }

  async aprovacao_validar_resposta(
    _p: ParametrosRota<'aprovacao_validar_resposta'>,
    e: EntradaRota<'aprovacao_validar_resposta'>,
  ): Promise<SaidaRota<'aprovacao_validar_resposta'>> {
    const v = validarRespostaPublica(e.texto, e.tipo);
    return {
      tecnico: v.tecnico,
      promessa: v.promessa,
      lexico: v.lexico,
      disponibilidade: v.disponibilidade,
      ok: v.ok,
    };
  }

  async aprovacao_aprovar(
    p: ParametrosRota<'aprovacao_aprovar'>,
    e: EntradaRota<'aprovacao_aprovar'>,
  ) {
    const c = await this.contextoAprovacao(p.id);
    return this.orq.aprovarFinal(p.id, e, c.ctx);
  }

  aprovacao_pedir_ajustes(
    p: ParametrosRota<'aprovacao_pedir_ajustes'>,
    e: EntradaRota<'aprovacao_pedir_ajustes'>,
  ) {
    return this.orq.pedirAjustes(p.id, e.comentario, e.arquivos ?? []);
  }

  /** `evidencia_imagem` (binário): PNG com o sha256 conferido ao servir (05 §6.4). */
  async imagemEvidencia(
    execucaoId: string,
    artefatoId: string,
  ): Promise<{ tipo: string; conteudo: Buffer }> {
    return this.arquivoArtefato(execucaoId, artefatoId, 'evidencia', 'image/png');
  }

  /** `artefato_log` (binário): log de comando, texto. */
  async logArtefato(
    execucaoId: string,
    artefatoId: string,
  ): Promise<{ tipo: string; conteudo: Buffer }> {
    return this.arquivoArtefato(execucaoId, artefatoId, 'log', 'text/plain; charset=utf-8');
  }

  private async arquivoArtefato(
    execucaoId: string,
    artefatoId: string,
    tipo: 'evidencia' | 'log',
    mime: string,
  ) {
    const a = await this.banco.ler((r) => r.artefatos.obter(artefatoId));
    if (!a || a.execucao_id !== execucaoId || a.tipo !== tipo || !a.caminho)
      throw naoEncontrado('artefato');
    const arq = join(this.n.dirExecucao(execucaoId), a.caminho);
    if (!existsSync(arq)) throw new ErroForja('nao_encontrado', 'arquivo expirado (retenção)', 404);
    const conteudo = await readFile(arq);
    const sha = createHash('sha256').update(conteudo).digest('hex');
    if (sha !== a.sha256) {
      throw new ErroForja(
        'conflito',
        'o arquivo foi alterado depois de registrado (sha256 não confere)',
        409,
      );
    }
    return { tipo: mime, conteudo };
  }

  // -------------------------------------------------------------------------
  // Lotes e mesa de planos (06 §4.4, §4.5)
  // -------------------------------------------------------------------------

  private async loteResumo(loteId: string) {
    const d = await this.banco.ler(async (r) => ({
      lote: await r.lotes.exigir(loteId),
      execs: await r.execucoes.listar({ lote_id: loteId }),
    }));
    const porGrupo: Partial<Record<(typeof GRUPO_ESTADO_EXECUCAO)[EstadoExecucao], number>> = {};
    for (const e of d.execs)
      porGrupo[GRUPO_ESTADO_EXECUCAO[e.estado]] =
        (porGrupo[GRUPO_ESTADO_EXECUCAO[e.estado]] ?? 0) + 1;
    const fase = faseDoLote(
      d.lote.estado,
      d.execs.map((e) => e.estado),
    );
    if (fase !== d.lote.estado)
      await this.banco.transacao((r) => r.lotes.mudarEstado(loteId, fase));
    return {
      lote: d.lote,
      execs: d.execs,
      resumo: {
        id: d.lote.id,
        nome: d.lote.nome,
        projeto_id: d.lote.projeto_id,
        estado: fase,
        criado_em: d.lote.criado_em,
        encerrado_em: d.lote.encerrado_em,
        total: d.execs.length,
        por_grupo: porGrupo,
      },
    };
  }

  async lotes_listar(): Promise<SaidaRota<'lotes_listar'>> {
    const lotes = await this.banco.ler((r) => r.lotes.listar());
    const out = [];
    for (const l of lotes) out.push((await this.loteResumo(l.id)).resumo);
    return { lotes: out };
  }

  async lote_previa(
    _p: ParametrosRota<'lote_previa'>,
    e: EntradaRota<'lote_previa'>,
  ): Promise<SaidaRota<'lote_previa'>> {
    const projeto = await this.banco.ler((r) => r.projetos.obter(e.projeto_id));
    if (!projeto) throw naoEncontrado('projeto');
    const incluidos: ChamadoResumoDto[] = [];
    const excluidos: { chamado: ChamadoResumoDto; motivos: string[] }[] = [];
    for (const id of e.chamado_ids) {
      const c = await this.banco.ler((r) => r.chamados.obterPorChamado(projeto.conexao_id, id));
      if (!c) continue;
      const pre = await this.preCondicoes(c);
      const falhas = pre.filter((x) => !x.ok).map((x) => x.motivo ?? x.codigo);
      if (falhas.length) excluidos.push({ chamado: resumoChamado(c), motivos: falhas });
      else incluidos.push(resumoChamado(c));
    }
    return {
      incluidos,
      excluidos,
      concorrencia_planos: this.n.configDoProjeto(projeto).limites.concorrencia.planejadores,
      concorrencia_impl: this.n.configDoProjeto(projeto).limites.concorrencia.agentes,
    };
  }

  lote_criar(_p: ParametrosRota<'lote_criar'>, e: EntradaRota<'lote_criar'>) {
    return this.orq.criarLote(e.projeto_id, e.chamado_ids);
  }

  async lote_obter(p: ParametrosRota<'lote_obter'>): Promise<SaidaRota<'lote_obter'>> {
    const { lote, execs, resumo } = await this.loteResumo(p.id);
    const freio = await this.orq.freio();
    const linhas = [];
    let schema: SaidaRota<'lote_obter'>['schema_em_voo'] = null;
    for (const e of execs) {
      const c = await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id));
      const etapas = await this.banco.ler((r) => r.etapas.listar(e.id));
      const dono = this.n.vagas.donoSchema(chaveDestino(e.projeto_id, e.branch_destino));
      if (dono === e.id) schema = { execucao_id: e.id, numero: e.numero };
      linhas.push({
        chamado: resumoChamado(c, e),
        execucao: await this.resumoExecucao(e),
        mini_trilha: this.trilha(e, etapas),
        observacao: e.motivo_texto,
        acao: { rotulo: 'Abrir', href: `/execucoes/${e.id}` },
      });
    }
    return {
      lote: {
        ...resumo,
        concorrencia_planos: lote.concorrencia_planos,
        concorrencia_impl: lote.concorrencia_impl,
      },
      linhas,
      schema_em_voo: schema,
      freio: { ativo: freio.ativo, motivo: freio.motivo, ate: freio.ate },
      projecao_5h: null,
    };
  }

  async lote_planos(p: ParametrosRota<'lote_planos'>): Promise<SaidaRota<'lote_planos'>> {
    const { lote, execs } = await this.loteResumo(p.id);
    const itens = [];
    const cartoes = [];
    for (const e of execs) {
      const art = await this.banco.ler((r) => r.artefatos.ultimaVersao(e.id, 'plano'));
      const plano = (art?.conteudo as unknown as PlanoRegistrado) ?? null;
      itens.push({ execucao_id: e.id, estado: e.estado, plano });
      const c = await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id));
      const classe = !plano
        ? e.estado === 'falhou' || e.estado === 'precisa_humano'
          ? 'erro'
          : 'planejando'
        : plano.perguntas_ao_cliente.length || plano.decisoes_do_operador.length
          ? 'decisao'
          : plano.alertas_seguranca.length
            ? 'alerta_seguranca'
            : plano.schema_banco.altera
              ? 'schema'
              : planoLimpo(plano).limpo
                ? 'limpo'
                : 'precisa_revisao';
      cartoes.push({
        execucao_id: e.id,
        chamado: resumoChamado(c, e),
        estado: e.estado,
        classe: classe as SaidaRota<'lote_planos'>['cartoes'][number]['classe'],
        plano,
        resumo_linha: plano ? `#${e.numero}: ${plano.entendimento.slice(0, 120)}` : null,
        planejando_desde: !plano ? e.iniciado_em : null,
        erro:
          !plano && (e.estado === 'falhou' || e.estado === 'precisa_humano')
            ? e.motivo_texto
            : null,
        posicao_schema: null,
        plano_artefato_id: art?.id ?? null,
      });
    }
    const mesa = montarMesa(itens);
    return {
      lote_id: lote.id,
      nome: lote.nome,
      total: execs.length,
      prontos: mesa.limpos.length + mesa.individuais.length,
      planejando: mesa.planejando.length,
      concorrencia_planos: lote.concorrencia_planos,
      cartoes,
      arquivos_em_comum: arquivosEmComum(
        itens
          .filter((i) => i.plano)
          .map((i) => ({
            execucao_id: i.execucao_id,
            arquivos_previstos: i.plano?.arquivos_previstos ?? [],
          })),
      ).map((a) => ({
        arquivo: a.arquivo,
        numeros: a.execucoes.map((id) => execs.find((x) => x.id === id)?.numero ?? 0),
      })),
    };
  }

  async lote_aprovar_limpos(
    p: ParametrosRota<'lote_aprovar_limpos'>,
    e: EntradaRota<'lote_aprovar_limpos'>,
  ): Promise<SaidaRota<'lote_aprovar_limpos'>> {
    await this.orq.aprovarLimpos(p.id, e.execucao_ids);
    return { ok: true };
  }

  async lote_pausar(p: ParametrosRota<'lote_pausar'>): Promise<SaidaRota<'lote_pausar'>> {
    this.orq.pausarLote(p.id);
    return { ok: true };
  }

  async lote_cancelar_pendentes(
    p: ParametrosRota<'lote_cancelar_pendentes'>,
    e: EntradaRota<'lote_cancelar_pendentes'>,
  ): Promise<SaidaRota<'lote_cancelar_pendentes'>> {
    await this.orq.cancelarPendentesDoLote(p.id, e.execucao_ids);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Fila de merge e outbox (06 §4.6)
  // -------------------------------------------------------------------------

  async merge_obter(
    _p: ParametrosRota<'merge_obter'>,
    f: EntradaRota<'merge_obter'>,
  ): Promise<SaidaRota<'merge_obter'>> {
    const d = await this.banco.ler(async (r) => ({
      itens: await r.filaMerge.ativos(),
      projetos: await r.projetos.listar(),
      ativas: await r.execucoes.listar({ ativas: true }),
      concluidas: await r.execucoes.listar({ estados: ['concluido'] }),
    }));
    const projetos = new Map(d.projetos.map((p) => [p.id, p]));
    const filas = new Map<string, FilaMergeDestinoDto>();
    for (const item of d.itens) {
      if (f.projeto_id && item.projeto_id !== f.projeto_id) continue;
      const p = projetos.get(item.projeto_id);
      const chave = `${item.projeto_id}\u0000${item.branch_destino}`;
      const e = d.ativas.find((x) => x.id === item.execucao_id);
      const c = e ? await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id)) : null;
      const aprov = await this.banco.ler((r) => r.aprovacoes.obter(item.aprovacao_id));
      const ordemPassos: ItemFilaMergeDto['passos'][number]['chave'][] = [
        'integrar',
        'conferir_patch',
        'reverificar',
        'push',
        'avancar_ref',
      ];
      const atualIdx =
        item.estado === 'integrando'
          ? 0
          : item.estado === 'verificando'
            ? 2
            : item.estado === 'publicando'
              ? 3
              : item.estado === 'concluido'
                ? 5
                : -1;
      const dto: ItemFilaMergeDto = {
        id: item.id,
        ordem: item.ordem,
        execucao_id: item.execucao_id,
        numero: e?.numero ?? 0,
        titulo: c?.titulo ?? '',
        patch_id: aprov?.patch_id ?? '',
        estado: item.estado,
        motivo: item.motivo,
        passos: ordemPassos.map((chave, i) => ({
          chave,
          estado:
            atualIdx < 0
              ? item.estado === 'conflito' && i === 0
                ? 'falhou'
                : 'pendente'
              : i < atualIdx
                ? 'feito'
                : i === atualIdx
                  ? 'atual'
                  : 'pendente',
          detalhe: null,
        })),
        sha_destino_antes: item.sha_destino_antes,
        copia_local_atras: item.copia_local_atras,
      };
      const fila = filas.get(chave) ?? {
        projeto_id: item.projeto_id,
        projeto_nome: p?.nome ?? '',
        branch_destino: item.branch_destino,
        remoto: p ? this.n.configDoProjeto(p).repo.remoto : null,
        modo_entrega: p ? this.n.configDoProjeto(p).entrega.modo : 'merge_e_push',
        itens: [],
        aviso_copia_local: null,
      };
      fila.itens.push(dto);
      if (item.copia_local_atras)
        fila.aviso_copia_local = `Sua ${item.branch_destino} local está atrás ou com alterações: atualize quando puder.`;
      filas.set(chave, fila);
    }
    const pendencias = [];
    for (const e of d.ativas.filter(
      (x) => x.estado === 'mergeado_pendente_chamado' || x.estado === 'comunicando',
    )) {
      const linhas = await this.banco.ler((r) => r.outbox.listar(e.id));
      const l = linhas.find((x) => x.estado === 'bloqueado' || (x.estado === 'pendente' && x.erro));
      if (!l) continue;
      pendencias.push({
        execucao_id: e.id,
        numero: e.numero,
        sha_merge: e.sha_merge,
        passo: l.passo,
        erro: l.erro ?? '',
        ultimo_http: l.ultimo_http,
        proxima_em: l.proxima_em,
      });
    }
    const aPublicar = [];
    for (const e of d.ativas.filter((x) => x.estado === 'aguardando_deploy')) {
      const c = await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id));
      aPublicar.push({
        execucao_id: e.id,
        numero: e.numero,
        titulo: c?.titulo ?? '',
        sha_merge: e.sha_merge ?? '',
      });
    }
    const limite = this.n.agora().getTime() - 7 * 86_400_000;
    const concluidos = [];
    for (const e of d.concluidas.filter(
      (x) => x.concluido_em && Date.parse(x.concluido_em) >= limite,
    )) {
      const c = await this.banco.ler((r) => r.chamados.obter(e.chamado_cache_id));
      const fonte = this.n.fonte(e.conexao_id);
      concluidos.push({
        execucao_id: e.id,
        numero: e.numero,
        titulo: c?.titulo ?? '',
        status_final: c?.status ?? 'resolvido',
        concluido_em: e.concluido_em as string,
        url_no_chamados: fonte ? `${fonte.urlBase}/chamados/${e.numero}` : '',
      });
    }
    let token: SaidaRota<'merge_obter'>['token_schema'] = null;
    for (const [chave, donos] of Object.entries(this.n.vagas.semaforos.schema.ocupantes)) {
      const dono = donos[0];
      if (!dono) continue;
      const e = d.ativas.find((x) => x.id === dono);
      token = {
        projeto_id: chave.split('\u0000')[0] ?? '',
        execucao_id: dono,
        numero: e?.numero ?? 0,
        preso: e?.estado === 'precisa_humano',
      };
    }
    return {
      filas: [...filas.values()],
      pendencias_chamados: pendencias,
      a_publicar: aPublicar,
      concluidos_recentes: concluidos,
      token_schema: token,
      sentinelas: d.ativas
        .filter(
          (e) => e.sentinela && e.sentinela.divergencias.length && !e.sentinela.reconhecida_em,
        )
        .map((e) => ({
          projeto_id: e.projeto_id,
          execucao_id: e.id,
          numero: e.numero,
          divergencias: e.sentinela?.divergencias ?? [],
        })),
    };
  }

  async merge_reordenar(
    p: ParametrosRota<'merge_reordenar'>,
    e: EntradaRota<'merge_reordenar'>,
  ): Promise<SaidaRota<'merge_reordenar'>> {
    await this.orq.reordenarItem(p.id, e.nova_ordem);
    return { ok: true };
  }

  async merge_publicado_producao(
    _p: ParametrosRota<'merge_publicado_producao'>,
    e: EntradaRota<'merge_publicado_producao'>,
  ): Promise<SaidaRota<'merge_publicado_producao'>> {
    await this.orq.publicadoProducao(e.execucao_ids);
    return { ok: true };
  }

  async merge_liberar_token_schema(
    _p: ParametrosRota<'merge_liberar_token_schema'>,
    e: EntradaRota<'merge_liberar_token_schema'>,
  ): Promise<SaidaRota<'merge_liberar_token_schema'>> {
    const dono = this.orq.liberarTokenSchema(e.projeto_id);
    if (!dono) throw new ErroForja('conflito', 'nenhum token de schema preso neste projeto', 409);
    return { ok: true, execucao_id: dono };
  }

  outbox_tentar_agora(p: ParametrosRota<'outbox_tentar_agora'>) {
    return this.orq.outboxTentarAgora(p.id);
  }

  // -------------------------------------------------------------------------
  // Projetos (06 §4.8; FJ-030 §1, §5) — só `repo_dir` é obrigatório
  // -------------------------------------------------------------------------

  private async projetoResumo(p: Projeto) {
    const d = await this.banco.ler(async (r) => ({
      conexao: await r.conexoes.obter(p.conexao_id),
      maps: await r.projetos.listarMapeamentos(p.id),
    }));
    return {
      id: p.id,
      nome: p.nome,
      slug: p.slug,
      conexao_id: p.conexao_id,
      conexao_nome: d.conexao?.nome ?? '',
      ativo: p.ativo,
      branch_destino: this.n.configDoProjeto(p).repo.branch_destino,
      sistemas: d.maps.map((m) => m.sistema_nome),
    };
  }

  async projetos_listar(): Promise<SaidaRota<'projetos_listar'>> {
    const ps = await this.banco.ler((r) => r.projetos.listar());
    const out = [];
    for (const p of ps) out.push(await this.projetoResumo(p));
    return { projetos: out };
  }

  /**
   * Sistemas-alvo conhecidos da conexão: os do servidor (`/sistemas-alvo`) e,
   * se ele não responder, os vistos na fila e os já mapeados.
   */
  private async sistemasConhecidos(conexaoId: string): Promise<SistemaDoChamados[]> {
    const porNome = new Map<string, SistemaDoChamados>();
    const fonte = this.n.fonte(conexaoId);
    if (fonte?.podeUsar()) {
      try {
        const r = await fonte.api.listarSistemasAlvo();
        for (const s of r.sistemas) porNome.set(s.nome, { id: s.id, nome: s.nome });
      } catch (e) {
        this.n.log(`sistemas-alvo de ${conexaoId}: ${(e as Error).message}`);
      }
    }
    const d = await this.banco.ler(async (r) => ({
      chamados: await r.chamados.listar(conexaoId),
      maps: await r.projetos.listarTodosMapeamentos(conexaoId),
    }));
    for (const m of d.maps) {
      if (!porNome.has(m.sistema_nome)) {
        porNome.set(m.sistema_nome, { id: m.sistema_alvo_id, nome: m.sistema_nome });
      }
    }
    for (const c of d.chamados) {
      if (c.sistema_nome && !porNome.has(c.sistema_nome)) {
        porNome.set(c.sistema_nome, { id: null, nome: c.sistema_nome });
      }
    }
    return [...porNome.values()];
  }

  /** Nome do sistema → nome do OUTRO projeto que o mapeia (UNIQUE por conexão). */
  private async sistemasDeOutros(
    conexaoId: string,
    projetoId: string | null,
  ): Promise<Map<string, string>> {
    return this.banco.ler(async (r) => {
      const maps = await r.projetos.listarTodosMapeamentos(conexaoId);
      const nomes = new Map((await r.projetos.listar()).map((p) => [p.id, p.nome]));
      return new Map(
        maps
          .filter((m) => m.projeto_id !== projetoId)
          .map((m) => [m.sistema_nome, nomes.get(m.projeto_id) ?? '?']),
      );
    });
  }

  /** Mapeia os sistemas do projeto: a lista explícita ou o casamento automático (FJ-030 §1). */
  private async aplicarSistemas(projeto: Projeto): Promise<void> {
    const escolhidos = sistemasDoProjeto({
      explicitos: projeto.sistemas ?? undefined,
      sistemas: await this.sistemasConhecidos(projeto.conexao_id),
      projeto: { nome: projeto.nome, repo_dir: projeto.repo_dir },
      deOutros: await this.sistemasDeOutros(projeto.conexao_id, projeto.id),
    });
    await this.banco.transacao((r) => r.projetos.definirSistemas(projeto.id, escolhidos));
  }

  async projeto_obter(p: ParametrosRota<'projeto_obter'>): Promise<SaidaRota<'projeto_obter'>> {
    const lido = await this.banco.ler((r) => r.projetos.obter(p.id));
    if (!lido) throw naoEncontrado('projeto');
    // Abrir a tela relê o repositório: o "Detectado" mostra o estado de agora.
    const projeto = await this.n.redetectar(lido);
    const d = await this.banco.ler(async (r) => ({
      maps: await r.projetos.listarMapeamentos(projeto.id),
      chamados: await r.chamados.listar(projeto.conexao_id),
    }));
    const dto: ProjetoDto = {
      ...(await this.projetoResumo(projeto)),
      config_versao: projeto.config_versao,
      config: configDoProjeto(projeto),
      detectado:
        projeto.detectado ?? detectadoVazio(projeto.repo_dir, 'repositório ainda não lido'),
      resolvida: this.n.configDoProjeto(projeto),
      casamento_sistemas: montarCasamento({
        sistemas: await this.sistemasConhecidos(projeto.conexao_id),
        projeto: { nome: projeto.nome, repo_dir: projeto.repo_dir },
        ligados: d.maps.map((m) => m.sistema_nome),
        deOutros: await this.sistemasDeOutros(projeto.conexao_id, projeto.id),
      }),
      versao_cli_fixada: projeto.versao_cli_fixada,
      mapeamentos: d.maps.map((m) => ({
        id: m.id,
        sistema_nome: m.sistema_nome,
        sistema_alvo_id: m.sistema_alvo_id,
      })),
      sistemas_vistos: [
        ...new Set(d.chamados.map((c) => c.sistema_nome).filter((s): s is string => !!s)),
      ].sort(),
      pasta_worktrees: join(this.n.deps.dirDados, 'worktrees', projeto.slug),
    };
    return dto;
  }

  private validarConfig(config: unknown): ConfigProjeto {
    const r = ConfigProjetoSchema.safeParse(config);
    if (!r.success) {
      throw new ErroForja(
        'entrada_invalida',
        'configuração do projeto inválida',
        400,
        r.error.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })),
      );
    }
    return r.data;
  }

  /** A pasta tem de ser um repositório git; devolve a raiz (`rev-parse --show-toplevel`). */
  private async exigirRepositorio(dir: string): Promise<string> {
    try {
      return await raizDoRepositorio(dir);
    } catch (e) {
      if (e instanceof ErroRepositorio) {
        throw new ErroForja('entrada_invalida', e.message, 400, [
          { campo: 'config.repo_dir', mensagem: e.message },
        ]);
      }
      throw e;
    }
  }

  /** Conexão explícita ou a única/primeira cadastrada (FJ-030 §5: a pessoa não escolhe). */
  private async conexaoPadrao(conexaoId: string | undefined): Promise<string> {
    const conexoes = await this.banco.ler((r) => r.conexoes.listar());
    if (conexaoId) {
      if (!conexoes.some((c) => c.id === conexaoId)) throw naoEncontrado('conexão');
      return conexaoId;
    }
    const primeira = conexoes[0];
    if (!primeira) {
      throw new ErroForja('pre_condicao_falhou', 'cadastre a conexão com o Chamados primeiro', 409);
    }
    return primeira.id;
  }

  private async slugLivre(base: string, ignorar: string | null): Promise<string> {
    const raiz = slugDe(base) || 'projeto';
    for (let i = 1; ; i++) {
      const candidato = i === 1 ? raiz : `${raiz}-${i}`;
      const dono = await this.banco.ler((r) => r.projetos.obterPorSlug(candidato));
      if (!dono || dono.id === ignorar) return candidato;
    }
  }

  async projeto_criar(
    _p: ParametrosRota<'projeto_criar'>,
    e: EntradaRota<'projeto_criar'>,
  ): Promise<SaidaRota<'projeto_criar'>> {
    const lida = this.validarConfig(e.config);
    const config = { ...lida, repo_dir: await this.exigirRepositorio(lida.repo_dir) };
    const conexaoId = await this.conexaoPadrao(e.conexao_id);
    const slug = e.slug ? slugDe(e.slug) : await this.slugLivre(config.nome, null);
    if (!slug) throw new ErroForja('entrada_invalida', 'slug inválido', 400);
    const detectado = await (this.n.deps.autodetectar ?? autodetectarProjeto)(config.repo_dir);
    const p = await this.banco.transacao(async (r) => {
      if (await r.projetos.obterPorSlug(slug))
        throw new ErroForja('conflito', 'já existe projeto com esse slug', 409);
      return r.projetos.criar({
        slug,
        conexao_id: conexaoId,
        config,
        ativo: e.ativo ?? true,
        versao_cli_fixada: e.versao_cli_fixada ?? null,
        detectado,
      });
    });
    await this.aplicarSistemas(p);
    // URL do remoto confirmada no cadastro (05 §9).
    await capturarUrlRemoto(this.n, p.id);
    return { id: p.id };
  }

  async projeto_atualizar(
    p: ParametrosRota<'projeto_atualizar'>,
    e: EntradaRota<'projeto_atualizar'>,
  ): Promise<SaidaRota<'projeto_atualizar'>> {
    const atual = await this.banco.ler((r) => r.projetos.obter(p.id));
    if (!atual) throw naoEncontrado('projeto');
    const lida = this.validarConfig(e.config);
    const config = { ...lida, repo_dir: await this.exigirRepositorio(lida.repo_dir) };
    const conexaoId = e.conexao_id ? await this.conexaoPadrao(e.conexao_id) : atual.conexao_id;
    const slug = e.slug ? slugDe(e.slug) : atual.slug;
    const salvo = await this.banco.transacao(async (r) => {
      const dono = await r.projetos.obterPorSlug(slug);
      if (dono && dono.id !== p.id)
        throw new ErroForja('conflito', 'já existe projeto com esse slug', 409);
      return r.projetos.atualizar(p.id, {
        slug,
        conexao_id: conexaoId,
        config,
        ativo: e.ativo ?? atual.ativo,
        versao_cli_fixada:
          e.versao_cli_fixada !== undefined ? e.versao_cli_fixada : atual.versao_cli_fixada,
      });
    });
    const detectado = await this.n.redetectar(salvo);
    await this.aplicarSistemas(detectado);
    await capturarUrlRemoto(this.n, p.id);
    return { id: p.id };
  }

  /** Onboarding / "Escolher pasta…" (FJ-030 §5): valida e mostra o detectado, sem gravar. */
  async projeto_detectar(
    _p: ParametrosRota<'projeto_detectar'>,
    e: EntradaRota<'projeto_detectar'>,
  ): Promise<SaidaRota<'projeto_detectar'>> {
    const dir = (e.repo_dir ?? '').trim();
    if (!dir.startsWith('/')) {
      return {
        valido: false,
        erro: 'use o caminho absoluto da pasta',
        nome_sugerido: '',
        detectado: null,
        casamento_sistemas: [],
      };
    }
    let detectado;
    try {
      detectado = await (this.n.deps.autodetectar ?? autodetectarProjeto)(dir);
    } catch (err) {
      if (!(err instanceof ErroRepositorio)) throw err;
      return {
        valido: false,
        erro: err.message,
        nome_sugerido: nomeDaPasta(dir),
        detectado: null,
        casamento_sistemas: [],
      };
    }
    const nome = nomeDaPasta(detectado.repo_dir);
    let casamento: SistemaCasadoDto[] = [];
    const conexoes = await this.banco.ler((r) => r.conexoes.listar());
    const conexaoId = e.conexao_id ?? conexoes[0]?.id;
    if (conexaoId) {
      const sistemas = await this.sistemasConhecidos(conexaoId);
      const projeto = { nome, repo_dir: detectado.repo_dir };
      const sugeridos = casarSistemas(sistemas, projeto).map((s) => s.nome);
      casamento = montarCasamento({
        sistemas,
        projeto,
        ligados: sugeridos,
        deOutros: await this.sistemasDeOutros(conexaoId, null),
      });
    }
    return {
      valido: true,
      erro: null,
      nome_sugerido: nome,
      detectado,
      casamento_sistemas: casamento,
    };
  }

  async projeto_testar_detectores(
    p: ParametrosRota<'projeto_testar_detectores'>,
    e: EntradaRota<'projeto_testar_detectores'>,
  ): Promise<SaidaRota<'projeto_testar_detectores'>> {
    const projeto = await this.banco.ler((r) => r.projetos.obter(p.id));
    if (!projeto) throw naoEncontrado('projeto');
    const sha = await resolverSha(projeto.repo_dir, e.sha);
    if (!sha) throw new ErroForja('entrada_invalida', 'commit inexistente', 400);
    const pai = (await resolverSha(projeto.repo_dir, `${sha}^`)) ?? sha;
    const s = await selosDoDiff({
      dir: projeto.repo_dir,
      base: pai,
      sha,
      detectores: this.n.configDoProjeto(projeto).detectores,
    });
    return { selos: s.selos, por_arquivo: s.por_arquivo };
  }

  // -------------------------------------------------------------------------
  // Configurações globais (FJ-030 §2)
  // -------------------------------------------------------------------------

  private configuracoesDto(c: ConfiguracoesGlobais): SaidaRota<'configuracoes_obter'> {
    return {
      configuracoes: c,
      padrao: configuracoesGlobaisPadrao(),
      arquivo: this.n.configuracoes.caminho,
    };
  }

  private traduzirConfiguracoes<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof ErroConfiguracoes) {
        throw new ErroForja('entrada_invalida', e.message, 400, e.problemas);
      }
      throw e;
    }
  }

  async configuracoes_obter(): Promise<SaidaRota<'configuracoes_obter'>> {
    return this.configuracoesDto(this.traduzirConfiguracoes(() => this.n.configuracoes.ler()));
  }

  /** Não afeta execuções já iniciadas (snapshot); a concorrência vale na hora. */
  async configuracoes_gravar(
    _p: ParametrosRota<'configuracoes_gravar'>,
    e: EntradaRota<'configuracoes_gravar'>,
  ): Promise<SaidaRota<'configuracoes_gravar'>> {
    return this.configuracoesDto(this.traduzirConfiguracoes(() => this.n.configuracoes.gravar(e)));
  }

  async configuracoes_restaurar(): Promise<SaidaRota<'configuracoes_restaurar'>> {
    return this.configuracoesDto(this.n.configuracoes.restaurar());
  }

  // -------------------------------------------------------------------------
  // Conexão (06 §4.9) — token e senha nunca saem
  // -------------------------------------------------------------------------

  private conexoes(): PortaConexoes {
    if (!this.deps.conexoes) throw naoDisponivel('Conexões');
    return this.deps.conexoes;
  }

  async conexoes_listar(): Promise<SaidaRota<'conexoes_listar'>> {
    const lista = await this.banco.ler((r) => r.conexoes.listar());
    return {
      conexoes: lista.map((c) => {
        const st = this.deps.conexoes?.estado(c.id) ?? {
          estado: c.token_cifrado ? 'ok' : 'sem_login',
          erro: null,
          avisos: [],
        };
        return {
          id: c.id,
          nome: c.nome,
          url_base: c.url_base,
          tenant_slug: c.tenant_slug,
          ambiente: c.ambiente,
          email: c.email,
          usuario: c.usuario_id
            ? { id: c.usuario_id, nome: c.usuario_nome ?? '', papel: c.papel ?? '' }
            : null,
          local_senha: c.local_senha,
          token_valido_ate: c.token_expira_em,
          ultimo_login_em: c.ultimo_login_em,
          estado: st.estado,
          erro: st.erro,
          avisos: st.avisos,
        } satisfies ConexaoDto;
      }),
    };
  }

  async conexao_criar(
    _p: ParametrosRota<'conexao_criar'>,
    e: EntradaRota<'conexao_criar'>,
  ): Promise<SaidaRota<'conexao_criar'>> {
    const { validarUrlConexao } = await import('../chamados/conexao');
    let url: string;
    try {
      url = validarUrlConexao(e.url_base);
    } catch (erro) {
      throw new ErroForja('entrada_invalida', (erro as Error).message, 400);
    }
    const c = await this.banco.transacao((r) =>
      r.conexoes.criar({
        nome: e.nome,
        url_base: url,
        tenant_slug: e.tenant_slug,
        ambiente: e.ambiente,
        email: e.email,
        local_senha: e.local_senha,
      }),
    );
    if (e.senha) await this.conexoes().guardarSenha(c.id, e.senha, e.local_senha);
    return { id: c.id };
  }

  async conexao_atualizar(
    p: ParametrosRota<'conexao_atualizar'>,
    e: EntradaRota<'conexao_atualizar'>,
  ): Promise<SaidaRota<'conexao_atualizar'>> {
    const { validarUrlConexao } = await import('../chamados/conexao');
    let url: string;
    try {
      url = validarUrlConexao(e.url_base);
    } catch (erro) {
      throw new ErroForja('entrada_invalida', (erro as Error).message, 400);
    }
    await this.banco.transacao(async (r) => {
      await r.conexoes.exigir(p.id);
      await r.conexoes.atualizar(p.id, {
        nome: e.nome,
        url_base: url,
        tenant_slug: e.tenant_slug,
        ambiente: e.ambiente,
        email: e.email,
        local_senha: e.local_senha,
      });
    });
    if (e.senha) await this.conexoes().guardarSenha(p.id, e.senha, e.local_senha);
    this.deps.conexoes?.recarregar(p.id);
    return { id: p.id };
  }

  conexao_testar(p: ParametrosRota<'conexao_testar'>) {
    return this.conexoes().testar(p.id);
  }

  conexao_relogar(p: ParametrosRota<'conexao_relogar'>, e: EntradaRota<'conexao_relogar'>) {
    return this.conexoes().relogar(p.id, e.senha);
  }

  async conexao_esquecer(
    p: ParametrosRota<'conexao_esquecer'>,
  ): Promise<SaidaRota<'conexao_esquecer'>> {
    await this.conexoes().esquecer(p.id);
    await this.banco.transacao((r) => r.conexoes.limparToken(p.id));
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Diagnóstico (06 §4.10)
  // -------------------------------------------------------------------------

  diagnostico_obter() {
    if (!this.deps.diagnostico) throw naoDisponivel('Diagnóstico');
    return this.deps.diagnostico.obter();
  }

  diagnostico_rodar() {
    if (!this.deps.diagnostico) throw naoDisponivel('Diagnóstico');
    return this.deps.diagnostico.rodar();
  }

  diagnostico_aceitar_versao_cli(
    _p: ParametrosRota<'diagnostico_aceitar_versao_cli'>,
    e: EntradaRota<'diagnostico_aceitar_versao_cli'>,
  ) {
    if (!this.deps.diagnostico) throw naoDisponivel('Diagnóstico');
    return this.deps.diagnostico.aceitarVersaoCli(e.versao);
  }

  // -------------------------------------------------------------------------
  // Histórico e worktrees (06 §4.11; métricas de 00 §10)
  // -------------------------------------------------------------------------

  async historico_listar(
    _p: ParametrosRota<'historico_listar'>,
    f: EntradaRota<'historico_listar'>,
  ): Promise<SaidaRota<'historico_listar'>> {
    const estados = f.resultado?.length
      ? f.resultado
      : (['concluido', 'descartado', 'cancelado'] as const);
    const d = await this.banco.ler(async (r) => ({
      execs: await r.execucoes.listar({
        estados: [...estados],
        ...(f.projeto_id ? { projeto_id: f.projeto_id } : {}),
      }),
      projetos: await r.projetos.listar(),
    }));
    const noPeriodo = d.execs.filter(
      (e) =>
        (!f.de || (e.concluido_em ?? '') >= f.de) && (!f.ate || (e.concluido_em ?? '') <= f.ate),
    );
    const itens = [];
    let semAjuste = 0;
    let perguntas = 0;
    let incoerentes = 0;
    let condutor = 0;
    let barradas = 0;
    let tempoAte = 0;
    let comTempo = 0;
    for (const e of noPeriodo) {
      const x = await this.banco.ler(async (r) => ({
        c: await r.chamados.obter(e.chamado_cache_id),
        aprovs: await r.aprovacoes.listar(e.id),
        diff: await r.artefatos.ultimaVersao(e.id, 'diff'),
        rel: await r.artefatos.ultimaVersao(e.id, 'relatorio'),
        etapas: await r.etapas.listar(e.id),
        evid: await r.artefatos.listar(e.id, { tipo: 'evidencia' }),
        outbox: await r.outbox.listar(e.id),
      }));
      if (
        !x.aprovs.some((a) => a.decisao === 'ajustes_pedidos') &&
        !(await this.banco.ler((r) => r.comentarios.listar(e.id))).some((c) => c.alvo === 'diff')
      )
        semAjuste += 1;
      if (x.aprovs.some((a) => a.comentario === 'perguntar_cliente')) perguntas += 1;
      if ((x.rel?.conteudo as unknown as RelatorioRegistrado | null)?.regenerado) incoerentes += 1;
      if (x.etapas.some((t) => t.condutor_editou)) condutor += 1;
      if (x.outbox.some((l) => l.passo === 'mensagem_publica' && l.estado === 'bloqueado'))
        barradas += 1;
      const g2 = x.etapas.find((t) => t.tipo === 'relatar' && t.estado === 'concluida');
      if (g2?.fim && e.iniciado_em) {
        tempoAte += Date.parse(g2.fim) - Date.parse(e.iniciado_em);
        comTempo += 1;
      }
      itens.push({
        execucao_id: e.id,
        numero: e.numero,
        titulo: x.c?.titulo ?? '',
        projeto_nome: d.projetos.find((p) => p.id === e.projeto_id)?.nome ?? '',
        estado: e.estado,
        iniciado_em: e.iniciado_em,
        concluido_em: e.concluido_em,
        custo_micro_usd: e.custo_micro_usd,
        ciclo_total: e.ciclo_total,
        patch_id: x.diff?.patch_id ?? null,
        sha_merge: e.sha_merge,
        prints_expirados: x.evid.some(
          (a) => a.caminho && !existsSync(join(this.n.dirExecucao(e.id), a.caminho)),
        ),
      });
    }
    const total = noPeriodo.length;
    const taxa = (v: number) => (total ? v / total : null);
    const concluidos = noPeriodo.filter((e) => e.estado === 'concluido');
    return {
      itens,
      metricas: {
        taxa_aprovacao_sem_ajuste: concluidos.length ? semAjuste / total : null,
        ciclos_medios: total
          ? {
              auto: noPeriodo.reduce((s, e) => s + e.ciclo_auto, 0) / total,
              humano: noPeriodo.reduce((s, e) => s + (e.ciclo_total - e.ciclo_auto), 0) / total,
            }
          : null,
        custo_medio_micro_usd: total
          ? Math.round(noPeriodo.reduce((s, e) => s + e.custo_micro_usd, 0) / total)
          : null,
        tempo_ate_aguardando_ms: comTempo ? Math.round(tempoAte / comTempo) : null,
        taxa_pergunta_cliente: taxa(perguntas),
        taxa_conclusao: taxa(concluidos.length),
        taxa_incoerencia_relatorio: taxa(incoerentes),
        taxa_condutor_editou: taxa(condutor),
        taxa_mensagem_barrada: taxa(barradas),
      },
    };
  }

  async worktrees_listar(): Promise<SaidaRota<'worktrees_listar'>> {
    const d = await this.banco.ler(async (r) => ({
      projetos: await r.projetos.listar(),
      execs: await r.execucoes.listar(),
    }));
    const ativos = new Set(
      d.execs
        .filter((e) => !estadoTerminal(e.estado) && e.worktree_dir)
        .map((e) => e.worktree_dir as string),
    );
    const out: WorktreeDto[] = [];
    for (const p of d.projetos) {
      if (!existsSync(p.repo_dir)) continue;
      const lista = await listarWorktrees(p.repo_dir).catch(() => []);
      const orfas = new Set(
        detectarOrfas(lista, this.n.deps.dirDados, ativos).map((o) => o.worktree.caminho),
      );
      for (const w of lista) {
        if (w.principal) continue;
        if (!w.caminho.startsWith(join(this.n.deps.dirDados, 'worktrees'))) continue;
        const e = d.execs.find((x) => x.worktree_dir === w.caminho);
        out.push({
          caminho: w.caminho,
          branch: w.branch?.replace(/^refs\/heads\//, '') ?? null,
          execucao_id: e?.id ?? null,
          numero: e?.numero ?? null,
          estado_execucao: e?.estado ?? null,
          tamanho_bytes: null,
          ultima_atividade: e?.atualizado_em ?? null,
          orfa: orfas.has(w.caminho),
          prunable: w.prunable,
          projeto_id: p.id,
        });
      }
    }
    return { worktrees: out, total_bytes: 0 };
  }

  async worktree_limpar(
    _p: ParametrosRota<'worktree_limpar'>,
    e: EntradaRota<'worktree_limpar'>,
  ): Promise<SaidaRota<'worktree_limpar'>> {
    const d = await this.banco.ler(async (r) => ({
      projetos: await r.projetos.listar(),
      execs: await r.execucoes.listar({ ativas: true }),
    }));
    if (d.execs.some((x) => x.worktree_dir === e.caminho)) {
      throw new ErroForja(
        'conflito',
        'a worktree pertence a uma execução ativa: descarte-a antes',
        409,
      );
    }
    for (const p of d.projetos) {
      const lista = await listarWorktrees(p.repo_dir).catch(() => []);
      const w = lista.find((x) => x.caminho === e.caminho);
      if (!w) continue;
      await removerWorktree(p.repo_dir, e.caminho, {
        dirDados: this.n.deps.dirDados,
        apagarBranch: e.apagar_branch ? w.branch?.replace(/^refs\/heads\//, '') : null,
      });
      return { ok: true };
    }
    throw naoEncontrado('worktree');
  }

  // -------------------------------------------------------------------------
  // Terminal (06 §4.7; 01 §11)
  // -------------------------------------------------------------------------

  private terminal(): GerenteSessoesTerminal {
    const t = this.deps.terminal ?? this.n.deps.terminal;
    if (!t) throw naoDisponivel('Terminal');
    return t;
  }

  async terminal_sessoes(): Promise<SaidaRota<'terminal_sessoes'>> {
    const t = this.terminal();
    const sessoes: SessaoTerminalDto[] = [];
    for (const s of t.listar()) {
      const e = s.execucao_id
        ? await this.banco.ler((r) => r.execucoes.obter(s.execucao_id as string))
        : null;
      const etapa = s.etapa_id
        ? await this.banco.ler((r) => r.etapas.obter(s.etapa_id as string))
        : null;
      sessoes.push({
        id: s.id,
        tipo: s.tipo,
        titulo: s.titulo,
        cwd: s.cwd,
        execucao_id: s.execucao_id,
        numero: e?.numero ?? null,
        etapa_tipo: etapa?.tipo ?? null,
        session_id_claude: s.session_id_claude,
        viva: s.viva,
        aberta_em: s.aberta_em,
        encerrada_em: s.encerrada_em,
      });
    }
    return { sessoes, limite: t.limite };
  }

  async terminal_abrir(
    _p: ParametrosRota<'terminal_abrir'>,
    e: EntradaRota<'terminal_abrir'>,
  ): Promise<SaidaRota<'terminal_abrir'>> {
    const t = this.terminal();
    const projeto = await this.banco.ler((r) => r.projetos.obter(e.projeto_id));
    if (!projeto) throw naoEncontrado('projeto');
    let cwd = projeto.repo_dir;
    let titulo = `${projeto.nome} · repositório`;
    if (e.execucao_id) {
      const ex = await this.exec(e.execucao_id);
      if (!ex.worktree_dir)
        throw new ErroForja('pre_condicao_falhou', 'a execução não tem worktree', 409);
      cwd = ex.worktree_dir;
      titulo = `#${ex.numero} · worktree`;
    }
    const info = t.abrirLivre({ cwd, titulo, execucao_id: e.execucao_id ?? null });
    await this.banco.transacao(async (r) => {
      const linha = await r.terminais.abrir({
        tipo: 'livre',
        cwd,
        execucao_id: e.execucao_id ?? null,
        pid: info.pid,
        pgid: info.pid,
      });
      await r.m.update(SessaoTerminalSchema, { id: linha.id }, { id: info.id });
    });
    return { sessao_id: info.id };
  }

  async terminal_encerrar(
    p: ParametrosRota<'terminal_encerrar'>,
  ): Promise<SaidaRota<'terminal_encerrar'>> {
    await this.terminal().encerrar(p.id);
    await this.banco.transacao(async (r) => {
      const s = await r.terminais.obter(p.id);
      if (s && !s.encerrada_em && s.tipo === 'livre') await r.terminais.encerrar(p.id);
    });
    return { ok: true };
  }

  async terminal_reabrir(
    p: ParametrosRota<'terminal_reabrir'>,
  ): Promise<SaidaRota<'terminal_reabrir'>> {
    const info = this.terminal().reabrir(p.id);
    return { sessao_id: info.id };
  }
}

/** Para o registrador de rotas: `ErroForja` → `{ status, corpo: ErroApiDto }`. */
export function erroParaApi(e: unknown): {
  status: ErroForja['status'];
  corpo: { erro: ErroForja['codigo']; mensagem: string; detalhes?: unknown };
} {
  if (e instanceof ErroForja) {
    return {
      status: e.status,
      corpo: {
        erro: e.codigo,
        mensagem: e.message,
        ...(e.detalhes !== undefined ? { detalhes: e.detalhes } : {}),
      },
    };
  }
  return {
    status: 500,
    corpo: { erro: 'erro_interno', mensagem: e instanceof Error ? e.message : String(e) },
  };
}

/** Referência rápida de sha curto para mensagens (UI e testes). */
export { sha8, achadosEmAberto, avaliarFreio, avaliarPublicacao };
