# server/http

Servidor Fastify em `127.0.0.1` (specs/forja/01 §3, §4.1, §8; segurança local em `05-seguranca.md` §7; arquitetura em FJ-027).

- `servidor.ts` — ordem de registro: cookie → `@fastify/websocket` → segurança local → WebSocket do PTY → rotas → estáticos da SPA; `forceCloseConnections`.
- `seguranca-local.ts` — token de boot → cookie `HttpOnly; SameSite=Strict`, Host/Origin, CSP.
- `rotas/` — uma rota por entrada de `ROTAS_API`, todas via `viaFachada(nome)` → `ServicosForja` (`dominio/servicos.ts`); o typecheck falha se faltar função.
- `erros-api.ts` · `entrada.ts` — `ErroForja` → `ErroApiDto` com código estável (500 sem detalhe); normalização da query de GET.
- `eventos-sse.ts` — SSE global e por execução, `Last-Event-ID` com replay do SQLite, heartbeat.
- `terminal-ws.ts` — WebSocket do PTY: frame binário = teclas, texto = controle JSON; revalida Host, Origin e cookie.
