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

Sobem três containers (prefixo `chamados-`):

| Serviço       | Container           | Porta host                  | Para quê                   |
| ------------- | ------------------- | --------------------------- | -------------------------- |
| PostgreSQL 16 | `chamados-postgres` | 5432                        | banco (tenant_id + RLS)    |
| Redis 7       | `chamados-redis`    | 6379                        | filas (BullMQ), cache      |
| MinIO         | `chamados-minio`    | 9000 (API) / 9001 (console) | storage S3-compat (anexos) |

Aguarde todos ficarem `healthy` antes de rodar as migrations.

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

Todas as portas são configuráveis via `.env`.

---

## 5. Comandos úteis

| Comando (na raiz)                        | O que faz                                    |
| ---------------------------------------- | -------------------------------------------- |
| `npm install`                            | instala todos os workspaces                  |
| `docker compose up -d`                   | sobe Postgres, Redis, MinIO                  |
| `docker compose ps`                      | status/health dos containers                 |
| `docker compose down`                    | derruba os containers (mantém volumes)       |
| `docker compose down -v`                 | derruba e **apaga os volumes** (reset total) |
| `npm run migration:run`                  | aplica as migrations                         |
| `npm run migration:revert`               | reverte a última migration                   |
| `npm run smoke:rls`                      | testa o isolamento por RLS                   |
| `npm run dev`                            | sobe web + worker juntos                     |
| `npm run dev:web` / `npm run dev:worker` | sobe web / worker separados                  |
| `npm run build`                          | build de produção do web                     |
| `npm run typecheck`                      | typecheck de todos os workspaces             |
| `npm run lint`                           | ESLint (flat config)                         |
| `npm run format`                         | Prettier (escreve)                           |

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
