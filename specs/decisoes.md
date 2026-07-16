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

**Status:** ~~aceita~~ **substituída por D-010** (better-auth descartado na implementação do M1).
**Decisão:** better-auth em vez de Auth.js/NextAuth, pelo suporte first-class a multi-tenancy e sessões próprias sem dependência de OAuth externo (`03-autenticacao-perfis-permissoes.md`).

## D-008 — Política de documentação contínua (2026-07-15)

**Status:** aceita.
**Decisão:** **toda** alteração no projeto deve deixar rastro: entrada no `CHANGELOG.md` (o que mudou e por quê), atualização da spec afetada (comportamento) e, quando houver decisão nova, registro neste arquivo. Nada muda sem documentação.

## D-009 — Princípios de UI (2026-07-15)

**Status:** aceita.
**Decisão:** a UI deve ser **limpa, bonita, intuitiva, fácil de usar e consistente**. Implementação com shadcn/ui + Tailwind, temas via CSS variables (branding por tenant com validação de contraste AA). Todo componente novo segue o design system — nada de estilos ad-hoc.

## D-010 — Autenticação hand-rolled conforme spec 03; better-auth descartado (2026-07-15)

**Status:** aceita — **substitui D-007**.
**Contexto:** na implementação do M1, o better-auth mostrou-se incompatível com três requisitos canônicos: não tem adapter oficial para TypeORM (apenas Drizzle/Prisma/Kysely/Mongo); seu modelo de identidade é global por e-mail, colidindo com a identidade **por-tenant** (`UNIQUE(tenant_id, email)`, specs 02/03); e sua camada de dados não roda dentro de `runInTenantContext` (RLS).
**Decisão:** implementar diretamente o modelo da spec 03: Argon2id (`@node-rs/argon2`), sessões server-side revogáveis com cookie opaco (apenas `token_hash` no banco), respostas anti-enumeração, invalidação de todas as sessões em troca/reset de senha.
**Consequências:** tabela adicional `redefinicao_senha` (tokens de reset, uso único); função `chamados_resolver_tenant` (SECURITY DEFINER) para resolver o tenant por slug/domínio antes de estabelecer o contexto RLS (a app conecta sem BYPASSRLS); 2FA/SSO permanecem no roadmap da spec 03.

## D-011 — Repositório do SistemaAlvo pode ser diretório local, atrás de flag (2026-07-16)

**Status:** aceita.
**Contexto:** o usuário quer apontar a IA para o código-fonte num diretório local do servidor, sem passar por um git remoto. Em uma instalação SaaS multi-tenant isso seria um risco (um admin de tenant poderia apontar para qualquer repositório git do host), então não pode ser o comportamento padrão.
**Decisão:** a validação de repositório aceita caminho local absoluto (ou `file://`) **somente** quando `SISTEMAS_PERMITIR_REPO_LOCAL=true` (default `false`). Para repositório local, credencial git é dispensável. Em produção com Docker, o diretório precisa estar montado como volume no container do worker.
**Consequências:** instalações self-hosted (caso do usuário) habilitam a flag; a oferta SaaS mantém `false`. Nota de segurança na spec 09.

## D-012 — Autenticação da IA: API key ou token de assinatura, com ressalva de termos (2026-07-16)

**Status:** aceita.
**Contexto:** o usuário quer usar a assinatura Claude dele (a mesma do Claude Code) no worker de IA, em vez de pagar API por token. A documentação oficial do Agent SDK afirma: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" — ou seja, para o produto (especialmente atendendo outros tenants), o caminho conforme é `ANTHROPIC_API_KEY`; o token de assinatura (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) é documentado para CI/scripts próprios.
**Decisão:** o `ClaudeAgentProvider` suporta ambas as variáveis (`ANTHROPIC_API_KEY` tem precedência na cadeia do CLI). O uso do token de assinatura fica a critério e risco do operador da instalação, para uso próprio/dev; a recomendação registrada para produção/multi-tenant é API key. O aviso consta em `.env.example` e no guia de desenvolvimento.
**Consequências:** token de `setup-token` vale ~1 ano e não renova sozinho; por ser variável de ambiente, funciona em serviço headless independente da conta Windows logada.

## D-013 — Conhecimento persistente do sistema + investigação obrigatória na triagem (2026-07-16)

