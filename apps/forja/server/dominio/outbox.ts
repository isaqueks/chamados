import type { EstadoOutbox, PassoOutbox } from '../../comum/estados';
import type { RelatorioRegistrado, RespostaRegistrada } from '../../comum/contratos';
import { hashCorpo } from '../chamados/normalizacao';
import { montarNotaConclusao, montarNotaDescarte, montarNotaInicio } from '../chamados/notas';
import { executarPasso, type EntradaPasso, type ResultadoPasso } from '../chamados/outbox-passos';
import {
  chavesDosMotivos,
  validarRespostaPublica,
  type TipoResposta,
} from '../chamados/validador-linguagem';
import { OutboxChamadoSchema } from '../db/entidades/outbox-chamado';
import type { OutboxChamado } from '../db/entidades/outbox-chamado';
import type { NovoPassoOutbox } from '../db/repositorios/outbox-chamado';
import { ESTADOS_POS_MERGE, ESTADOS_ANTES_DE_MERGEADO } from './maquina-execucao';
import type { Nucleo } from './nucleo';

/**
 * Outbox para o Chamados (specs/forja/03 §9; 07 §3, §9): a MÁQUINA do outbox —
 * rodadas, despacho em ordem, backoff, reconciliação de `enviando` e o efeito
 * de cada resultado na execução. A chamada de cada passo (ler antes de
 * escrever, "já feito?", tradução de erros) é de `server/chamados/outbox-passos`.
 *
 * Regras que vivem aqui:
 * - um passo por vez por rodada, na `ordem` (cabeças de `prontos()`); a
 *   intenção (`enviando` + `enviado_em` da 1ª tentativa) é gravada ANTES da
 *   chamada de rede (03 §9.2), e nunca dentro de uma transação aberta;
 * - `retentar`/`reconectar` → backoff 1, 2, 4… até 30 min (03 §9.3); na rodada
 *   de encerramento a execução vai a `mergeado_pendente_chamado`;
 * - `precisa_humano` antes do merge → `precisa_humano` da execução; depois do
 *   merge → passo `bloqueado` (o código já está no destino, 03 §2.5);
 * - rodada de encerramento completa → `concluido`; só retidos restando →
 *   `aguardando_deploy` (Gdeploy libera, 03 §9.4).
 */

export type TipoRodada = 'inicio' | 'pergunta' | 'replanejar' | 'encerramento' | 'descarte';

/** Teto do backoff (03 §9.3). */
export const BACKOFF_MAX_MS = 30 * 60_000;

/** 1, 2, 4… min até 30 min. */
export function backoffMs(tentativas: number): number {
  return Math.min(BACKOFF_MAX_MS, 60_000 * 2 ** Math.max(0, tentativas));
}

/** O tipo da rodada é deduzido dos passos (02 §4.13 não tem coluna de tipo). */
export function tipoDaRodada(passos: readonly Pick<OutboxChamado, 'passo'>[]): TipoRodada {
  const tem = (p: PassoOutbox) => passos.some((x) => x.passo === p);
  if (tem('nota_interna') || tem('mensagem_publica') || tem('status_resolvido'))
    return 'encerramento';
  if (tem('nota_inicio') || tem('silenciar_ia') || tem('atribuir')) return 'inicio';
  if (tem('pergunta_publica')) return 'pergunta';
  if (tem('nota_descarte')) return 'descarte';
  return 'replanejar';
}

const RESOLVIDOS: readonly EstadoOutbox[] = ['enviado', 'pulado'];

/** Situação de uma rodada (para decidir a transição da execução). */
export function situacaoRodada(
  passos: readonly Pick<OutboxChamado, 'estado'>[],
): 'concluida' | 'so_retidos' | 'bloqueada' | 'em_andamento' {
  if (passos.length > 0 && passos.every((p) => RESOLVIDOS.includes(p.estado))) return 'concluida';
  if (passos.some((p) => p.estado === 'bloqueado')) return 'bloqueada';
  const abertos = passos.filter((p) => !RESOLVIDOS.includes(p.estado));
  if (abertos.length > 0 && abertos.every((p) => p.estado === 'retido')) return 'so_retidos';
  return 'em_andamento';
}

