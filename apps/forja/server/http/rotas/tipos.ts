import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  EntradaRota,
  ErroApiDto,
  NomeRota,
  ParametrosRota,
  ROTAS_API,
  SaidaRota,
} from '../../../comum/dto';
import type { EventoForja } from '../../../comum/protocolo-eventos';
import type { ConfigForja } from '../../config';
import type { FachadaJson, ServicosForja } from '../../dominio/servicos';
import type { BarramentoEventos } from '../../eventos/barramento';
import { traduzirErro } from '../erros-api';

/**
 * Tipos dos handlers da API local. POR QUE `HandlersRotas` é um mapa com TODAS
 * as chaves de `ROTAS_API`: o objeto montado em `rotas/index.ts` não compila se
 * faltar uma rota — servidor e SPA ficam presos ao mesmo contrato (comum/dto.ts).
 *
 * - Rotas `json`: o handler recebe parâmetros e entrada tipados e devolve
 *   `{ status, corpo }`; o registrador serializa. Erro = `ErroApiDto`. Quase
 *   todas são `viaFachada(nome)`: a função homônima de `ServicosForja`
 *   (dominio/servicos.ts) faz o trabalho; aqui só se traduz o erro.
 * - Rotas `sse`/`ws`/`binario`: o handler recebe a requisição crua (stream).
 */

/** O que as rotas usam da fachada: as funções JSON + os dois arquivos binários. */
export type ServicosHttp = FachadaJson & Pick<ServicosForja, 'imagemEvidencia' | 'logArtefato'>;

/** Replay do SSE a partir do SQLite (01 §8.1) e existência da execução (404 do canal). */
export interface FonteEventosHttp {
  /** Eventos com `seq` maior, em ordem; `null` = replay grande demais (a UI recarrega). */
  desde(seq: number, filtro: (e: EventoForja) => boolean): Promise<EventoForja[] | null>;
  execucaoExiste(id: string): Promise<boolean>;
}

export interface DepsRotas {
  config: ConfigForja;
  barramento: BarramentoEventos;
  iniciadoEm: string;
  servicos: ServicosHttp;
  eventos: FonteEventosHttp;
  /** Erro não tratado (500): o detalhe vai ao stderr do terminal, nunca à resposta. */
  log?: (mensagem: string, erro: unknown) => void;
}

export type StatusErro = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 501 | 503;

export type ResultadoRota<N extends NomeRota> =
  { status: 200 | 201; corpo: SaidaRota<N> } | { status: StatusErro; corpo: ErroApiDto };

export interface ContextoRota<N extends NomeRota> {
  params: ParametrosRota<N>;
  entrada: EntradaRota<N>;
  req: FastifyRequest;
  deps: DepsRotas;
}

export type HandlerJson<N extends NomeRota> = (
  ctx: ContextoRota<N>,
) => ResultadoRota<N> | Promise<ResultadoRota<N>>;

export interface ContextoBruto<N extends NomeRota> {
  params: ParametrosRota<N>;
  req: FastifyRequest;
  reply: FastifyReply;
  deps: DepsRotas;
}

export type HandlerBruto<N extends NomeRota> = (ctx: ContextoBruto<N>) => void | Promise<void>;

type TransporteDe<N extends NomeRota> = (typeof ROTAS_API)[N]['transporte'];

export type HandlerRota<N extends NomeRota> =
  TransporteDe<N> extends 'json' ? HandlerJson<N> : HandlerBruto<N>;

export type HandlersRotas = { [N in NomeRota]: HandlerRota<N> };

/** Rotas JSON (as que a fachada cobre uma a uma). */
export type RotaJson = keyof FachadaJson;

/**
 * Handler JSON que delega à função homônima da fachada. `POST` de criação
 * responde 201 (`execucao_criar`, `lote_criar`, `projeto_criar`, `conexao_criar`,
 * `terminal_abrir`); o resto, 200.
 */
export function viaFachada<N extends RotaJson>(nome: N, status: 200 | 201 = 200): HandlerJson<N> {
  return async ({ params, entrada, deps }) => {
    try {
      const fn = deps.servicos[nome] as unknown as (
        p: ParametrosRota<N>,
        e: EntradaRota<N>,
      ) => Promise<SaidaRota<N>>;
      const corpo = await fn.call(deps.servicos, params, entrada);
      return { status, corpo };
    } catch (e) {
      return traduzirErro(e, deps.log);
    }
  };
}
