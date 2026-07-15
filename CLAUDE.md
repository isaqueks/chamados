# Chamados — guia para sessões de desenvolvimento

Helpdesk IA-first, whitelabel multi-tenant, substituto do osTicket. Metodologia **spec-driven**: as specs em `specs/` são a fonte da verdade.

## Regras do projeto (não negociáveis)

1. **Spec antes de código.** Antes de implementar qualquer módulo, leia a spec correspondente (índice no `README.md`). Se implementação e spec divergirem, a spec ganha — ou atualize a spec primeiro.
2. **Tudo é documentado** (D-008 em `specs/decisoes.md`): toda alteração exige entrada no `CHANGELOG.md` + atualização da spec afetada; decisões novas viram ADR em `specs/decisoes.md`. Sem exceções.
3. **Idioma:** comunicação, documentação e identificadores de domínio (entidades, colunas, enums) em pt-BR, conforme `specs/02-modelo-de-dados.md`. Termos técnicos em inglês quando natural.
4. **Subagentes:** no máximo **Opus 4.8** (`model: 'opus'`); modelos menores (sonnet/haiku) são permitidos para tarefas simples. A orquestração é sempre do agente principal — nunca delegue a coordenação.
5. **Infra sempre em Docker** (D-002): nunca instale/aponte para PostgreSQL, Redis ou MinIO fora de containers.
6. **Multi-tenant é inegociável:** todo acesso a dados passa por `runInTenantContext(tenantId, fn)` (transação + `SET LOCAL app.current_tenant`, RLS como rede de segurança). Toda feature nova precisa de teste de isolamento cross-tenant.
7. **Guardrails de IA:** o agente_ia nunca faz merge/deploy; só branch + PR com aprovação humana. Ferramentas do worker são escopadas (BD somente SELECT). Ver `specs/05-agente-ia.md` e `specs/09-seguranca-lgpd.md`.

## Stack (D-001)

Monorepo TypeScript · Next.js App Router · PostgreSQL 16 + RLS · **TypeORM** · Redis + BullMQ · MinIO/S3 · TipTap · better-auth · Claude Agent SDK (Opus 4.8) atrás da interface `AIProvider`.

## Enums canônicos (resumo — fonte: specs/02)

- status: `novo` `em_triagem` `aguardando_cliente` `em_atendimento` `resolvido` `fechado` `cancelado`
- natureza: `problema` `alteracao` · prioridade: `baixa` `media` `alta` `urgente`
- complexidade (interna): `facil` `medio` `dificil` · visibilidade de mensagem: `publica` `interna`
- papéis: `admin` `operador` `cliente` `agente_ia`

## UI (D-009)

Limpa, bonita, intuitiva, fácil de usar e **consistente**. shadcn/ui + Tailwind, tema via CSS variables com branding por tenant. Nada de estilo ad-hoc fora do design system.

## Estrutura do monorepo

`apps/web` (Next.js 16 + shadcn/ui) · `apps/worker` (BullMQ) · `packages/db` (TypeORM: entidades, migrations, `runInTenantContext`) · `packages/shared` (enums canônicos). Guia de setup: `docs/desenvolvimento.md`.

## Comandos

```bash
docker compose up -d          # sobe postgres/redis/minio (healthchecks)
npm install                   # instala todos os workspaces
npm run migration:run         # aplica migrations (revert: migration:revert)
npm run smoke:rls             # prova o isolamento por RLS
npm run dev                   # web + worker (ou dev:web / dev:worker)
npm run build                 # build de produção do web
npm run typecheck             # typecheck de todos os workspaces
npm run lint                  # eslint · npm run format (prettier)
```

Portas: web 3000 · Postgres 5432 · Redis 6379 · MinIO 9000/9001 (console). Roles do banco: `chamados` (admin/migrations, com bypass de RLS) e `chamados_app` (aplicação, **sem** BYPASSRLS — nunca conecte a app com o role admin).
