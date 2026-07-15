# Changelog

> Registro de todas as alterações do projeto (política D-008 em `specs/decisoes.md`): toda mudança de comportamento, spec ou decisão entra aqui, da mais recente para a mais antiga.

## 2026-07-15 — Marco M5: portal do cliente + painel operador/admin (2 agentes em paralelo + integração)

- **Portal do cliente (`/portal`)**: experiência minimalista mobile-first com branding whitelabel — lista "Meus chamados" (abertos/histórico, destaque "Aguardando você"), abertura com formulário mínimo (sistema-alvo só se >1, natureza em cards, prioridade recolhida em opções avançadas), detalhe com timeline pública, responder/reabrir/cancelar conforme a máquina de estados, estados vazios e skeletons.
- **Editor TipTap compartilhado** (`components/editor/`): alinhado 1:1 à allowlist do pipeline server-side, toolbar mínima, imagem colada vira anexo no server (comprovado: HTML final sem `data:`); usado no portal e no compositor do painel.
- **Painel operador/admin (`/app`)**: redirect por papel no login (cliente → `/portal`), fila com tabela densa, filtros combináveis com contadores, busca rápida e ações de linha; detalhe em duas colunas (timeline com notas internas default Interna + painel de propriedades com transições/atribuição/classificação); dashboard com KPIs e bloco "Precisa de você"; seção "Assistente IA" como placeholder estruturado para M6+; badges centralizados; gestão integrada à nova sidebar; sonner/toasts.
- **Integração**: `bodySizeLimit 32mb` nos server actions (imagens coladas grandes), compositor do painel usando o editor compartilhado, `fechar_automaticamente_em` exposto ao cliente no serializer.
- Novos services read-only: fila com joins/facetas (`consulta-service`) e métricas (`dashboard-service`, tempo de 1ª resposta derivado de `evento_chamado`).
- Desvios deliberados: tabs mobile do detalhe viram colunas empilhadas (tabs adiadas); "abrir em nome do cliente" adiado; cores de badge da paleta Tailwind theme-aware centralizadas.
- **Verificado:** typecheck, lint, build (20 rotas), 73/73 testes, smokes completos, E2E nas duas áreas (redirects por papel, filtros, mutações gerando eventos na timeline, visibilidade de nota interna, dashboard com números do seed).

## 2026-07-15 — Marco M4: mensagens, rich text sanitizado, anexos e auditoria

- **Mensagens** públicas/internas imutáveis: cliente só cria públicas nos próprios chamados; filtro de visibilidade no repositório + serializer como segunda barreira; resposta pública do cliente em `aguardando_cliente` transiciona automaticamente para `em_triagem` (evento pelo ator `sistema`).
- **Pipeline real de rich text** (substitui o provisório do M3): validação estrutural fail-closed do doc TipTap → imagens `data:` viram `Anexo inline` (magic bytes) com `src` reescrito → HTML construído do JSON validado (nunca parse de HTML do cliente), sem `data:`/scripts/handlers, links só http(s)/mailto com rel seguro. Dupla representação (JSON fonte + HTML sanitizado) na descrição e nas mensagens.
- **Anexos**: magic bytes default-deny (SVG bloqueado no MVP), 25 MB/arquivo, chave prefixada por tenant; download apenas por URL pré-assinada curta após `autorizar()` + visibilidade da mensagem dona (anexo de nota interna nunca chega ao cliente).
- **EventoChamado**: tabela append-only (grant só SELECT/INSERT no banco); todas as mutações de M3/M4 geram eventos com o enum canônico; eventos internos (nota interna, complexidade, atribuição, anexo) ocultos ao cliente.
- Detalhe provisório `/app/chamados/[id]` com timeline intercalada, toggle Pública/Interna (default Interna para operador) e anexos; seed com mensagens de exemplo; `npm run smoke:mensagens` (34 asserts).
- Matriz `autorizar()`: cliente ❌ em `mudar_prioridade`/`mudar_natureza` pós-criação (specs 03/04 reconciliadas: título 3–160, cancelamento pelo cliente em estados iniciais explícito na matriz).
- **Verificado:** typecheck, lint, build, migrations zero/incremental/revert, 6 smokes, 72/72 testes, E2E (operador vê nota interna; cliente não vê nota/badge/complexidade).
- Notas: scan antivírus/quarentena de anexos fica para fase posterior (spec 09); `format:check` divergia no repo inteiro (pré-existente) — baseline do prettier aplicado em commit separado na sequência.

## 2026-07-15 — Marco M3: Chamado — modelo, numeração e máquina de estados

