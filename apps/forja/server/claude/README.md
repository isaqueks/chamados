# server/claude

Runner da CLI do Claude Code. Spec: `specs/forja/01-arquitetura.md` §6 e §7; prompts e `--agents` em `04-agentes-e-contratos.md`; ajustes dos spikes em FJ-028.

- `perfis.ts` — ÚNICA fonte das flags e do env por etapa (`montarComando`, `montarComandoAssumir`); `--forward-subagent-text` em todo spawn; sem `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` [V S2]; `--disallowedTools Agent(x)` no T1 **e** no T2; semente da lista negada = agentes embutidos.
- `perfis.ts` (FJ-030 §4) — `--mcp-config mcp.<n>.json --strict-mcp-config` quando há MCP; nos perfis `dontAsk` as ferramentas de leitura `mcp__chamados__*` entram no allow; o T1 recebe `FORJA_PRINT`/`FORJA_EVIDENCIAS_DIR` (B7), únicas `FORJA_*` permitidas.
- `settings-gerados.ts` — `settings.<n>.json` (deny só `Read`/`Edit`, caminho absoluto `//`; no T1 a própria execução é negada por enumeração, menos `evidencias/`), `agentes.<n>.json`, `sistema.<n>.md` e `mcp.<n>.json` (`gerarConfigMcp`: só o servidor `chamados`, `CHAMADOS_MCP_SOMENTE_LEITURA=true`, token da conexão por env) — 0600, com sha256.
- `mcp-chamados.ts` — localiza o `apps/mcp` (`tsx …/src/index.ts`, ou `FORJA_MCP_CHAMADOS`) e o `scripts/forja-print.mjs`.
- `prompts.ts` + `prompts/*.md` — blocos B1–B7 (B7 = evidências visuais pelo agente, em todo T1 e condicional — sem UI, `telas.json` com `nao_se_aplica: true` (FJ-031); no retrabalho, "refaça só o depois") e os prompts de turno, conversa, retomada e correção.
- `stream.ts` · `validacao-init.ts` · `telemetria.ts` — parser do stream, validação do `init` (`Task` ≡ `Agent`, `StructuredOutput` com schema, plugins `builtin` ignorados; MCP `chamados` esperado quando gerado — ausente/falho só alerta) e custo por turno como delta (S5).
- `runner.ts` · `retomada.ts` · `lock-sessoes.ts` — `RunnerCli` (processo, classificação de §6.6, `agentesForaDoPapel` sem reinício próprio), retomada e lock por `session_id`.
- `compat.ts` — versão fixada `2.1.288`, `auth status`, git, smoke de perfis.

`fixtures/` tem streams reais e `processo-falso.ts`; nenhum teste chama o `claude` real.
