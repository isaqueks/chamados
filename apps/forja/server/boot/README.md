# server/boot

Ligação de produção dos pacotes (specs/forja/01 §4.1, §3.2): `iniciarForja` (forja.ts) sobe
SQLite → segredos → compat da CLI → Terminal (opcional) → orquestrador com reconciliação →
conexões/polling → Diagnóstico → Fastify, e devolve `encerrar()` (desligamento limpo).

- `compat-cli.ts` — `CompatCli` (versão/login/git, aceite de versão nova com smoke de perfis gravado em `<dados>/compat-cli.json`), `rodarSmokePerfis`, `DiagnosticoForja` (`PortaDiagnostico`; itens `mcp_chamados` "MCP do Chamados para os agentes" e `forja_print`, FJ-030).
- `conexoes.ts` — `GerenteConexoes`: `PortaConexoes` da fachada + `FonteChamados` do orquestrador sobre `ConexaoChamados`; `credencialAgentes(id)` dá URL/tenant/e-mail/token para o `mcp.<n>.json` (FJ-030 §4).
- `forja.ts` — liga também as configurações globais (`<dados>/configuracoes.json`; arquivo corrompido para o boot), o MCP do Chamados (`localizarServidorMcp`, `op.mcp = false` desliga) e o caminho do `forja-print`.
- `locks.ts` — `LockSessoesCompartilhado`: o runner da CLI e o gerente de PTY no MESMO lock por `session_id` (01 §6.8).
- `processos.ts` — varredura de cwd [V S4] e o último degrau do desligamento (nenhum descendente vivo).

Tudo que toca o mundo (exec da CLI, `fetch`, runner) é injetável; `boot.test.ts` sobe a Forja sem `claude` nem rede.
