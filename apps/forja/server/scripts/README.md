# server/scripts

- `smoke-cli.ts` — compat da CLI fora do app (01 §7): versão fixada, `auth status`, git, módulos nativos; smoke de perfis só com `FORJA_SMOKE_CLAUDE=1` (haiku, ≈ US$ 0,04).
- `smoke-local.ts` — a Forja inteira de ponta a ponta sem Claude real (servidor de verdade, sessão, conexão, projeto num clone, fila, Diagnóstico, SSE, Terminal/WS, SIGTERM sem filho vivo). Roteiro e variáveis no topo do arquivo e em `docs/desenvolvimento.md` §3.12.
- `forja-print.mjs` — print de uma tela para as evidências visuais (FJ-030 §3), usado pelo AGENTE no T1 (`node $FORJA_PRINT <url> <saida.png> [--viewport LxA] [--espera ms|seletor] [--storage state.json] [--full]`), com o Playwright/Chromium da Forja; código ≠ 0 e "forja-print: <motivo>" em falha (2 uso, 3 navegador, 4 navegação, 5 captura).
- `migrar.ts` — migrations manuais (`migration:run`/`migration:revert`); o boot também aplica as pendentes (02 §1).
- `spikes/` — S1–S10 do roadmap (`08-roadmap.md` §2), contra a CLI real.
