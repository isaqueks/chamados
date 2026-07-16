# Guia de Desenvolvimento — Chamados

Guia para subir o ambiente de desenvolvimento local do **Chamados** (helpdesk
IA-first, whitelabel, multi-tenant). Cobre o marco **M0 (fundação)**: monorepo,
infraestrutura em Docker, banco com Row-Level Security, web (Next.js) e worker
(BullMQ).

---

## 1. Pré-requisitos

| Ferramenta     | Versão testada   | Observação                                |
| -------------- | ---------------- | ----------------------------------------- |
| Node.js        | 22.18.0          | use a linha 22 LTS (`node -v`)            |
| npm            | 10.9.3           | vem com o Node 22                         |
| Docker Desktop | 28.3.2           | com Compose v2 (`docker compose version`) |
| Git            | qualquer recente |                                           |

Sistema de referência: **Windows 11 + PowerShell**. Os comandos abaixo funcionam
em PowerShell e em Git Bash.

---

## 2. Visão geral do monorepo

```
Chamados/
├─ apps/
│  ├─ web/       Next.js (App Router) — UI + API (rota /api/health)
│  └─ worker/    Worker BullMQ (fila "healthcheck")
├─ packages/
│  ├─ shared/    Enums canônicos (status, natureza, prioridade, papel, ...)
│  └─ db/        TypeORM DataSource, entidades, migrations, RLS, smoke test
├─ docker-compose.yml   Postgres 16, Redis 7, MinIO
├─ .env.example         Variáveis de ambiente (copie para .env)
└─ package.json         Workspaces npm + scripts agregadores
```

Gerenciador de pacotes: **npm workspaces**. Rode `npm` sempre a partir da **raiz**.

---

## 3. Passo a passo

### 3.1 Clonar e configurar o ambiente

```bash
# na raiz do projeto
cp .env.example .env
```

Os defaults do `.env` já batem com o `docker-compose.yml`; em dev normalmente
não é preciso mudar nada. (O código também tem os mesmos defaults, então a
aplicação sobe mesmo sem `.env`.)

### 3.2 Subir a infraestrutura (Docker)

```bash
docker compose up -d
docker compose ps        # confira STATUS = healthy nos 3 serviços
```

Sobem quatro serviços (prefixo `chamados-`):

| Serviço       | Container           | Porta host                  | Para quê                           |
| ------------- | ------------------- | --------------------------- | ---------------------------------- |
| PostgreSQL 16 | `chamados-postgres` | 5432                        | banco (tenant_id + RLS)            |
| Redis 7       | `chamados-redis`    | 6379                        | filas (BullMQ), cache              |
| MinIO         | `chamados-minio`    | 9000 (API) / 9001 (console) | storage S3-compat (anexos)         |
| Mailpit       | `chamados-mailpit`  | 1025 (SMTP) / 8025 (inbox)  | e-mails de dev (M9 — notificações) |

Aguarde todos ficarem `healthy` antes de rodar as migrations. (Um serviço extra,
`chamados-minio-init`, provisiona o bucket e sai — é normal ele aparecer como
`exited`.)

### 3.3 Instalar as dependências

```bash
npm install
```

Instala e vincula todos os workspaces (`apps/*`, `packages/*`) de uma vez.

### 3.4 Rodar as migrations

```bash
npm run migration:run
```

A primeira migration cria as tabelas `tenant` e `usuario`, os tipos ENUM, o role
de aplicação **`chamados_app` (SEM BYPASSRLS)** e habilita a **Row-Level
Security** (FORCE + policies por `app.current_tenant`).

- As migrations rodam com o **superuser do container** (`POSTGRES_USER`, tem
  BYPASSRLS).
- A aplicação (web/worker) conecta com **`chamados_app`**, que passa por RLS.

Para reverter a última migration: `npm run migration:revert`.

### 3.5 Validar o isolamento por RLS (smoke test)

```bash
npm run smoke:rls
```

Conecta como o role da aplicação (sem bypass), cria 2 tenants + 1 usuário em cada
e prova que, dentro de `runInTenantContext(tenantA)`, só se enxerga o usuário do
tenant A. Deve terminar com `RESULTADO: PASSOU`.

### 3.6 Subir web e worker

Tudo junto (a partir da raiz):

```bash
npm run dev
```

Ou separadamente, em dois terminais:

```bash
npm run dev:web      # Next.js  -> http://localhost:3000
npm run dev:worker   # Worker BullMQ (fila healthcheck)
```

### 3.7 Conferir a saúde da aplicação

