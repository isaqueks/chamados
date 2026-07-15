# Changelog

> Registro de todas as alterações do projeto (política D-008 em `specs/decisoes.md`): toda mudança de comportamento, spec ou decisão entra aqui, da mais recente para a mais antiga.

## 2026-07-15 — Especificação completa + Marco M0 (fundação)

### Especificação (spec-driven development)

- Criados os requisitos rastreáveis em `specs/requisitos-originais.md` (RF-01…RF-19, RNF-01…RNF-03) a partir do pedido original do usuário.
- Escritos os 11 documentos de spec (`specs/00-visao-geral.md` … `10-roadmap-mvp.md`) por processo multi-agente: 11 redatores em paralelo, 3 revisores cruzados (consistência, completude contra requisitos, viabilidade/segurança — 44 findings), 7 corretores e 1 reconciliação final (variável RLS `app.current_tenant`, shape canônico de `SistemaAlvo`, contrato `AIProvider` definido em `01 §4.1`, `nome_exibicao` no Tenant, remoção de magic link, pipeline de imagens `data:` no rich text).
- Criado `specs/decisoes.md` (ADR) com as decisões **D-001 a D-009**: stack confirmada com **TypeORM** no lugar do Prisma; infraestrutura 100% Docker; notificações fase 1 = SMTP + **webhook genérico assinado (HMAC)** com WhatsApp adiado; nome definitivo **"Chamados"**; sem importador do osTicket; engine de IA = **Claude Agent SDK** com Opus 4.8; **better-auth**; política de documentação contínua; princípios de UI (limpa, bonita, intuitiva, fácil, consistente — shadcn/ui + Tailwind).
- Decisões propagadas para 8 documentos da spec, incluindo: seções de RLS/pool reescritas para transações TypeORM com helper `runInTenantContext`; nova seção `06 §3.2` (adapter de webhook: config por tenant, POST JSON assinado em `X-Chamados-Signature`, 7 eventos, retries/idempotência, desativação após falhas consecutivas); novo item de escopo **E-33** (webhook no MVP, marco M9); rastreabilidade RF-17/RF-18 atualizada.
- Criados `CLAUDE.md` (regras de desenvolvimento para sessões futuras) e `README.md` (índice + quick start).

### Marco M0 — fundação do monorepo (roadmap `10-roadmap-mvp.md`)

- Monorepo npm workspaces (`apps/*`, `packages/*`) com TypeScript estrito, ESLint flat config e Prettier compartilhados; `git init` (sem commits); `.env.example` documentado.
- `docker-compose.yml`: postgres:16-alpine, redis:7-alpine e MinIO, todos com healthchecks, volumes nomeados e portas via `.env` (D-002).
- `packages/shared`: enums canônicos da spec 02 como const objects + tipos (status, natureza, prioridade, complexidade, visibilidade, papéis, status_tenant, status_usuario).
- `packages/db`: DataSource TypeORM (roles separados: `chamados` admin/migrations e `chamados_app` **sem BYPASSRLS** para a aplicação); entidades `Tenant` e `Usuario` (colunas em pt-BR conforme spec 02, `UNIQUE(tenant_id, email)`); migration inicial com **RLS FORCE** e policies por `current_setting('app.current_tenant')`; helper `runInTenantContext(tenantId, fn)`; smoke test que prova o isolamento cross-tenant.
- `apps/web`: Next.js 16 (App Router, Tailwind v4, shadcn/ui), página placeholder e rota `/api/health` (verifica Postgres + Redis).
- `apps/worker`: esqueleto BullMQ (fila `healthcheck`, shutdown limpo).
- `docs/desenvolvimento.md`: guia de setup do dev em pt-BR.
- **Verificações executadas e aprovadas:** `npm install`, `typecheck` (4 workspaces), `next build`, `docker compose up -d` (3 serviços healthy), migrations no Postgres do compose, smoke test de RLS, `/api/health` HTTP 200, worker processando job.

### Correções pós-M0

- Coluna jsonb do Tenant renomeada de `config` para `config_branding` (código alinhado à spec 02); banco recriado, migrations e smoke test revalidados.
- Spec 01: "Next.js 15" → "Next.js 16" (versão real entregue pelo scaffold).

### Desvios registrados (a revisitar)

- PKs em UUID v4 (`gen_random_uuid()` nativo do PG16) em vez do UUID v7 sugerido pela spec 02 — trocar quando houver decisão sobre geração client-side/extension.
- Entidades TypeORM via `EntitySchema` (schema-based) em vez de decorators, para evitar fricção de `reflect-metadata` entre o bundler do Next e o tsx; migrations em SQL manual (controle total do RLS).
- Webhook notifica 7 eventos; SMTP do MVP segue com 4 (E-27) — diferença deliberada da D-003, ampliar SMTP se quiser paridade.