/**
 * Projetos travados pela sentinela (03 §2.5; 05 §4.9): alguma execução do
 * projeto — ativa OU terminal — tem divergência não reconhecida. Descartar a
 * execução divergente não destrava: só "Reconhecer" destrava.
 */
export async function projetosTravados(n: Nucleo): Promise<Set<string>> {
  const execs = await n.banco.ler((r) => r.execucoes.listar());
  return new Set(
    execs
      .filter(
        (e) => e.sentinela && e.sentinela.divergencias.length > 0 && !e.sentinela.reconhecida_em,
      )
      .map((e) => e.projeto_id),
  );
}

const PREFIXO_ANTERIOR = 'operador_anterior=';
const PREFIXO_CONFIRMADOS = 'confirmados=';

export class DespachanteOutbox {
  private emProcesso = new Set<string>();

  constructor(private readonly n: Nucleo) {}

  /**
   * Cria a rodada lendo o número e (opcionalmente) conferindo a unicidade na
   * MESMA transação: duas chamadas concorrentes (início × reconciliação, ou
   * dois encerramentos) não criam rodadas duplicadas (I-4).
   */
  private async criar(
    execucaoId: string,
    passos: NovoPassoOutbox[],
    jaExiste?: (linhas: readonly OutboxChamado[]) => boolean,
  ): Promise<number | null> {
    return this.n.banco.transacao(async (r) => {
      const linhas = await r.outbox.listar(execucaoId);
      if (jaExiste?.(linhas)) return null;
      const rodada = linhas.reduce((m, l) => Math.max(m, l.rodada), 0) + 1;
      await r.outbox.criarRodada(execucaoId, rodada, passos);
      return rodada;
    });
  }

  /**
   * Rodada de início (G0 → preparando): `atribuir` → `nota_inicio` (03 §9.1).
   * Sem `silenciar_ia` (FJ-031): a Forja nunca silencia nem reativa a IA do
   * servidor — os passos ficam no enum só para linhas antigas.
   */
  async criarRodadaInicio(execucaoId: string): Promise<void> {
    const existentes = await this.n.banco.ler((r) => r.outbox.listar(execucaoId));
    if (existentes.some((l) => l.passo === 'nota_inicio')) return;
    const e = await this.n.banco.ler((r) => r.execucoes.exigir(execucaoId));
    await this.criar(
      execucaoId,
      [
        { passo: 'atribuir' },
        {
          passo: 'nota_inicio',
          corpo: montarNotaInicio({ execucaoId, branch: e.branch ?? '(sem branch)' }),
        },
      ],
      (linhas) => linhas.some((l) => l.passo === 'nota_inicio'),
    );
  }

  /** Gdec "perguntar ao cliente": pública + `aguardando_cliente` (07 §8). */
  async criarRodadaPergunta(
    execucaoId: string,
    texto: string,
    confirmados: readonly string[],
  ): Promise<void> {
    await this.criar(execucaoId, [
      {
        passo: 'pergunta_publica',
        corpo: texto,
        corpo_hash: hashCorpo(texto),
        motivo: `${PREFIXO_CONFIRMADOS}${JSON.stringify(confirmados)}`,
      },
      {
        passo: 'status_aguardando_cliente',
        status_alvo: 'aguardando_cliente',
        motivo: 'pergunta_via_forja',
      },
    ]);
  }

  /** "Replanejar" depois da resposta do cliente: leva o chamado a `em_atendimento` (07 §8.2). */
  async criarRodadaReplanejar(execucaoId: string): Promise<void> {
    await this.criar(execucaoId, [
      {
        passo: 'status_em_atendimento',
        status_alvo: 'em_atendimento',
        motivo: 'retomada_via_forja',
      },
    ]);
  }