**Status:** aceita.
**Contexto:** na primeira triagem real, a IA respondeu sem chamar nenhuma ferramenta (0 ações auditadas) — perguntou ao cliente coisas que deveria investigar no código. O usuário requer que a IA "tenha total conhecimento do sistema e investigue". Ler o repositório inteiro a cada triagem é proibitivo em custo/latência.
**Decisão:** (a) **mapa de conhecimento por sistema-alvo**: uma execução de IA dedicada (gatilho `mapeamento`) explora o repositório e produz um resumo estruturado (stack, módulos, entidades, regras de negócio, fluxos) persistido no `sistema_alvo` com o commit mapeado; gerado na primeira triagem quando ausente, re-gerado quando o commit do checkout muda, e sob demanda pelo admin ("Mapear agora"). O resumo é injetado em toda triagem. (b) **Protocolo investigação-primeiro** no prompt da triagem: antes de decidir `compreendido=false`, a IA deve buscar os termos do chamado no código e ler os arquivos relevantes; perguntas ao cliente são reservadas a fatos do lado do cliente (passos, tela, usuário, quando começou), nunca ao que o código responde; diagnóstico deve citar evidências (arquivos/trechos).
**Consequências:** primeira triagem de um sistema é mais lenta/cara (mapeamento); as seguintes ficam melhores e mais baratas. A fiação real das ferramentas no ClaudeAgentProvider passa a ser validada ao vivo (a versão só-mock deixou passar a falha de fiação). Telemetria de tokens corrigida.

## D-014 — Exploração de código nível Claude Code + descrição do chamado no contexto (2026-07-16)

**Status:** aceita.
**Contexto:** mesmo com D-013, a triagem real respondeu sem conhecer o pedido: (a) **bug desde o M6** — o contexto enviado ao provider continha título + timeline, mas **não a descrição do chamado** (comprovado: `entrada_tem_descricao=false` com descrição de 287 chars no banco); (b) as ferramentas caseiras de exploração (`repo_buscar` substring, `repo_ler_arquivo` inteiro) são inferiores às do Claude Code, e o usuário determinou: "tem que ler e entender exatamente como o Claude Code faz; não se preocupe em economizar tokens".
**Decisão:** (a) o contexto da triagem passa a incluir a descrição completa do chamado (texto plano), além de natureza/prioridade/solicitante/timeline; (b) o `ClaudeAgentProvider` habilita as ferramentas **nativas do SDK `Read`, `Grep` e `Glob`** (as mesmas do Claude Code) com `cwd` no checkout e `canUseTool` negando qualquer caminho fora dele; `Bash`, `Write`, `Edit`, `Web*` e demais permanecem desligadas; os handles MCP continuam para logs/BD/escrita-gated; (c) limites elevados: `IA_MAX_TURNOS` default 50.
**Consequências:** exploração com a mesma mecânica do Claude Code (grep por regex, leitura paginada, glob), custo maior por triagem aceito pelo usuário; a fronteira de segurança do repo passa a ser o `canUseTool` (validada por teste); ferramentas caseiras de repo viram fallback do provider fake.

## D-015 — Notas internas no contexto da IA + resposta pública sem detalhes técnicos (2026-07-16)

**Status:** aceita.
**Contexto:** (a) o contexto da triagem levava só mensagens públicas — a IA não via o próprio diagnóstico anterior (nota interna) nem orientações internas de operadores, embora o papel `agente_ia` tenha permissão de leitura; (b) quando a IA entende o chamado, ela só publica nota interna — o cliente fica sem resposta; (c) requisito do usuário: mensagens públicas ao cliente final NUNCA devem conter detalhes técnicos (arquivos, código, jargão) — o técnico pertence às notas internas.
**Decisão:** o contexto passa a incluir a timeline completa com visibilidade demarcada ("conversa com o cliente" vs "notas internas da equipe"); `AIProviderResult` ganha `respostaAoCliente` (mensagem pública amigável, opcional) que o aplicador publica como mensagem pública do `agente_ia` — usada para confirmar entendimento, responder dúvidas que a IA pode resolver, ou dar posição, sempre em linguagem simples; o prompt impõe a separação de registros (técnico → nota interna; cliente → simples) e um validador conservador no aplicador rebaixa para genérica qualquer resposta pública com cara de conteúdo técnico (caminhos de arquivo, blocos de código), mantendo o detalhe na nota interna.
**Consequências:** continuidade entre triagens (a IA vê a própria análise anterior), canal operador→IA via nota interna, e cliente sempre recebe retorno adequado ao público dele.
