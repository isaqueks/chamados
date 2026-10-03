import { ehTerminal, type StatusChamado } from '@chamados/shared';
import { ErroApi, type MensagemChamado, type RespostaDetalheChamado } from '@chamados/cliente-api';
import type { DadosEventoForja } from '../../comum/protocolo-eventos';
import {
  classificarMensagem,
  extrairNotasIa,
  type NotaIaClassificada,
  type PrIa,
} from './notas-ia';
import { temMarcadorForja } from './notas';
import { prIaDoChamado } from './sinais';
import type { IdentidadeForja, OperacoesChamados } from './tipos';

/**
 * Polling dos chamados EM VOO (specs/forja/07 §8; 02 §4.4).
 *
 * POR QUE polling e por que o DETALHE: não há SSE, o webhook do tenant não
 * alcança `localhost` e — o ponto decisivo — mensagem nova NÃO altera
 * `chamado.updated_at` [V: 02 §0.8]. A lista não serve; é preciso ler o
 * detalhe e comparar com o último snapshot: `status`, `ia_silenciada` e o id da
 * última mensagem (as novas são as que vêm DEPOIS dele).
 *
 * Este módulo só DETECTA e devolve sinais tipados; a reação (badge, bloqueio do
 * merge, `precisa_humano`, "Replanejar") é da máquina da execução (R3):
 *  - `cliente_respondeu` — pública do cliente final (gatilho de retomada da
 *    pergunta, §8.2; nunca "voltou a em_atendimento");
 *  - `mensagem_equipe` — mensagem/nota de outro humano da equipe;
 *  - `nota_ia` — a triagem rodou apesar de tudo (classificada, §4/§7);
 *  - `status_mudou` — com `terminal` para "chamado encerrado no Chamados";
 *  - `ia_reativada` — `ia_silenciada` voltou a `false` (só informativo, FJ-031);
 *  - `pr_ia_apareceu` — nota de PR `ia/chamado-N-*` nova (informativo, FJ-031);
 *  - `chamado_inacessivel` — `404` (`precisa_humano`).
 *
 * Regras de 07 §8.1: a cada 3 min com jitter de ±20 %, concorrência 4, pausado
 * sem conexão válida (e sem gerar login). As mensagens da própria Forja (mesmo
 * `autor_nome` da identidade, ou com marcador `[forja:…]`) nunca viram sinal.
 */

export const INTERVALO_POLLING_MS = 180_000;
export const JITTER_POLLING = 0.2;
export const CONCORRENCIA_POLLING = 4;

/** O que se guarda do último detalhe (colunas de `chamado_cache`). */
export interface SnapshotChamado {
  status: StatusChamado;
  ia_silenciada: boolean | null;
  ultima_mensagem_id: string | null;
  ultima_mensagem_em: string | null;
  /** Branch do PR da IA já conhecida (para `pr_ia_apareceu` disparar uma vez). */
  branch_ia: string | null;
}

export type SinalChamado =
  | { tipo: 'cliente_respondeu'; mensagens: MensagemChamado[] }
  | { tipo: 'mensagem_equipe'; mensagens: MensagemChamado[] }
  | { tipo: 'nota_ia'; notas: NotaIaClassificada[] }
  | { tipo: 'status_mudou'; de: StatusChamado; para: StatusChamado; terminal: boolean }
  | { tipo: 'ia_reativada' }
  | { tipo: 'pr_ia_apareceu'; pr: PrIa }
  | { tipo: 'chamado_inacessivel' };

export function snapshotDoDetalhe(detalhe: RespostaDetalheChamado): SnapshotChamado {
  const ultima = detalhe.mensagens[detalhe.mensagens.length - 1] ?? null;
  const pr = prIaDoChamado(extrairNotasIa(detalhe.mensagens), detalhe.chamado.numero);
  return {
    status: detalhe.chamado.status,
    ia_silenciada: detalhe.chamado.ia_silenciada ?? null,
    ultima_mensagem_id: ultima?.id ?? null,
    ultima_mensagem_em: ultima?.created_at ?? null,
    branch_ia: pr?.branch ?? null,
  };
}

/** Mensagens depois do id guardado; se o id sumiu, cai na data (`created_at`). */
export function mensagensNovas(
  anterior: SnapshotChamado,
  mensagens: readonly MensagemChamado[],
): MensagemChamado[] {
  if (anterior.ultima_mensagem_id === null) return [...mensagens];
  const i = mensagens.findIndex((m) => m.id === anterior.ultima_mensagem_id);
  if (i >= 0) return mensagens.slice(i + 1);
  const desde = anterior.ultima_mensagem_em ? Date.parse(anterior.ultima_mensagem_em) : NaN;
  if (Number.isNaN(desde)) return [];
  return mensagens.filter((m) => m.created_at !== null && Date.parse(m.created_at) > desde);
}