  /** Rodada de encerramento (03 §9.1), montada da aprovação vigente e do relatório aprovado. */
  async criarRodadaEncerramento(execucaoId: string): Promise<void> {
    const n = this.n;
    const dados = await n.banco.ler(async (r) => {
      const e = await r.execucoes.exigir(execucaoId);
      const ap = e.aprovacao_vigente_id ? await r.aprovacoes.obter(e.aprovacao_vigente_id) : null;
      const rel = await r.artefatos.ultimaVersao(execucaoId, 'relatorio');
      const resp = await r.artefatos.ultimaVersao(execucaoId, 'resposta');
      const linhas = await r.outbox.listar(execucaoId);
      return { e, ap, rel, resp, linhas };
    });
    if (dados.linhas.some((l) => l.passo === 'nota_interna')) return;
    const { e, ap } = dados;
    const cfg = e.config_snapshot;
    const relatorio = dados.rel?.conteudo as unknown as RelatorioRegistrado | null;
    const resposta = dados.resp?.conteudo as unknown as RespostaRegistrada | null;
    const fonte = n.fonte(e.conexao_id);
    const d036 = fonte?.d036() ?? false;
    const politica = ap?.politica_status ?? cfg.politica_status.ao_concluir;
    const retido: Extract<EstadoOutbox, 'retido'> | undefined =
      politica === 'aguardar_deploy' ? 'retido' : undefined;
    const texto = ap?.texto_resposta ?? resposta?.corpo_markdown ?? '';
    const tipo: TipoResposta = resposta?.tipo ?? 'aguardando_publicacao';
    const confirmados = ap?.validacao_resposta?.publicar_mesmo_assim
      ? chavesDosMotivos(validarRespostaPublica(texto, tipo))
      : [];
    const telas = relatorio?.alteracoes_de_interface.telas ?? [];
    const passos: NovoPassoOutbox[] = [
      {
        passo: 'nota_interna',
        corpo: montarNotaConclusao({
          execucaoId,
          branch: e.branch ?? '',
          shaMerge: e.sha_merge ?? '',
          destino: e.branch_destino,
          modoEntrega: cfg.entrega.modo,
          nivelVerificacao: e.nivel_verificacao ?? 'nao_verificado',
          resumo: relatorio?.resumo ?? '',
          arquivos: [],
          alteraUi: e.selos?.altera_ui ?? false,
          evidenciaVisual: e.evidencia_visual ?? 'nao_se_aplica',
          telas: telas.map((t) => ({
            titulo: t.tela_id,
            o_que_mudou_para_quem_usa: t.o_que_mudou_para_quem_usa,
          })),
          motivoSemPrints: e.evidencia_visual_motivo,
          aprovadoSemPrints: ap?.aprovado_sem_prints ?? false,
        }),
      },
      {
        passo: 'mensagem_publica',
        corpo: texto,
        corpo_hash: hashCorpo(texto),
        motivo: `${PREFIXO_CONFIRMADOS}${JSON.stringify(confirmados)}`,
        estado: retido,
      },
      { passo: 'status_em_atendimento', status_alvo: 'em_atendimento', estado: retido },
      {
        passo: 'status_resolvido',
        status_alvo: 'resolvido',
        motivo: cfg.politica_status.motivo || 'implementado_via_forja',
        estado: retido,
      },
    ];
    if (politica === 'fechado_imediato') {
      passos.push({ passo: 'status_fechado', status_alvo: 'fechado', estado: retido });
    }
    if (d036) passos.push({ passo: 'desatribuir', estado: retido });
    await this.criar(execucaoId, passos, (linhas) =>
      linhas.some((l) => l.passo === 'nota_interna'),
    );
  }

  /** Rodada de descarte/encerramento (`nota_descarte` → `desatribuir`; sem `reativar_ia`, FJ-031). */
  async criarRodadaDescarte(execucaoId: string, nota: string | null, motivo: string | null) {
    const e = await this.n.banco.ler((r) => r.execucoes.exigir(execucaoId));
    if (!nota && !e.atribuido_pelo_app) return;
    await this.criar(execucaoId, [
      nota
        ? {
            passo: 'nota_descarte',
            corpo: montarNotaDescarte({
              execucaoId,
              motivo: [motivo, nota].filter(Boolean).join(' — '),
            }),
          }
        : { passo: 'nota_descarte', estado: 'pulado', motivo: 'sem nota' },
      { passo: 'desatribuir' },
    ]);
  }

  // -------------------------------------------------------------------------
  // Despacho
  // -------------------------------------------------------------------------

