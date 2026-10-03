/**
 * `server/terminal` (specs/forja/01 §11, 06 §4.7): PTY do `claude` interativo
 * (livre ou assumido, sempre sem bypass) e o registro das sessões com lock,
 * scrollback em anel e Devolver. O WebSocket fica em `http/terminal-ws.ts`.
 */
export * from './pty';
export * from './sessoes';
