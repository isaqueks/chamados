import type { ErroApiDto } from '../../../comum/dto';
import { pertenceAoCanalDaExecucao, pertenceAoCanalGlobal } from '../../../comum/protocolo-eventos';
import { abrirCanalSse } from '../eventos-sse';
import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas globais (specs/forja/06 §1, 01 §8.1): saúde, shell (cabeçalho/sidebar/
 * banners), uso de cota e os dois canais SSE.
 *
 * SSE: o replay da reconexão (`Last-Event-ID`/`?ultimo_seq=`) vem do SQLite
 * (`deps.eventos.desde`), não só do anel em memória — depois de um reboot da
 * Forja o anel está vazio e o `seq` continua o do banco (02 §4.8).
 */
export const rotasShell = {
  // Sem banco de propósito: é o "servidor de pé" que não exige sessão (05 §7.1).
  saude: ({ deps }) => ({
    status: 200,
    corpo: {
      ok: true,
      versao: deps.config.versao,
      modo: deps.config.modo,
      iniciado_em: deps.iniciadoEm,
    },
  }),

  shell_obter: viaFachada('shell_obter'),
  uso_obter: viaFachada('uso_obter'),

  eventos_global: ({ req, reply, deps }) => {
    abrirCanalSse(req, reply, {
      barramento: deps.barramento,
      porta: deps.config.porta,
      filtro: pertenceAoCanalGlobal,
      replay: (ultimo, filtro) => deps.eventos.desde(ultimo, filtro),
    });
  },

  execucao_eventos: async ({ params, req, reply, deps }) => {
    if (!(await deps.eventos.execucaoExiste(params.id))) {
      const corpo: ErroApiDto = { erro: 'nao_encontrado', mensagem: 'execução não encontrada' };
      void reply.code(404).send(corpo);
      return;
    }
    abrirCanalSse(req, reply, {
      barramento: deps.barramento,
      porta: deps.config.porta,
      filtro: (evento) => pertenceAoCanalDaExecucao(evento, params.id),
      replay: (ultimo, filtro) => deps.eventos.desde(ultimo, filtro),
    });
  },
} satisfies Pick<
  HandlersRotas,
  'saude' | 'shell_obter' | 'uso_obter' | 'eventos_global' | 'execucao_eventos'
>;