  /**
   * Despacha os passos prontos de uma execução até não sobrar cabeça pronta.
   * Projeto travado pela sentinela (03 §2.5): nada sai — vale para TODO
   * caminho (relógio, comando humano, rodada de início/encerramento).
   */
  async processarExecucao(execucaoId: string): Promise<void> {
    if (this.emProcesso.has(execucaoId)) return;
    const e = await this.n.banco.ler((r) => r.execucoes.obter(execucaoId));
    if (e && (await projetosTravados(this.n)).has(e.projeto_id)) return;
    this.emProcesso.add(execucaoId);
    try {
      for (let guarda = 0; guarda < 50; guarda++) {
        const agora = this.n.iso();
        const prontos = (await this.n.banco.ler((r) => r.outbox.prontos(agora))).filter(
          (l) => l.execucao_id === execucaoId,
        );
        if (prontos.length === 0) break;
        for (const l of prontos) await this.processarPasso(l);
      }
      await this.avaliarExecucao(execucaoId);
    } finally {
      this.emProcesso.delete(execucaoId);
    }
  }

  /** Todas as execuções com passo pronto (relógio do orquestrador). */
  async processarTodos(): Promise<void> {
    const agora = this.n.iso();
    const prontos = await this.n.banco.ler((r) => r.outbox.prontos(agora));
    const execucoes = [...new Set(prontos.map((p) => p.execucao_id))];
    for (const id of execucoes) await this.processarExecucao(id);
    // Encerramento bloqueado sem passo pronto: a execução sai de `comunicando`.
    const comunicando = await this.n.banco.ler((r) =>
      r.execucoes.listar({ estados: ['comunicando'] }),
    );
    for (const e of comunicando) {
      if (!this.emProcesso.has(e.id)) await this.avaliarExecucao(e.id);
    }
  }

  /** Sentinela divergente não reconhecida trava o outbox DO PROJETO (03 §2.5). */
  projetosTravados(): Promise<Set<string>> {
    return projetosTravados(this.n);
  }

  /** Boot (03 §9.5): `enviando` volta a `pendente` — o passo refaz a checagem "já feito?" antes de enviar. */
  async reconciliarEnviando(): Promise<number> {
    const linhas = await this.n.banco.ler((r) => r.outbox.emEnvio());
    for (const l of linhas) {
      await this.n.banco.transacao((r) => r.outbox.mudarEstado(l.id, 'pendente'));
    }
    return linhas.length;
  }

  /**
   * "Tentar agora" (03 §9.3): zera o backoff dos pendentes da execução e
   * devolve a `pendente` os passos `bloqueado` (o humano confirmou a nova
   * tentativa; o passo revalida texto e segredos antes de enviar e, se o
   * motivo persistir, volta a bloquear).
   */
  async tentarAgora(execucaoId: string): Promise<void> {
    await this.n.banco.transacao(async (r) => {
      for (const l of await r.outbox.listar(execucaoId)) {
        if (l.estado === 'bloqueado') await r.outbox.mudarEstado(l.id, 'pendente');
      }
      await r.m.update(
        OutboxChamadoSchema,
        { execucao_id: execucaoId, estado: 'pendente' },
        { proxima_em: null, atualizado_em: this.n.iso() },
      );
    });
  }

  private async entradaDoPasso(l: OutboxChamado): Promise<EntradaPasso | null> {
    return this.n.banco.ler(async (r) => {
      const e = await r.execucoes.obter(l.execucao_id);
      if (!e) return null;
      const todas = await r.outbox.listar(l.execucao_id);
      const atribuir = todas.find(
        (x) => x.passo === 'atribuir' && x.motivo?.startsWith(PREFIXO_ANTERIOR),
      );
      const anterior = atribuir?.motivo?.slice(PREFIXO_ANTERIOR.length) ?? null;
      let confirmados: string[] = [];
      if (l.motivo?.startsWith(PREFIXO_CONFIRMADOS)) {
        try {
          confirmados = JSON.parse(l.motivo.slice(PREFIXO_CONFIRMADOS.length)) as string[];
        } catch {
          confirmados = [];
        }
      }
      const resp = await r.artefatos.ultimaVersao(l.execucao_id, 'resposta');
      const tipo =
        (resp?.conteudo as { tipo?: TipoResposta } | null)?.tipo ?? 'aguardando_publicacao';
      const ehStatus = l.passo.startsWith('status_');
      return {
        passo: l.passo,
        chamado_ref: e.chamado_id,
        corpo: l.corpo,
        enviado_em: l.enviado_em,
        motivo: ehStatus ? l.motivo : null,
        tipo_resposta: l.passo === 'pergunta_publica' ? 'pergunta' : tipo,
        publicar_mesmo_assim: confirmados.length ? { motivos: confirmados } : null,
        confirmar_reatribuir: false,
        operador_anterior: anterior === 'null' ? null : anterior,
        forja_atribuiu: e.atribuido_pelo_app,
        forja_silenciou: e.ia_silenciada_pelo_app,
      } satisfies EntradaPasso;
    });
  }