/** A mensagem foi escrita pela Forja? */
export function ehDaForja(m: MensagemChamado, identidade: IdentidadeForja | null): boolean {
  if (temMarcadorForja(m.corpo ?? '')) return true;
  return (
    identidade !== null &&
    m.autor_nome === identidade.nome &&
    (m.autor_papel === 'operador' || m.autor_papel === 'admin')
  );
}

/**
 * Compara o detalhe lido com o snapshot anterior. Sem snapshot anterior, só
 * estabelece a linha de base (nenhum sinal).
 */
export function compararDetalhe(
  anterior: SnapshotChamado | null,
  detalhe: RespostaDetalheChamado,
  identidade: IdentidadeForja | null,
): { sinais: SinalChamado[]; snapshot: SnapshotChamado } {
  const snapshot = snapshotDoDetalhe(detalhe);
  if (!anterior) return { sinais: [], snapshot };
  const sinais: SinalChamado[] = [];

  if (anterior.status !== snapshot.status) {
    sinais.push({
      tipo: 'status_mudou',
      de: anterior.status,
      para: snapshot.status,
      terminal: ehTerminal(snapshot.status),
    });
  }
  if (anterior.ia_silenciada === true && snapshot.ia_silenciada === false) {
    sinais.push({ tipo: 'ia_reativada' });
  }

  const novas = mensagensNovas(anterior, detalhe.mensagens).filter(
    (m) => !ehDaForja(m, identidade),
  );
  const doCliente = novas.filter(
    (m) => m.autor_papel === 'cliente' && (m.visibilidade ?? 'publica') === 'publica',
  );
  const daEquipe = novas.filter((m) => m.autor_papel === 'operador' || m.autor_papel === 'admin');
  const daIa = novas
    .map((m) => (m.autor_papel === 'agente_ia' ? (classificarMensagem(m) ?? outraIa(m)) : null))
    .filter((n): n is NotaIaClassificada => n !== null);

  if (doCliente.length > 0) sinais.push({ tipo: 'cliente_respondeu', mensagens: doCliente });
  if (daEquipe.length > 0) sinais.push({ tipo: 'mensagem_equipe', mensagens: daEquipe });
  if (daIa.length > 0) sinais.push({ tipo: 'nota_ia', notas: daIa });

  if (snapshot.branch_ia && snapshot.branch_ia !== anterior.branch_ia) {
    const pr = prIaDoChamado(extrairNotasIa(detalhe.mensagens), detalhe.chamado.numero);
    if (pr) sinais.push({ tipo: 'pr_ia_apareceu', pr });
  }
  return { sinais, snapshot };
}

/** Pública da IA que não é a "em revisão": ainda é novidade da IA. */
function outraIa(m: MensagemChamado): NotaIaClassificada {
  return { tipo: 'outra_ia', mensagem: m, pr: null };
}

