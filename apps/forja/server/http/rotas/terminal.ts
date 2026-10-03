import { viaFachada, type HandlerBruto, type HandlersRotas } from './tipos';

/**
 * Rotas do Terminal PTY (specs/forja/06 §4.7, 01 §11). O WebSocket exige cookie,
 * Host e Origin no upgrade (05 §7.2) — o hook global de seguranca-local valida e
 * `terminal-ws.ts` valida de novo antes do 101.
 *
 * `terminal_ws` NÃO passa pelo laço de `rotas/index.ts`: a rota com `wsHandler`
 * é registrada por `registrarTerminalWs` (http/terminal-ws.ts) no MESMO método +
 * caminho, e o Fastify recusaria a duplicata. A entrada abaixo existe só para o
 * mapa `HandlersRotas` continuar cobrindo todo o contrato.
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
const registradaEmTerminalWs: HandlerBruto<'terminal_ws'> = ({ reply }) => {
  void reply.code(426).send({ erro: 'entrada_invalida', mensagem: 'Use WebSocket' });
};

export const rotasTerminal = {
  terminal_sessoes: viaFachada('terminal_sessoes'),
  terminal_abrir: viaFachada('terminal_abrir', 201),
  terminal_encerrar: viaFachada('terminal_encerrar'),
  terminal_reabrir: viaFachada('terminal_reabrir'),
  terminal_ws: registradaEmTerminalWs,
} satisfies Pick<
  HandlersRotas,
  'terminal_sessoes' | 'terminal_abrir' | 'terminal_encerrar' | 'terminal_reabrir' | 'terminal_ws'
>;
