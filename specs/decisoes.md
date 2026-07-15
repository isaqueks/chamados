# Registro de Decisões (ADR)

> Cada decisão tem ID, data e consequências. Decisões são adicionadas ao final e **nunca removidas**; se uma for revertida, cria-se uma nova que a substitui (supersede). Referencie-as pelos IDs (D-001, D-002…).

## D-001 — Stack técnica confirmada, com TypeORM (2026-07-15)

**Status:** aceita.
**Contexto:** `01-arquitetura.md` recomendava uma stack de referência (com Prisma como ORM, sujeito a spike vs Drizzle). O usuário confirmou a stack com um ajuste: **TypeORM**.
**Decisão:** monorepo TypeScript · Next.js (App Router) full-stack · PostgreSQL 16 com `tenant_id` + Row-Level Security · **TypeORM** · Redis + BullMQ · storage S3-compatível (MinIO) · TipTap para rich text · better-auth para autenticação.
**Consequências:** spike Prisma vs Drizzle cancelado. O escopo de tenant no RLS usa transações TypeORM com `SET LOCAL app.current_tenant`, encapsuladas num helper `runInTenantContext(tenantId, fn)` — todo acesso a dados passa por ele.

## D-002 — Toda infraestrutura em Docker (2026-07-15)

**Status:** aceita.
**Decisão:** PostgreSQL, Redis, MinIO e qualquer serviço de infraestrutura rodam **sempre em containers** — dev via `docker-compose`, produção via containers orquestrados. Nenhum serviço instalado diretamente na máquina.
**Consequências:** paridade dev/prod garantida; onboarding de dev = `docker compose up -d`.

## D-003 — Notificações fase 1: SMTP + Webhook genérico; WhatsApp adiado (2026-07-15)

**Status:** aceita.
**Contexto:** o usuário já possui um sistema externo de entrega de mensagens pronto — o Chamados só precisa notificá-lo.
**Decisão:** o MVP inclui, além do e-mail SMTP, um **WebhookAdapter genérico**: cada tenant configura URL + segredo; o sistema envia POST JSON assinado (HMAC) a cada atualização de chamado. WhatsApp sai do horizonte imediato (a análise Meta/Twilio/Evolution permanece em `06-notificacoes.md` como referência futura).
**Consequências:** RF-18 é atendido na fase 1 via SMTP + webhook; o payload do webhook nunca inclui conteúdo interno (notas, complexidade).

## D-004 — Nome do produto: "Chamados" (2026-07-15)

**Status:** aceita. O nome provisório passa a ser o definitivo.

## D-005 — Sem importador de dados do osTicket (2026-07-15)

**Status:** aceita.
**Decisão:** não haverá importador por ora. Estratégia de transição: manter o osTicket acessível em modo leitura enquanto o histórico for necessário.

## D-006 — Engine de IA: Claude Agent SDK com Opus 4.8 (2026-07-15)

**Status:** aceita.
**Decisão:** a fase 1 usa o **Claude Agent SDK** (programático — controle de ferramentas, structured output, telemetria) em vez de invocar o Claude Code CLI cru, sempre atrás da interface `AIProvider` (`01-arquitetura.md §4.1`) para permitir troca de engine sem reescrever o pipeline.

## D-007 — better-auth para autenticação (2026-07-15)

**Status:** aceita.
**Decisão:** better-auth em vez de Auth.js/NextAuth, pelo suporte first-class a multi-tenancy e sessões próprias sem dependência de OAuth externo (`03-autenticacao-perfis-permissoes.md`).

## D-008 — Política de documentação contínua (2026-07-15)

**Status:** aceita.
**Decisão:** **toda** alteração no projeto deve deixar rastro: entrada no `CHANGELOG.md` (o que mudou e por quê), atualização da spec afetada (comportamento) e, quando houver decisão nova, registro neste arquivo. Nada muda sem documentação.

## D-009 — Princípios de UI (2026-07-15)

**Status:** aceita.
**Decisão:** a UI deve ser **limpa, bonita, intuitiva, fácil de usar e consistente**. Implementação com shadcn/ui + Tailwind, temas via CSS variables (branding por tenant com validação de contraste AA). Todo componente novo segue o design system — nada de estilos ad-hoc.
