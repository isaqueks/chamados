# Chamados — Helpdesk moderno com IA (whitelabel multi-tenant)

Substituto do osTicket: sistema de chamados prático e moderno, com um agente de IA que faz triagem, classifica, pede informações, resolve casos simples e gera SPECs de alteração.

> **Status:** specs concluídas e marco **M0 (fundação)** implementado — monorepo, Docker Compose, TypeORM com RLS multi-tenant e smoke test de isolamento passando. As specs em `specs/` são a fonte da verdade; decisões em `specs/decisoes.md`; mudanças registradas no `CHANGELOG.md`.

## Executando localmente

```bash
docker compose up -d     # postgres 16, redis, minio (tudo em Docker — D-002)
npm install
npm run migration:run
npm run dev              # web em http://localhost:3000 + worker
```

Guia completo (pré-requisitos, troubleshooting): [docs/desenvolvimento.md](docs/desenvolvimento.md).

## Documentos

| Doc | Conteúdo |
|---|---|
| [requisitos-originais.md](specs/requisitos-originais.md) | Requisitos como o usuário os expressou (fonte da verdade, IDs RF-xx/RNF-xx) |
| [decisoes.md](specs/decisoes.md) | Registro de decisões (ADR) — D-001 em diante |
| [00-visao-geral.md](specs/00-visao-geral.md) | Visão, objetivos, personas, princípios, glossário canônico |
| [01-arquitetura.md](specs/01-arquitetura.md) | Stack, componentes, filas, storage, abstração do provider de IA |
| [02-modelo-de-dados.md](specs/02-modelo-de-dados.md) | Entidades, relações, enums, multi-tenant no BD (RLS) |
| [03-autenticacao-perfis-permissoes.md](specs/03-autenticacao-perfis-permissoes.md) | Auth, convites, matriz de permissões, agente_ia como service account |
| [04-chamados.md](specs/04-chamados.md) | Ciclo de vida, máquina de estados, mensagens, notas internas, anexos |
| [05-agente-ia.md](specs/05-agente-ia.md) | Pipeline de triagem, resolução automática, template de SPEC, guardrails |
| [06-notificacoes.md](specs/06-notificacoes.md) | Gateways plugáveis: e-mail, WhatsApp; eventos, templates, preferências |
| [07-multitenancy-whitelabel.md](specs/07-multitenancy-whitelabel.md) | Tenants, branding, domínios, sistemas-alvo, isolamento |
| [08-ui-ux.md](specs/08-ui-ux.md) | Mapa de telas, fluxos, portal do cliente vs painel operador/admin |
| [09-seguranca-lgpd.md](specs/09-seguranca-lgpd.md) | Ameaças, prompt injection, uploads, XSS, segredos, LGPD |
| [10-roadmap-mvp.md](specs/10-roadmap-mvp.md) | Corte do MVP, fases 2 e 3, riscos, ordem de implementação |

## Conceitos-chave

- **Papéis:** `admin`, `operador`, `cliente`, `agente_ia` (a IA é um usuário de serviço).
- **Chamado:** natureza (`problema` | `alteracao`), prioridade (`baixa`→`urgente`), complexidade interna (`facil` | `medio` | `dificil`), status (`novo` → `em_triagem` → `aguardando_cliente`/`em_atendimento` → `resolvido` → `fechado`).
- **SistemaAlvo:** cada tenant cadastra os sistemas sobre os quais abre chamados — repositório git, logs e conexão read-only ao BD, que a IA usa na triagem (com `git pull` a cada análise).
- **IA fase 1:** Claude Agent SDK com Opus 4.8 (D-006), atrás da interface `AIProvider` para permitir troca de engine.
- **Stack (D-001):** Next.js 16 App Router · PostgreSQL 16 + RLS · TypeORM · Redis/BullMQ · MinIO · TipTap · better-auth — infraestrutura sempre em Docker (D-002).
