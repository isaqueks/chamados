# Chamados — Helpdesk moderno com IA (whitelabel multi-tenant)

Substituto do osTicket: sistema de chamados prático e moderno, com um agente de IA que faz triagem, classifica, pede informações, resolve casos simples e gera SPECs de alteração.

> **Status:** MVP (marcos **M0–M10** do roadmap) implementado e em produção com um tenant piloto; evolução contínua por ADRs (D-001 → D-036). A **Forja** (client local de implementação, D-036) tem o **MVP implementado** (`apps/forja`; `npm run forja`); configuração em 2 passos (conexão + pasta do repositório; o resto é autodetectado, FJ-030); pendências na entrada D-036 do `CHANGELOG.md` (prints pelo agente num chamado real, modo reforçado, smoke pago de perfis…). As specs em `specs/` são a fonte da verdade; decisões em `specs/decisoes.md`; mudanças registradas no `CHANGELOG.md`.

## Executando localmente

```bash
docker compose up -d     # postgres 16, redis, minio (tudo em Docker — D-002)
npm install
npm run migration:run
npm run dev              # web em http://localhost:3000 + worker

# Forja (local, opcional — docs §3.12)
npm run build -w @chamados/forja && npm run forja   # http://127.0.0.1:4317 (link com token no terminal)
```

Guia completo (pré-requisitos, troubleshooting): [docs/desenvolvimento.md](docs/desenvolvimento.md).

## Documentos

| Doc                                                                                | Conteúdo                                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [requisitos-originais.md](specs/requisitos-originais.md)                           | Requisitos como o usuário os expressou (fonte da verdade, IDs RF-xx/RNF-xx) |
| [decisoes.md](specs/decisoes.md)                                                   | Registro de decisões (ADR) — D-001 em diante                                |
| [00-visao-geral.md](specs/00-visao-geral.md)                                       | Visão, objetivos, personas, princípios, glossário canônico                  |
| [01-arquitetura.md](specs/01-arquitetura.md)                                       | Stack, componentes, filas, storage, abstração do provider de IA             |
| [02-modelo-de-dados.md](specs/02-modelo-de-dados.md)                               | Entidades, relações, enums, multi-tenant no BD (RLS)                        |
| [03-autenticacao-perfis-permissoes.md](specs/03-autenticacao-perfis-permissoes.md) | Auth, convites, matriz de permissões, agente_ia como service account        |
| [04-chamados.md](specs/04-chamados.md)                                             | Ciclo de vida, máquina de estados, mensagens, notas internas, anexos        |
| [05-agente-ia.md](specs/05-agente-ia.md)                                           | Pipeline de triagem, resolução automática, template de SPEC, guardrails     |
| [06-notificacoes.md](specs/06-notificacoes.md)                                     | Gateways plugáveis: e-mail, WhatsApp; eventos, templates, preferências      |
| [07-multitenancy-whitelabel.md](specs/07-multitenancy-whitelabel.md)               | Tenants, branding, domínios, sistemas-alvo, isolamento                      |
| [08-ui-ux.md](specs/08-ui-ux.md)                                                   | Mapa de telas, fluxos, portal do cliente vs painel operador/admin           |
| [09-seguranca-lgpd.md](specs/09-seguranca-lgpd.md)                                 | Ameaças, prompt injection, uploads, XSS, segredos, LGPD                     |
| [10-roadmap-mvp.md](specs/10-roadmap-mvp.md)                                       | Corte do MVP, fases 2 e 3, riscos, ordem de implementação                   |
| [11-api-mcp.md](specs/11-api-mcp.md)                                               | API HTTP `/api/v1` (login/senha) e servidor MCP para assistentes            |
| [forja/](specs/forja/00-visao-geral.md)                                            | **Forja** (D-036): client local que implementa chamados com a CLI do Claude |

## Conceitos-chave

- **Papéis:** `admin`, `operador`, `cliente`, `agente_ia` (a IA é um usuário de serviço).
- **Chamado:** natureza (`problema` | `alteracao`), prioridade (`baixa`→`urgente`), complexidade interna (`facil` | `medio` | `dificil`), status (`novo` → `em_triagem` → `aguardando_cliente`/`em_atendimento` → `resolvido` → `fechado`).
- **SistemaAlvo:** cada tenant cadastra os sistemas sobre os quais abre chamados — repositório git, logs e conexão read-only ao BD, que a IA usa na triagem (com `git pull` a cada análise).
- **IA fase 1:** Claude Agent SDK com Opus 5, esforço `high` (D-006, D-031), atrás da interface `AIProvider` para permitir troca de engine.
- **Stack (D-001):** Next.js 16 App Router · PostgreSQL 16 + RLS · TypeORM · Redis/BullMQ · MinIO · TipTap · autenticação própria conforme spec 03 (D-010) — infraestrutura sempre em Docker (D-002).
- **Forja (D-036):** app web **local** (`apps/forja`, MVP implementado) que lista os chamados pela API, implementa-os com a CLI do Claude Code (Fable orquestra, Opus implementam e revisam) em worktrees isoladas, gera relatório não técnico, espera aprovação humana, faz merge e responde/encerra o chamado. Specs em [specs/forja/](specs/forja/00-visao-geral.md).
- **API + MCP (D-028):** API HTTP `/api/v1` (login por e-mail/senha, Bearer-only) e servidor MCP (`apps/mcp`) para usar o Chamados dentro do Claude — ler chamados e timeline, publicar mensagens, mudar status e abrir chamados (D-032), sempre no escopo do papel do usuário. Ver [specs/11](specs/11-api-mcp.md) e o guia em [docs/desenvolvimento.md](docs/desenvolvimento.md) §3.11.