- **Máquina de estados pura** em `packages/shared` (spec 04 §1.3): tabela canônica de transições × papéis com motivos de negação, invariantes (fechado/cancelado terminais, `agente_ia` nunca resolve, reabertura só de `resolvido`, admin ⊇ operador) — 38 testes.
- **Entidade Chamado** com migration RLS: campos canônicos da spec 02 (descrição em JSON+HTML, natureza/prioridade/complexidade, `fechar_automaticamente_em`, `reaberto_count`), CHECKs (título 3..160, sistema_alvo XOR categoria) e índice parcial de auto-fechamento.
- **Numeração sequencial por tenant sem buracos**: tabela `tenant_contador` com upsert atômico na transação de criação (sequências independentes por tenant).
- **Services**: criar (formulário mínimo), transicionar (máquina + autorização + ownership; agenda auto-fechamento pelo `dias_fechamento_automatico` do tenant), atribuir, prioridade/complexidade/natureza, listar (filtros da spec, escopo por papel, keyset pagination), obter (serializer por papel — cliente nunca recebe complexidade).
- Rich text **provisório** (texto simples → doc mínimo + HTML escapado) e seam de auditoria no-op — ambos marcados para o M4 substituir.
- Página provisória `/app/chamados` (lista + abertura + transições válidas por papel); seed com 4 chamados de exemplo; `npm run smoke:chamados` (38 asserts).
- **Verificado:** typecheck, lint, build, migrations zero/incremental/revert, 6 smokes, 69/69 testes, health.
- Conflitos de spec identificados e decididos (reconciliação em andamento): título 160 (02 manda no schema), cliente cancela os próprios chamados em estados iniciais (04 manda no ciclo de vida), prioridade/natureza do cliente só na abertura (04 §3).

## 2026-07-15 — Marco M2: SistemaAlvo, cofre de segredos, categorias, branding e domínio próprio

- **SecretStore (specs 07/09):** envelope encryption AES-256-GCM (chave mestra em `SECRET_STORE_MASTER_KEY`, DEK por segredo), tabela `segredo` com RLS; refs `*_ref` só resolvem no contexto do tenant dono; credencial do `agente_ia` migrada do env para o cofre (`usuario.credencial_servico_ref`).
- **SistemaAlvo:** entidade com shape canônico da spec 02 (repo git + credencial, logs, conexão BD read-only) + CRUD admin com segredos sempre mascarados (a leitura retorna apenas presença, nunca o valor) e aviso de usuário de BD somente-leitura no formulário.
- **Categoria:** CRUD admin; categoria "Geral" protegida, criada no provisionamento.
- **Branding whitelabel:** cores com validação de contraste WCAG AA no salvamento e fallback neutro no render; logo no MinIO (magic bytes PNG/JPEG/WEBP ≤1MB) servido por rota controlada; CSS variables no login e no app; tela `/app/config` com preview; config geral do tenant (dias de auto-fechamento, IA habilitada — uso real em M6+).
- **Domínio próprio:** configuração com validação e unicidade global; resolução host exato → slug (TLS/ACME fica para o deploy).
- **Storage:** novo pacote `@chamados/storage` (S3/MinIO, URLs pré-assinadas, bucket único com prefixo por tenant, provisionado no compose) — base para os anexos do M4.
- Specs sincronizadas: D-010 (auth própria) propagado em 6 documentos; entidade `RedefinicaoSenha` e função `chamados_resolver_tenant` documentadas na spec 02; correção npm workspaces na spec 01.
- Comandos novos: `npm run smoke:secrets`, `npm run smoke:sistemas`.
- **Verificado:** typecheck, lint, build (14 rotas), migrations do zero e incremental, smokes rls/auth/secrets/sistemas, 47/47 testes, E2E HTTP (branding → CSS vars, guardas, upload de logo, fallback de cor reprovada).
- Débitos anotados: `cor_secundaria` persistida mas sem elemento visível vinculado; config geral reutiliza o recurso `config_notificacoes` na matriz de autorização (criar recurso `config_tenant` dedicado no M10); GC de logos órfãos.

## 2026-07-15 — Marco M1: autenticação, perfis e permissões

- **Autenticação hand-rolled conforme spec 03 (D-010, substitui D-007/better-auth):** Argon2id, sessões server-side revogáveis com cookie opaco (`token_hash` no banco), anti-enumeração, reset/troca de senha invalida todas as sessões. E-mails (convite/reset) são stub logado até o M9.
- Novas entidades/migrations com RLS: `sessao`, `convite`, `redefinicao_senha`; `usuario` ganhou `credencial_servico_ref`, CHECK "agente_ia sem senha" e unique parcial de um `agente_ia` por tenant; função `chamados_resolver_tenant` (SECURITY DEFINER) resolve tenant por slug/domínio antes do contexto RLS.
- Resolução de tenant por subdomínio (`acme.localhost:3000`) via proxy do Next 16 (novo nome do middleware), com fallback dev.
- Autorização: ponto único `autorizar(ator, recurso, acao, alvo?)` com a matriz completa da spec 03 §8 + serializers allowlist para o papel cliente (nunca expõe notas internas/complexidade). 23 testes unitários.
- Convites (admin convida, aceite cria conta + auto-login) com UI; provisionamento idempotente de tenant com `agente_ia` service account (token em env, provisório até o cofre do M2); `npm run seed:dev` (tenant `acme`).
- UI shadcn/ui (D-009): login com branding do tenant, esqueci/redefinir senha, aceite de convite, shell autenticado com guardas de rota e papel.
- Comandos novos: `npm run smoke:auth`, `npm run seed:dev`, `npm test` (vitest).
- **Verificado:** typecheck, lint, build, migrations do zero e incremental, smoke RLS, smoke auth, 23/23 testes, E2E HTTP (branding por subdomínio, guardas, sessão, cliente barrado em rota admin).

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
