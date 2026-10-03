import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROTAS_API, type ErroApiDto, type NomeRota } from '../../../comum/dto';
import { normalizarCorpo, normalizarQuery } from '../entrada';
import { rotasAprovacoes } from './aprovacoes';
import { rotasConexao } from './conexao';
import { rotasConfiguracoes } from './configuracoes';
import { rotasDiagnostico } from './diagnostico';
import { rotasExecucoes } from './execucoes';
import { rotasFila } from './fila';
import { rotasHistorico } from './historico';
import { rotasLotes } from './lotes';
import { rotasMerge } from './merge';
import { rotasProjetos } from './projetos';
import { rotasShell } from './shell';
import { rotasTerminal } from './terminal';
import type { DepsRotas, HandlerBruto, HandlerJson, HandlersRotas } from './tipos';

/**
 * Registro da API local: UM handler por rota de `ROTAS_API` (comum/dto.ts).
 * O tipo `HandlersRotas` obriga este objeto a cobrir todas as rotas; o laço
 * abaixo registra cada uma no método/caminho da lista canônica — nenhum
 * caminho é escrito à mão aqui.
 */
export const HANDLERS: HandlersRotas = {
  ...rotasShell,
  ...rotasFila,
  ...rotasExecucoes,
  ...rotasAprovacoes,
  ...rotasLotes,
  ...rotasMerge,
  ...rotasProjetos,
  ...rotasConexao,
  ...rotasConfiguracoes,
  ...rotasDiagnostico,
  ...rotasHistorico,
  ...rotasTerminal,
};

export function registrarRotas(app: FastifyInstance, deps: DepsRotas): void {
  for (const nome of Object.keys(ROTAS_API) as NomeRota[]) {
    const def = ROTAS_API[nome];
    const handler = HANDLERS[nome];
    // O WebSocket do PTY tem registro próprio (`registrarTerminalWs`, com
    // `wsHandler` e revalidação do upgrade) no mesmo caminho.
    if (def.transporte === 'ws') continue;

    if (def.transporte === 'json') {
      const h = handler as HandlerJson<NomeRota>;
      app.route({
        method: def.metodo,
        url: def.caminho,
        handler: async (req: FastifyRequest, reply: FastifyReply) => {
          const lida =
            def.metodo === 'GET' ? normalizarQuery(req.query) : normalizarCorpo(req.body);
          if (!lida.ok) {
            const corpo: ErroApiDto = { erro: 'entrada_invalida', mensagem: lida.mensagem };
            return reply.code(400).send(corpo);
          }
          const r = await h({
            params: req.params as never,
            entrada: lida.entrada as never,
            req,
            deps,
          });
          return reply.code(r.status).send(r.corpo);
        },
      });
      continue;
    }

    const h = handler as HandlerBruto<NomeRota>;
    app.route({
      method: def.metodo,
      url: def.caminho,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        await h({ params: req.params as never, req, reply, deps });
        return reply;
      },
    });
  }
}