/** Projeção para o evento `chamado.sinal` do SSE (01 §8). */
export function paraEventoSinal(
  s: SinalChamado,
  numero: number,
): DadosEventoForja['chamado.sinal'] {
  switch (s.tipo) {
    case 'cliente_respondeu':
      return { numero, sinal: 'cliente_respondeu', detalhe: `O cliente escreveu no #${numero}.` };
    case 'mensagem_equipe':
      return { numero, sinal: 'mensagem_nova', detalhe: `Mensagem nova da equipe no #${numero}.` };
    case 'nota_ia':
      return {
        numero,
        sinal: 'mensagem_nova',
        detalhe: `A IA do servidor escreveu no #${numero}.`,
      };
    case 'status_mudou':
      return { numero, sinal: 'status_mudou', detalhe: `#${numero}: ${s.de} → ${s.para}.` };
    case 'ia_reativada':
      return {
        numero,
        sinal: 'ia_reativada',
        detalhe: `A IA do #${numero} foi reativada por alguém.`,
      };
    case 'pr_ia_apareceu':
      return {
        numero,
        sinal: 'pr_ia_detectado',
        detalhe: `A IA do servidor abriu ${s.pr.branch ?? 'um PR'} para o #${numero}.`,
      };
    case 'chamado_inacessivel':
      return {
        numero,
        sinal: 'status_mudou',
        detalhe: `O #${numero} ficou inacessível no Chamados.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Agendador
// ---------------------------------------------------------------------------

export interface AlvoPolling {
  /** UUID remoto (`chamado_cache.chamado_id`). */
  chamado_ref: string;
  numero: number;
  snapshot: SnapshotChamado | null;
}

export interface ResultadoVerificacao {
  alvo: AlvoPolling;
  sinais: SinalChamado[];
  detalhe: RespostaDetalheChamado | null;
  erro: unknown;
}

export interface DependenciasPolling {
  api: Pick<OperacoesChamados, 'obterChamado'>;
  /** Execuções fora de `concluido`/`descartado`/`cancelado` (07 §8.1). */
  listarEmVoo(): Promise<AlvoPolling[]>;
  /** Grava o snapshot e o detalhe no `chamado_cache`. */
  salvar(
    alvo: AlvoPolling,
    snapshot: SnapshotChamado,
    detalhe: RespostaDetalheChamado,
  ): Promise<void>;
  emitir(alvo: AlvoPolling, sinais: SinalChamado[]): void | Promise<void>;
  identidade(): IdentidadeForja | null;
  /** `false` pausa o polling (conexão inválida não gera login). */
  conexaoValida(): boolean;
  intervaloMs?: number;
  jitter?: number;
  concorrencia?: number;
  aleatorio?: () => number;
  agendar?: (fn: () => void, ms: number) => () => void;
}

export class PollingChamados {
  private cancelar: (() => void) | null = null;
  private emRodada: Promise<ResultadoVerificacao[]> | null = null;

  constructor(private readonly deps: DependenciasPolling) {}

  /** Próximo intervalo: base ± jitter (07 §8.1). */
  proximoIntervalo(): number {
    const base = this.deps.intervaloMs ?? INTERVALO_POLLING_MS;
    const j = this.deps.jitter ?? JITTER_POLLING;
    const r = (this.deps.aleatorio ?? Math.random)();
    return Math.round(base * (1 - j + 2 * j * r));
  }

  iniciar(): void {
    if (this.cancelar) return;
    const agendar =
      this.deps.agendar ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      });
    const ciclo = (): void => {
      this.cancelar = agendar(() => {
        void this.rodada()
          .catch(() => undefined)
          .finally(() => {
            if (this.cancelar) ciclo();
          });
      }, this.proximoIntervalo());
    };
    ciclo();
  }

  parar(): void {
    this.cancelar?.();
    this.cancelar = null;
  }

  /** Uma passada por todos os chamados em voo (rodadas não se sobrepõem). */
  rodada(): Promise<ResultadoVerificacao[]> {
    this.emRodada ??= this.executarRodada().finally(() => {
      this.emRodada = null;
    });
    return this.emRodada;
  }

  private async executarRodada(): Promise<ResultadoVerificacao[]> {
    if (!this.deps.conexaoValida()) return [];
    const alvos = await this.deps.listarEmVoo();
    const resultados: ResultadoVerificacao[] = [];
    let i = 0;
    const trabalhador = async (): Promise<void> => {
      while (i < alvos.length) {
        const alvo = alvos[i++]!;
        if (!this.deps.conexaoValida()) return;
        resultados.push(await this.verificar(alvo));
      }
    };
    const n = Math.max(1, Math.min(this.deps.concorrencia ?? CONCORRENCIA_POLLING, alvos.length));
    await Promise.all(Array.from({ length: n }, trabalhador));
    return resultados;
  }

  /**
   * Leitura de UM chamado (também a leitura extra obrigatória: abrir o G2, antes
   * do merge, antes de cada passo do outbox, botão "Atualizar" — 07 §8.1).
   */
  async verificar(alvo: AlvoPolling): Promise<ResultadoVerificacao> {
    let detalhe: RespostaDetalheChamado;
    try {
      detalhe = await this.deps.api.obterChamado(alvo.chamado_ref, { formato: 'markdown' });
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 404 && erro.codigo === 'chamado_inexistente') {
        const sinais: SinalChamado[] = [{ tipo: 'chamado_inacessivel' }];
        await this.deps.emitir(alvo, sinais);
        return { alvo, sinais, detalhe: null, erro };
      }
      return { alvo, sinais: [], detalhe: null, erro };
    }
    const { sinais, snapshot } = compararDetalhe(alvo.snapshot, detalhe, this.deps.identidade());
    await this.deps.salvar(alvo, snapshot, detalhe);
    if (sinais.length > 0) await this.deps.emitir(alvo, sinais);
    return { alvo: { ...alvo, snapshot }, sinais, detalhe, erro: null };
  }
}