  /** Um passo: intenção gravada → chamada → resultado gravado → efeito na execução. */
  async processarPasso(l: OutboxChamado): Promise<ResultadoPasso | null> {
    const n = this.n;
    const e = await n.banco.ler((r) => r.execucoes.obter(l.execucao_id));
    if (!e) return null;
    const fonte = n.fonte(e.conexao_id);
    const entrada = await this.entradaDoPasso(l);
    if (!entrada) return null;
    if (!fonte || !fonte.podeUsar()) {
      await this.falhaRetentavel(l, 'conexão com o Chamados indisponível', null);
      return null;
    }
    const enviadoEm = l.enviado_em ?? n.iso();
    await n.banco.transacao(async (r) => {
      await r.outbox.marcarEnviando(l.id);
      await r.m.update(OutboxChamadoSchema, { id: l.id }, { enviado_em: enviadoEm });
    });
    const identidade = fonte.identidade() ?? { usuarioId: '', nome: '' };
    let res: ResultadoPasso;
    try {
      res = await executarPasso(
        {
          api: fonte.api,
          execucaoId: l.execucao_id,
          identidade,
          papel: fonte.papel,
          d036: fonte.d036() ?? false,
          valoresSensiveis: [...n.segredos],
          agora: () => n.agora(),
        },
        { ...entrada, enviado_em: enviadoEm },
      );
    } catch (erro) {
      // Bug no executor: o passo não pode ficar `enviando` para sempre.
      res = {
        resultado: 'retentar',
        motivo: 'servidor',
        detalhe: (erro as Error).message,
        ultimo_http: null,
      };
    }
    await this.aplicarResultado(l, res);
    return res;
  }

  private async falhaRetentavel(l: OutboxChamado, erro: string, http: number | null) {
    const proxima = new Date(this.n.agora().getTime() + backoffMs(l.tentativas)).toISOString();
    await this.n.banco.transacao(async (r) => {
      const atual = await r.outbox.exigir(l.id);
      if (atual.estado === 'enviando') await r.outbox.mudarEstado(l.id, 'pendente');
      await r.outbox.registrarFalha(l.id, { erro, proxima_em: proxima, ultimo_http: http });
    });
    const e = await this.n.banco.ler((r) => r.execucoes.exigir(l.execucao_id));
    const passos = await this.n.banco.ler((r) =>
      r.outbox.listar(l.execucao_id, { rodada: l.rodada }),
    );
    if (e.estado === 'comunicando' && tipoDaRodada(passos) === 'encerramento') {
      await this.n.transicionar(e.id, { tipo: 'outbox_avancou', resultado: 'falha_retentavel' });
    }
  }

