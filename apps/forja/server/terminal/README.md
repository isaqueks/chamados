# server/terminal

PTY (`node-pty`) do `claude` interativo — livre ou assumido (`--resume`, sem bypass) —, registro das
sessões com lock por `session_id`, scrollback em anel (≈ 1 MB) e Devolver. O WebSocket
`/api/terminal/:sessao` está em `server/http/terminal-ws.ts`.
Spec: `specs/forja/01-arquitetura.md` §11, `06-ui-ux.md` §4.7, `05-seguranca.md` §7.2.