```bash
curl http://localhost:3000/api/health
# {"status":"ok","servicos":{"postgres":"ok","redis":"ok"}}
```

Retorna `200` quando Postgres e Redis estão acessíveis; `503` e
`"status":"degradado"` caso contrário.

### 3.8 Worker de IA

O worker processa duas filas: `triagem-ia` (triagem automática de chamados pelo
`agente_ia` — `specs/05-agente-ia.md`) e `notificacoes` (entrega de e-mail/webhook
— ver §3.10). Um único processo (`npm run dev:worker`) registra as duas.

**Fluxo integrado (M7 + M9).** Ao abrir um chamado pela interface (portal ou
painel), a própria server action transiciona `novo → em_triagem` e enfileira o job
de triagem (quando o tenant tem `agente_ia`). O worker então diagnostica e aplica o
resultado; essas mutações da IA (mensagem pública ao cliente, transições de status)
GERAM notificações — a nota interna de diagnóstico e a complexidade permanecem
invisíveis ao cliente e não notificam. A criação/resposta/atribuição feitas na UI
alimentam os dois pipelines de uma vez (um despachante composto em
`apps/web/src/lib/despacho.ts`), com enfileiramento pós-commit best-effort.

Variáveis de ambiente da triagem (ver `.env.example` para os defaults reais):

| Variável             | Default           | Descrição                                                                                                                                                                  |
| -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IA_PROVIDER`        | `fake`            | `fake` (determinístico, SEM rede nem custo, controlado por marcadores no texto do chamado — ex.: `[[falhar]]`, `[[timeout]]`, `[[budget]]`) ou `claude` (Claude Agent SDK) |
| `ANTHROPIC_API_KEY`  | vazio             | só necessária quando `IA_PROVIDER=claude`. NUNCA versionar                                                                                                                 |
| `IA_MODELO`          | `claude-opus-4-8` | modelo do provider real; ignorado pelo `fake`                                                                                                                              |
| `IA_TIMEOUT_MS`      | `600000`          | timeout por execução (honrado via abort)                                                                                                                                   |
| `IA_BUDGET_USD`      | `5`               | teto de custo por execução                                                                                                                                                 |
| `IA_MAX_TURNOS`      | `50`              | limite de turnos/chamadas de ferramenta por execução (D-014: exploração nível Claude Code com Read/Grep/Glob nativas, restritas ao checkout)                               |
| `TRIAGEM_DEBOUNCE_S` | `45`              | debounce antes de processar: agrupa mensagens em rajada e permite nova mensagem substituir a triagem pendente                                                              |

Timeout ou budget excedido não são status próprios: a `ExecucaoIA` fica com
`status='falhou'` e `erro='timeout'` / `erro='budget_excedido'`
(`specs/05-agente-ia.md` §8).

#### Mapa de conhecimento do sistema (D-013)

Antes de analisar chamados, a IA precisa conhecer o sistema: uma execução
dedicada (gatilho `mapeamento`, fila própria `mapeamento-ia`) explora o
repositório e produz um resumo estruturado (stack, módulos, entidades, regras de
negócio, fluxos) persistido no `sistema_alvo` com o commit mapeado. Dispara na
**primeira triagem** sem mapa, quando o **commit do checkout muda**, ou pelo botão
**"Mapear agora"** no cadastro do sistema (`/app/sistemas/[id]`, admin). O resumo
é injetado em toda triagem; a triagem segue o protocolo **investigação-primeiro**
(busca/lê o código antes de decidir; só pergunta ao cliente fatos do lado dele).

| Variável             | Default  | Descrição                                |
| -------------------- | -------- | ---------------------------------------- |
| `IA_MAPA_BUDGET_USD` | `10`     | teto de custo por execução de mapeamento |
| `IA_MAPA_MAX_TURNOS` | `40`     | turnos/ferramentas do mapeamento         |
| `IA_MAPA_MAX_CHARS`  | `12000`  | tamanho máximo do resumo persistido      |
| `IA_MAPA_TIMEOUT_MS` | `600000` | timeout do mapeamento                    |

Nota técnica da fiação (Agent SDK): as ferramentas MCP in-process precisam constar
em `allowedTools` (com prefixo `mcp__triagem__*`) e o modo headless usa
`bypassPermissions` — o menor privilégio vem de `tools: []` (todas as built-in do
SDK desligadas: sem Bash/Read/Web) e `settingSources: []` (isolado de settings do
host); o modelo só enxerga os handles escopados do worker.

#### Autenticação do provider `claude` (D-012)

Quando `IA_PROVIDER=claude`, o worker precisa de **uma** de duas credenciais
(defina em variável de ambiente; se nenhuma estiver presente, o provider falha na
inicialização com mensagem acionável):

| Variável                  | Como obter                                   | Quando usar                                                 |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Console da Anthropic (chave de API)          | **Recomendada para produção / multi-tenant**                |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` (máquina com navegador) | Token de assinatura, para uso próprio / dev / CI de scripts |