  private async aplicarResultado(l: OutboxChamado, res: ResultadoPasso): Promise<void> {
    const n = this.n;
    switch (res.resultado) {
      case 'enviado': {
        await n.banco.transacao(async (r) => {
          await r.outbox.marcarEnviado(l.id, {
            id_remoto: res.id_remoto,
            ultimo_http: res.ultimo_http,
          });
          const ef = res.efeitos;
          // `ia_silenciada_pelo_app` não é mais escrito (FJ-031; coluna obsoleta).
          if (ef.forja_atribuiu !== undefined) {
            await r.execucoes.atualizar(l.execucao_id, { atribuido_pelo_app: ef.forja_atribuiu });
          }
          if (ef.operador_anterior !== undefined) {
            await r.outbox.mudarEstado(
              l.id,
              'enviado',
              `${PREFIXO_ANTERIOR}${ef.operador_anterior ?? 'null'}`,
            );
          }
        });
        return;
      }
      case 'pulado': {
        await n.banco.transacao(async (r) => {
          await r.outbox.mudarEstado(l.id, 'pulado', res.aviso.slice(0, 300));
          if (res.motivo === 'estado_terminal') {
            // 409 estado_terminal: os passos restantes da rodada são pulados (03 §9.3).
            for (const x of await r.outbox.listar(l.execucao_id, { rodada: l.rodada })) {
              if (x.id !== l.id && !RESOLVIDOS.includes(x.estado)) {
                await r.outbox.mudarEstado(x.id, 'pulado', 'chamado encerrado no servidor');
              }
            }
          }
        });
        return;
      }
      case 'bloqueado':
        await n.banco.transacao(async (r) => {
          await r.outbox.mudarEstado(l.id, 'pendente');
          await r.outbox.bloquear(
            l.id,
            `${res.motivo}: ${res.detalhe}`.slice(0, 500),
            res.ultimo_http,
          );
        });
        return;
      case 'retentar':
      case 'reconectar':
        await this.falhaRetentavel(
          l,
          res.resultado === 'reconectar' ? `reconectar: ${res.detalhe}` : res.detalhe,
          res.ultimo_http,
        );
        return;
      case 'precisa_humano': {
        await n.banco.transacao(async (r) => {
          await r.outbox.mudarEstado(l.id, 'pendente');
          await r.outbox.bloquear(
            l.id,
            `${res.motivo}: ${res.detalhe}`.slice(0, 500),
            res.ultimo_http,
          );
        });
        const e = await n.banco.ler((r) => r.execucoes.exigir(l.execucao_id));
        if (ESTADOS_ANTES_DE_MERGEADO.includes(e.estado)) {
          await n.transicionar(
            e.id,
            res.motivo_execucao === 'chamado_mudou_no_servidor'
              ? { tipo: 'chamado_mudou_no_servidor', texto: res.detalhe }
              : { tipo: 'transicao_recusada', texto: res.detalhe },
          );
        }
        return;
      }
    }
  }

  /** Efeito da rodada de encerramento na execução (03 §2.4 linhas de `comunicando`). */
  async avaliarExecucao(execucaoId: string): Promise<void> {
    const n = this.n;
    const e = await n.banco.ler((r) => r.execucoes.obter(execucaoId));
    if (!e || !ESTADOS_POS_MERGE.includes(e.estado)) return;
    const linhas = await n.banco.ler((r) => r.outbox.listar(execucaoId));
    const enc = linhas.filter(
      (l) =>
        l.rodada ===
        Math.max(0, ...linhas.filter((x) => x.passo === 'nota_interna').map((x) => x.rodada)),
    );
    if (enc.length === 0) return;
    const sit = situacaoRodada(enc);
    let atual = e.estado;
    if (atual === 'mergeado_pendente_chamado') {
      const pendenteFuturo = enc.some(
        (l) => l.estado === 'pendente' && l.proxima_em && l.proxima_em > n.iso(),
      );
      if (pendenteFuturo && sit === 'em_andamento') return;
      if (sit === 'bloqueada') return;
      atual = (await n.transicionar(execucaoId, { tipo: 'outbox_retentar' })).execucao.estado;
    }
    if (atual !== 'comunicando') return;
    if (sit === 'bloqueada') {
      // Passo bloqueado depois do merge (validador, segredo, 403): a execução
      // não fica em `comunicando` para sempre — "tentar agora" desbloqueia.
      await n.transicionar(execucaoId, { tipo: 'outbox_avancou', resultado: 'falha_retentavel' });
    } else if (sit === 'concluida') {
      await n.transicionar(execucaoId, { tipo: 'outbox_avancou', resultado: 'concluido' });
    } else if (sit === 'so_retidos') {
      await n.transicionar(execucaoId, { tipo: 'outbox_avancou', resultado: 'aguardar_deploy' });
    }
  }
}
