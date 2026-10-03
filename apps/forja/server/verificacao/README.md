# server/verificacao

**A Forja não executa comandos do projeto** (FJ-032, 2026-10-03): quem instala dependências e roda typecheck/lint/testes/build é o agente (T1 corrige; T2 roda sobre o diff e relata em `veredito.v1.comandos_executados`). O que sobrou aqui é **coleta e cálculo**, sem processo do projeto. Spec: `specs/forja/03-pipeline.md` §5, `01-arquitetura.md` §10 (removida), `05-seguranca.md` §4.11 e §5.2.

- `evidencias.ts` — COLETA dos prints que o agente tirou (FJ-026; FJ-030 §3): lê `<exec>/evidencias/telas.json`, confere cada PNG (dentro de `evidencias/`, arquivo regular, assinatura, dimensões), marca `antes_suspeito` quando o `antes` é posterior ao primeiro checkpoint e calcula `evidencia_visual`. Quem sobe o app e fotografa é o condutor T1 (bloco B7, `scripts/forja-print.mjs`); não há captura pelo app, `storageState`, rota de login nem DSL de passos.
- `niveis.ts` — `calcularNivelVerificacao` (puro, FJ-032): casa cada comando relatado em `comandos_executados` com um `tool_use` Bash do stream do T2 (thread principal + subagentes; texto normalizado igual ou um contendo o outro) e olha o `tool_result` → `verificado_pelo_revisor` (≥ 1 relatado, todos vistos com exit 0) | `declarado` (algum não visto, divergente ou com falha) | `nao_verificado` (nada relatado); cada comando ganha `no_stream: exit_0 | erro | nao_visto`. Também `evidencia_visual`. Nunca arredonda para cima.
- `navegador.ts` — utilitários que ficaram: Chromium headless do cache do Playwright (FJ-028; mesma regra do `forja-print`), porta livre, `dimensoesPng`, healthcheck (spike S10 e Diagnóstico).
- `processo-grupo.ts` — grupo próprio e escada SIGINT→SIGTERM→SIGKILL (usado pelos utilitários que ainda sobem processo).
- `confinamento-bwrap.ts` — modo reforçado (`bwrap`) [NV S6]; **sem uso no pipeline** desde FJ-032 (não há comando do app a confinar; `modo_reforcado.verificacao_bwrap` é aceito e ignorado).

Removido (FJ-032): `runner-comandos.ts` (+ teste) — verificação, linha de base com `CacheLinhaBase` e `setup`, classificação `codigo`/`ambiente`, re-execução de instáveis.