- **Precedência:** se as duas estiverem definidas, `ANTHROPIC_API_KEY` vence o
  token de assinatura na cadeia do CLI. Ambas são repassadas ao subprocesso do SDK
  (que parte de `process.env` — o `options.env` do SDK **substitui** o ambiente, não
  mescla; por isso o merge é explícito no provider).
- **Token de assinatura:** gere com `claude setup-token` numa máquina com navegador
  e copie o token para `CLAUDE_CODE_OAUTH_TOKEN`. Vale **~1 ano** e **não renova
  sozinho** — troque antes de expirar. Por ser variável de ambiente, funciona em
  **serviço headless**, independente da conta Windows logada (útil no worker rodando
  como serviço).
- **Aviso de termos (D-012):** a documentação oficial do Agent SDK direciona
  produtos a usar `ANTHROPIC_API_KEY`; o token de assinatura é documentado para
  CI/scripts próprios. O uso do token de assinatura fica a critério e risco do
  operador, para instalação própria (ver `specs/decisoes.md` D-012). A recomendação
  registrada para produção/multi-tenant é a **API key**.

Para rodar o worker isoladamente:

```bash
npm run dev:worker
```

Para validar a infraestrutura de triagem de ponta a ponta (fila, dedupe,
debounce, lock por tenant, RLS de `execucao_ia`):

```bash
npm run smoke:triagem
```

Requer Postgres e Redis de pé (`docker compose up -d`) e as migrations
aplicadas; usa `IA_PROVIDER=fake` internamente, sem custo nem rede.

### 3.9 Resolução automática via PR (M8)

Quando o chamado é `problema` + `complexidade=facil` + compreendido acima do
limiar de confiança, a IA tenta resolver: escreve a correção numa working copy
descartável e o worker cria a branch, comita, faz push e (GitHub) abre o PR —
detalhes do fluxo e do gate duplo (pré-call/pós-call) em `specs/05-agente-ia.md`
§6. **A IA nunca faz merge**: o PR fica sempre aguardando aprovação humana.

Variáveis de ambiente da resolução (ver `.env.example` para os defaults reais):

| Variável                         | Default   | Descrição                                                                 |
| -------------------------------- | --------- | ------------------------------------------------------------------------- |
| `IA_RESOLUCAO_CONFIANCA_MIN`     | `0.7`     | confiança mínima do gate pós-call para o worker tentar branch/PR          |
| `IA_RESOLUCAO_MAX_ARQUIVOS`      | `10`      | teto de arquivos que a tentativa pode criar/alterar                       |
| `IA_RESOLUCAO_MAX_ARQUIVO_BYTES` | `262144`  | teto de tamanho de cada arquivo escrito                                   |
| `IA_RESOLUCAO_MAX_BYTES_TOTAL`   | `1048576` | teto de bytes totais escritos na tentativa                                |
| `IA_RESOLUCAO_PR_TIMEOUT_MS`     | `10000`   | timeout do POST de abertura de PR no GitHub                               |
| `APP_BASE_URL`                   | vazio     | base do painel para o link do chamado no corpo do PR; vazio → só o número |

PR automático só acontece quando o `git_repo_url` do `SistemaAlvo` é
`github.com` **e** há um token com escopo de PR no cofre de segredos; para
outros hosts (GitLab, Bitbucket, self-hosted…) o worker só publica a branch
(push) e a nota interna traz a instrução para abrir o PR manualmente.

Para validar a resolução automática de ponta a ponta (gate, fluxo completo
contra um repo bare local, falha de push, cache íntegro sem credencial,
invisibilidade ao cliente):

```bash
npm run smoke:resolucao
```

Requer Postgres e Redis de pé; roda 100% local (repo bare local como origin,
sem GitHub real), `IA_PROVIDER=fake`, tenants descartáveis.

### 3.10 Notificações (e-mail + webhook)

A fila `notificacoes` (M9 — `specs/06-notificacoes.md`) entrega e-mails
transacionais e de chamado (confirmação de abertura, nova mensagem pública,
mudança de status/prioridade, atribuição, resolução…) e dispara o webhook do
tenant. Em dev, os e-mails vão para o **Mailpit** do `docker-compose`:

- **SMTP** em `localhost:1025` (o worker envia para cá).
- **Inbox (UI)** em http://localhost:8025 — veja os e-mails entregues no navegador.
  A API REST do Mailpit (`http://localhost:8025/api/v1/messages`) lista as mensagens
  em JSON, útil para inspeção automatizada.

Variáveis de ambiente (defaults em `.env.example`; batem com o Mailpit do compose):

| Variável                           | Default                       | Descrição                                                          |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `NOTIFICACOES_SMTP_HOST`           | `localhost`                   | host SMTP da plataforma (dev: Mailpit)                             |
| `NOTIFICACOES_SMTP_PORT`           | `1025`                        | porta SMTP                                                         |
| `NOTIFICACOES_SMTP_SECURE`         | `false`                       | TLS no SMTP (Mailpit em dev não usa)                               |
| `NOTIFICACOES_SMTP_USER` / `_PASS` | vazio                         | credenciais SMTP (Mailpit aceita qualquer uma; deixe vazio em dev) |
| `NOTIFICACOES_REMETENTE_NOME`      | `Chamados`                    | nome do remetente default da plataforma                            |
| `NOTIFICACOES_REMETENTE_EMAIL`     | `nao-responda@chamados.local` | e-mail do remetente default                                        |
| `NOTIFICACOES_WEBHOOK_TIMEOUT_MS`  | `5000`                        | timeout por requisição de webhook                                  |
| `NOTIFICACOES_WEBHOOK_MAX_FALHAS`  | `10`                          | falhas consecutivas até desativar o canal e alertar os admins      |
| `NOTIFICACOES_HOST_PLATAFORMA`     | `localhost:3000`              | host base para montar os deep links dos e-mails                    |
| `MAILPIT_SMTP_PORT`                | `1025`                        | porta SMTP publicada pelo container do Mailpit                     |
| `MAILPIT_UI_PORT`                  | `8025`                        | porta da UI/inbox do Mailpit                                       |

O **webhook** é assinado por HMAC-SHA256 no header `X-Chamados-Signature`
(`sha256=<hex>`), que o receptor recalcula com o segredo do canal; o payload NUNCA
inclui conteúdo interno (notas internas, complexidade). Após
`NOTIFICACOES_WEBHOOK_MAX_FALHAS` falhas consecutivas o canal é desativado
automaticamente e os admins recebem um e-mail de alerta.

Para validar a camada de notificações de ponta a ponta (e-mail SMTP fake + webhook
com HMAC, idempotência, retry, desativação por falhas, RLS):

```bash
npm run smoke:notificacoes
```

Requer Postgres + Redis de pé; usa um transporte SMTP fake e um servidor HTTP local
(não precisa do Mailpit). Deve terminar com `RESULTADO: PASSOU`.

---

## 4. Portas e URLs

| Recurso         | URL / porta                      | Credenciais (dev)                                                       |
| --------------- | -------------------------------- | ----------------------------------------------------------------------- |
| Web (Next.js)   | http://localhost:3000            | —                                                                       |
| Health check    | http://localhost:3000/api/health | —                                                                       |
| PostgreSQL      | localhost:5432                   | `chamados` / `chamados` (admin) · `chamados_app` / `chamados_app` (app) |
| Redis           | localhost:6379                   | —                                                                       |
| MinIO (API S3)  | http://localhost:9000            | `minioadmin` / `minioadmin`                                             |
| MinIO (console) | http://localhost:9001            | `minioadmin` / `minioadmin`                                             |
| Mailpit (SMTP)  | localhost:1025                   | — (aceita qualquer credencial)                                          |
| Mailpit (inbox) | http://localhost:8025            | —                                                                       |

Todas as portas são configuráveis via `.env`.

---

## 5. Comandos úteis

| Comando (na raiz)                        | O que faz                                              |
| ---------------------------------------- | ------------------------------------------------------ |
| `npm install`                            | instala todos os workspaces                            |
| `docker compose up -d`                   | sobe Postgres, Redis, MinIO                            |
| `docker compose ps`                      | status/health dos containers                           |
| `docker compose down`                    | derruba os containers (mantém volumes)                 |
| `docker compose down -v`                 | derruba e **apaga os volumes** (reset total)           |
| `npm run migration:run`                  | aplica as migrations                                   |
| `npm run migration:revert`               | reverte a última migration                             |
| `npm run smoke:rls`                      | testa o isolamento por RLS                             |
| `npm run smoke:triagem`                  | testa a infra de triagem (fila/dedupe/lock)            |
| `npm run smoke:resolucao`                | testa a resolução automática via PR (gate/branch/push) |
| `npm run smoke:notificacoes`             | testa e-mail + webhook (SMTP fake + HMAC)              |
| `npm run dev`                            | sobe web + worker juntos                               |
| `npm run dev:web` / `npm run dev:worker` | sobe web / worker separados                            |
| `npm run build`                          | build de produção do web                               |
| `npm run typecheck`                      | typecheck de todos os workspaces                       |
| `npm run lint`                           | ESLint (flat config)                                   |
| `npm run format`                         | Prettier (escreve)                                     |

---

## 6. Troubleshooting (Windows)

- **`docker compose up` falha com `open //./pipe/dockerDesktopLinuxEngine`**
  O Docker Desktop não está rodando. Abra o Docker Desktop e aguarde o ícone
  ficar verde; confirme com `docker info`.

- **Porta já em uso (5432, 6379, 3000, 9000, 9001)**
  Outro serviço (ex.: um Postgres local) está ocupando a porta. Mude a porta no
  `.env` (ex.: `POSTGRES_PORT=5433`) e suba de novo, ou pare o serviço conflitante.

- **Migration falha com autenticação ou "role não existe"**
  Garanta que o Postgres está `healthy` (`docker compose ps`) e que o `.env`
  bate com o compose. Para um reset limpo do banco:
  `docker compose down -v && docker compose up -d` e rode as migrations de novo.

- **`/api/health` retorna `degradado`**
  Algum serviço de infra está fora. Rode `docker compose ps` e verifique
  Postgres/Redis; suba o que estiver parado.

- **`ECONNRESET` ao conectar em Postgres/Redis, com o container `healthy`**
  Sintoma clássico de porta interceptada no host: o TCP conecta, mas a conexão
  é resetada antes do handshake do protocolo, e o log do container não registra
  nada. Duas causas conhecidas no Windows:
  1. **Portproxy órfão do `netsh`** — `netsh interface portproxy show all` lista
     um proxy `0.0.0.0:5432 → <IP antigo do WSL>` que captura a porta antes do
     Docker. Removê-lo exige admin (`netsh interface portproxy delete ...`).
     **Workaround sem admin:** mude a porta publicada no `.env`
     (ex.: `POSTGRES_PORT=55432`), rode `docker compose up -d` e reinicie
     web/worker — o compose e a aplicação usam a mesma variável.
  2. **`wslrelay` em `[::1]`** — serviços dentro de uma distro WSL fazem o
     Windows escutar a mesma porta em IPv6 (`[::1]`), e `localhost` resolve
     primeiro para `::1`. Por isso os `*_HOST` do `.env` devem ser `127.0.0.1`,
     nunca `localhost`.
     Diagnóstico rápido: `netstat -ano | findstr :5432` e veja qual PID detém a
     porta (`tasklist /fi "pid eq <PID>"`).
     ⚠️ Ao recriar o `.env` a partir do `.env.example`, preserve o `POSTGRES_PORT`
     customizado — voltar para 5432 reintroduz o `ECONNRESET` se o portproxy ainda
     existir.

- **Fim de linha (CRLF/LF)**
  O repositório usa `LF` (`.editorconfig` + `.gitattributes` implícito via
  Prettier). Se o Git reclamar, `git config core.autocrlf false`.

- **A porta do Next não libera após `Ctrl+C`**
  Em raras vezes o processo `node` fica órfão. Finalize-o:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | Stop-Process -Id { $_.OwningProcess } -Force` (PowerShell).

---

## 7. Notas de arquitetura relevantes ao dev

- **Todo acesso a dados de negócio passa por `runInTenantContext(ds, tenantId, fn)`**
  (`packages/db/src/rls.ts`): abre transação e faz `SET LOCAL app.current_tenant`
  antes de qualquer query. Nunca rode queries de negócio fora dele — a RLS
  bloquearia (ou, pior, num pool, um `SET` de sessão vazaria tenant entre requests).
- **Dois roles no Postgres**: `chamados` (admin, migrations, BYPASSRLS) e
  `chamados_app` (aplicação, SEM BYPASSRLS). A app nunca usa o admin.
- **Identificadores de domínio em português** (tabelas/colunas/enums), conforme
  `specs/02-modelo-de-dados.md`.
