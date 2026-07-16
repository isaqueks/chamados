# Changelog

> Registro de todas as alterações do projeto (política D-008 em `specs/decisoes.md`): toda mudança de comportamento, spec ou decisão entra aqui, da mais recente para a mais antiga.

## 2026-07-16 — Infra: causa-raiz do blackhole host→Postgres (portproxy órfão + wslrelay) e workaround sem admin

- **Sintoma:** conexões do host aos containers (Postgres, depois tudo) caíam com `ECONNRESET` — TCP conectava, mas era resetado antes do handshake; log do Postgres vazio; reiniciar Docker Desktop não resolvia.
- **Causa-raiz (duas camadas):** (1) um **portproxy órfão do `netsh`** (`0.0.0.0:5432 → IP antigo de WSL`, processo `iphlpsvc`) capturava a porta 5432 antes do proxy do Docker; (2) **`wslrelay`** escutando em `[::1]` (serviços dentro da distro WSL) capturava `localhost`, que resolve primeiro para IPv6.
- **Workaround sem privilégio de admin** (remover o portproxy exige elevação): `*_HOST=127.0.0.1` (nunca `localhost`) e `POSTGRES_PORT=55432` no `.env` — o `docker-compose` publica e a aplicação conecta pela mesma variável. Validado: smoke:rls/pipeline/resolucao verdes.
- **Recorrência documentada:** recriar o `.env` a partir do `.env.example` reverteu a porta para 5432 e derrubou o sistema de novo (`ECONNRESET` no web). Avisos adicionados no `.env.example` (Postgres/Redis/MinIO com `127.0.0.1` e nota da porta) e novo item de troubleshooting no `docs/desenvolvimento.md` §6 com diagnóstico (`netstat -ano | findstr :5432`).

## 2026-07-16 — D-015: notas internas no contexto da IA + resposta pública sem detalhes técnicos

- **Timeline completa no contexto**: a IA agora vê mensagens públicas E notas internas, demarcadas ("conversa com o cliente" vs "notas internas da equipe — NUNCA visíveis ao cliente") — continuidade com a própria análise anterior e canal operador→IA (permissão já prevista na matriz).
- **`respostaAoCliente`**: novo canal público opcional em qualquer fluxo — a IA confirma entendimento/dá posição ao cliente em linguagem simples, publicado como mensagem pública do `agente_ia` (evento + notificação), antes da nota interna (sequenciamento determinístico de `created_at` na mesma transação).
- **Separação técnica/pública garantida em duas camadas**: regra no prompt + validador conservador (`detectarConteudoTecnico`: blocos de código, caminhos, arquivos, chamadas de função, SQL, stack traces) que rebaixa resposta pública técnica para fallback genérico, preservando o original na nota interna com aviso.
- **Validado ao vivo** (Opus 4.8, US$ 0,14): orientação interna do operador usada na investigação; resposta pública limpa ("Entendi o problema... nossa equipe está providenciando") + diagnóstico interno citando `src/relatorio.js` linhas 8-11; segunda execução continuou a análise anterior. 182/182 testes.
- Specs 01/05 sincronizadas (MensagemTimeline com visibilidade, respostaAoCliente, validador); ADR D-015.
- Ambiente: port-forward do Docker Desktop em blackhole no fim da rodada (host→Postgres) — smokes com banco deferidos; ver correção na sequência.

## 2026-07-16 — D-014: descrição do chamado no contexto (bug do M6) + exploração nível Claude Code

- **Bug crítico corrigido:** o contexto enviado à IA continha título + timeline, mas **não a descrição do chamado** — desde o M6 (comprovado no banco: descrição de 287 chars, `entrada` sem ela). A IA respondia "chamado sem especificação" a pedidos claros. Agora o contexto leva descrição completa (texto plano), prioridade e solicitante; o campo `entrada` da ExecucaoIA espelha fielmente o que foi enviado (auditável); FakeProvider lê marcadores também na descrição.
- **Exploração nativa (a pedido do usuário: "como o Claude Code")**: o provider real habilita as ferramentas nativas do Agent SDK `Read`, `Grep` e `Glob` (as mesmas do Claude Code) com `cwd` no checkout e `canUseTool` como fronteira única — nega qualquer caminho fora do checkout (`..`, absolutos, glob com base externa), audita permitidas e negadas em `acoes`, e mantém Bash/Write/Edit/Web*/Task desabilitadas; `permissionMode` voltou a `default` (o gate é o `canUseTool`); handles MCP seguem para logs/BD/escrita-gated; `repo_*` caseiros viram fallback do fake. Descoberta documentada: entradas em `allowedTools` auto-aprovam ANTES do `canUseTool`.
- `IA_MAX_TURNOS` default 20 → 50 (decisão do usuário: sem economia de tokens na triagem).
- **Validado ao vivo** (Opus 4.8, ~US$ 0,53): triagem com descrição presente reagiu ao pedido específico citando arquivo/linhas (`src/regua-cobranca.js:4-6`) e gerou SPEC; nativas usadas (Read×4, Glob); `Read ../../../../etc/passwd` NEGADO. 163/163 testes (incl. 7 de segurança do canUseTool). Smokes de fila e build web deferidos por ambiente compartilhado com o dev ativo do usuário (typecheck da web passou; smokes pipeline/resolucao/conhecimento ✓).
- Specs 01 (contrato com `descricao`/`solicitante`/`exploracao`) e 05 (contexto, ferramentas nativas, protocolo) atualizadas; ADR D-014.

## 2026-07-16 — D-013: mapa de conhecimento do sistema + investigação obrigatória + fiação real das tools

- **Causa-raiz do "IA não investiga" (produção):** as ferramentas MCP eram registradas mas **não permitidas** — o modo headless do Agent SDK (`permissionMode: 'default'`) nega silenciosamente toda chamada de tool sem handler interativo; o modelo respondia sem tocar no código (0 ações auditadas). Correção: tools em `allowedTools` (prefixo `mcp__triagem__*`) + `bypassPermissions`, com **menor privilégio por construção**: `tools: []` desliga TODAS as built-in do SDK (sem Bash/Read/Web — só os handles escopados do worker) e `settingSources: []` isola do host. Os testes unitários mockavam a fronteira e não pegavam — a fiação agora é validada ao vivo.
- **Telemetria corrigida:** `tokens_entrada` somava só o último turno (6 tokens!); agora soma o uso cumulativo (incluindo cache) de todos os turnos.
- **Mapa de conhecimento por sistema-alvo** (migration 0008): execução dedicada (gatilho `mapeamento`, fila `mapeamento-ia`) explora o repo e persiste resumo estruturado + commit em `sistema_alvo`; disparo na primeira triagem, quando o commit muda, ou pelo botão "Mapear agora" (card no cadastro do sistema com preview). `execucao_ia` agora pertence a um chamado XOR sistema-alvo (CHECK; `chamado_id` nullable, `sistema_alvo_id` novo). Resumo injetado em toda triagem. Envs `IA_MAPA_*`.
- **Protocolo investigação-primeiro** no prompt: buscar/ler o código antes de decidir; perguntas ao cliente restritas a fatos do lado dele (nunca o que o código responde); diagnóstico cita evidências (arquivos/trechos). Nova ferramenta `repo_arvore`.
- **Validado AO VIVO** (Opus 4.8 real, custo total US$ 0,24): mapeamento com 4 ações citando a regra de negócio do fixture; triagem com 4 ações (busca + leitura) e diagnóstico citando arquivo/linhas; perguntas só sobre fatos do cliente. 154/154 testes; smokes completos incluindo `smoke:conhecimento` (única exceção: `smoke:triagem` competiu com o worker ativo do usuário na fila compartilhada — ambiental, não regressão).
- Specs 05 (§3.3 mapeamento, §5.1 protocolo) e 02 (colunas de conhecimento, XOR de `execucao_ia`) atualizadas; ADR D-013.

## 2026-07-16 — Correção: cache de repositório com autocura + log sanitizado do git sync

- **Bug real de produção:** ao trocar a URL/caminho do repositório de um SistemaAlvo existente, o cache do worker mantinha o clone antigo; `set-url` + `pull --ff-only` entre históricos não relacionados falhava com "Not possible to fast-forward" — e o erro era engolido como `git_sync_falhou` genérico (chamado escalado a humano em loop).
- **Correção:** o cache é descartável — quando fetch/pull falha (URL trocada, branch reescrita, cache corrompido), o worker apaga o diretório e re-clona do zero (autocura), preservando a garantia de nunca analisar código velho (spec 05 §8).
- **Diagnóstico:** o motivo real do git agora é registrado no log do worker com redação de segredos (credencial → `***`, URL autenticada → `<origem>`); o chamado/ExecucaoIA seguem recebendo só o código genérico.
- **Verificado:** reprodução real contra o cache sujo (invalidação detectada + re-clone do repositório correto), 148 testes, smokes pipeline/resolucao.

## 2026-07-16 — Correção: worker também não carregava o `.env` da raiz

- Mesmo bug da correção anterior, no processo do worker: `npm run dev:worker` roda com cwd em `apps/worker` e nenhum `.env` era carregado — defaults (redis localhost, provider fake) mascararam até a primeira triagem real precisar do SecretStore (`SECRET_STORE_MASTER_KEY não configurada` em loop de retry).
- Correção: `apps/worker/src/env.ts` carrega o `.env` da raiz como **primeiro import** do entrypoint (as configs leem `process.env` no momento do import), sem sobrescrever o ambiente. Verificado: entrypoint enxerga `SECRET_STORE_MASTER_KEY`, flag de repo local, `IA_PROVIDER` e token. 148 testes.

## 2026-07-16 — Correção: web app não carregava o `.env` da raiz do monorepo

- **Bug:** o Next.js só lê `apps/web/.env*` — variáveis compartilhadas definidas no `.env` da raiz (`SISTEMAS_PERMITIR_REPO_LOCAL`, `SECRET_STORE_MASTER_KEY`, `NOTIFICACOES_*` etc.) nunca chegavam ao processo do web app (worker e scripts sempre carregaram a raiz explicitamente, por isso os testes passavam). Sintoma relatado: flag setada no `.env` e o formulário de sistemas seguia recusando repositório local.
- **Correção:** `apps/web/next.config.ts` agora carrega o `.env` da raiz na inicialização, sem sobrescrever variáveis já presentes no ambiente ou em `.env` local do app.
- **Verificado em runtime:** servidor de produção na porta 3005 com sessão real de admin — o hint de repositório local renderizou com a flag ativa. Lembrete operacional: mudanças no `.env` exigem reiniciar o dev server.

## 2026-07-16 — Repositório local no SistemaAlvo (D-011) + autenticação por assinatura na IA (D-012)

- **Repositório local (D-011):** o campo de repositório do SistemaAlvo aceita caminho absoluto (`C:\...`, `/...`) ou `file://` quando `SISTEMAS_PERMITIR_REPO_LOCAL=true` (default `false` — risco em SaaS multi-tenant, ver spec 09 §7). Credencial git dispensável para repo local (ignorada/limpa); worker clona/faz `pull --ff-only` de origem local sem credencial; hint no formulário quando a flag está ativa; validação com mensagem clara quando desligada. Normalização `file:///C:/...` no Windows.
- **Autenticação da IA (D-012):** `ClaudeAgentProvider` aceita `ANTHROPIC_API_KEY` (recomendado para produção/produto — a doc oficial do Agent SDK exige API key para produtos, salvo aprovação prévia) **ou** `CLAUDE_CODE_OAUTH_TOKEN` (token de assinatura via `claude setup-token`, ~1 ano, headless); API key tem precedência; erro acionável na inicialização quando `IA_PROVIDER=claude` sem nenhuma das duas.
- **Correção de bug latente:** `options.env` do Agent SDK substitui o ambiente inteiro do subprocesso — o provider passava só `ANTHROPIC_API_KEY` (perderia `PATH` etc. na primeira execução real); agora mescla `process.env` + credenciais.
- Specs 05 (§10.1 autenticação), 07 (§5.1 repo local) e 09 (§7 risco) atualizadas; ADRs D-011/D-012; `.env.example` e guia de desenvolvimento documentados.
- **Verificado:** format, typecheck, lint, build, 148 testes, smokes sistemas/pipeline/resolucao/triagem/rls/auth.

## 2026-07-15 — Marco M10 (final): busca, auto-fechamento, hardening e polimento — MVP M0–M10 concluído

### Frente A — busca e manutenção

- **Busca full-text** (migration 0007): coluna gerada `busca_tsv` (português, título peso A + descrição peso B, notas internas fora do índice) + GIN; fila com `websearch_to_tsquery` e ordenação por relevância (cursor keyset rank-aware), fallback ILIKE para termos curtos; busca também no portal.
- **Auto-fechamento**: job repetível de manutenção (5 min, lock Redis global) varre `resolvido` vencidos por tenant (função SECURITY DEFINER `chamados_tenants_ativos()`) e fecha com evento `chamado_fechado_auto` + notificações; reabertura confirmada completa (limpa prazo, incrementa contador, notifica operador). Recurso `config_tenant` dedicado na matriz. `npm run smoke:manutencao`.

### Frente B — hardening de segurança

- **Rate limiting** (Redis, fail-open com timeout-guard) em login/esqueci/redefinir/aceite; **headers de segurança + CSP pragmática** (frame-ancestors none, nosniff, DENY; caminho para nonce documentado); **anti-SSRF no webhook** (bloqueio de loopback/privadas/metadata/ofuscados, sem redirects, flag de dev) no salvamento e no envio; downloads de anexo com `Content-Type` pinado e `Content-Disposition` seguro via URL assinada (TTL 120s); **token de reset/convite não é mais logado em produção** (achado corrigido); rotação de sessão no login confirmada. `npm run smoke:seguranca`.

### Frente C — polimento de UI (D-009)

- Tabs Contexto/Timeline/Assistente no detalhe mobile (duas colunas no desktop); cor de acento (`cor_secundaria`) vinculada a elementos reais com fallback seguro; 404/erro brandados nas duas áreas; título/favicon por tenant; tooltips no editor; `prefers-reduced-motion`; varredura SSR com log limpo e zero vazamento interno ao cliente.

### Fechamento

- **Correção de guard admin-only**: `loading.tsx` do segmento `/app` criava Suspense boundary que degradava o `redirect()` do `exigirPapel(admin)` para soft-redirect HTTP 200 (streaming do Next 16); dashboard movido para route group `(inicio)` → 307 duro restaurado (operador redirecionado nas 4 páginas admin). `/app/config` mantido admin-only.
- CTA "Abrir novo chamado" nos estados terminais do portal (com `?ref=` pré-preenchendo o título); actions de webhook com validação amigável antes de persistir/testar; `notFound()` sob streaming documentado como comportamento do framework (200 + noindex; backlog).
- **Verificação de aceitação do zero:** 4 serviços healthy, 8 migrations, seed, format/typecheck/lint/build (19 rotas), 125 testes, **12 smokes**, E2E dourado completo (triagem fake → diagnóstico interno + e-mails; não-entendeu → pergunta pública; `[[resolver]]` → branch + nota de PR + dashboard; guards 307/200; busca por stemming; headers presentes). Specs sincronizadas (02, 03, 04, 09, 10 — M0–M10 marcados concluídos).

## 2026-07-15 — Marco M8: resolução automática via PR (RF-15)

- **Gate duplo no pipeline** (nunca no provider): pré-call (tenant habilitado + natureza problema + repo configurado → injeta ferramentas de escrita) e pós-call (complexidade fácil + compreendido + confiança ≥ `IA_RESOLUCAO_CONFIANCA_MIN` → worker cria branch/PR). O toggle do tenant é honrado de verdade.
- **Ferramentas de escrita** só em working copy **descartável** (clone local do cache → temp, destruída ao fim), com bloqueio de traversal/symlink/`.git` e limites de arquivos/bytes.
- **Branch/push/PR pelo worker**: branch `ia/chamado-N-slug`, commit padronizado referenciando chamado + ExecucaoIA, push com credencial do cofre só na URL (nunca logada nem gravada); GitHub → PR via REST API com token do cofre; outros hosts → push + instruções de PR manual. **A IA nunca faz merge** — aprovação humana sempre.
- Nota interna com resumo/branch/PR + evento `ia_abriu_pr`; falha na tentativa não derruba o diagnóstico (nota de falha + `ia_falhou`, chamado segue em atendimento). Painel: tentativa visível no Assistente IA e bloco real "PRs da IA aguardando revisão" no dashboard.
- `npm run smoke:resolucao` (gate, fluxo completo contra repo bare local, falha de push, cache íntegro sem credencial, invisível ao cliente); **verificado:** typecheck, lint, build, 112 testes, 10 smokes, ciclo real com worker BullMQ consumindo a fila.
- Divergências relatadas para reconciliação de spec: shape de `tentativaResolucao` (provider entrega resumo/arquivos; worker enriquece branch/prUrl) e split da tool `codigo_propor_pr` em ferramentas de escrita + worker (menor privilégio).

## 2026-07-15 — Marcos M7 + M9 (em paralelo) + integração: triagem real da IA e notificações

### M7 — Pipeline de triagem da IA

- **Ferramentas reais escopadas** criadas no worker e injetadas como handles (o provider nunca vê credenciais): repo com cache de working copy por tenant+sistema (`git clone`/`pull --ff-only`, credencial do cofre só na URL do fetch e removida do `.git/config`, busca/leitura read-only com bloqueio de path traversal), logs (`arquivo` com tail/limites), `bd_consultar` (transação READ ONLY, statement_timeout, SELECT/WITH-only com rejeição de DML/DDL antes de executar, LIMIT forçado).
- **Aplicação do resultado ao chamado** (ator `agente_ia`, tudo com `execucao_ia_id`): não entendeu → pergunta pública numerada + `aguardando_cliente` + `ia_pediu_info`; entendeu → nota interna com diagnóstico + complexidade + ajuste de natureza + prioridade (aplicada só se operador não tocou; senão vira sugestão) + `ia_diagnosticou` + `em_atendimento`; alteração → nota interna com a **SPEC completa** (template da spec 05 §7) + `ia_gerou_spec`; falha → escalonamento garantido a humano (`em_atendimento` + `ia_falhou`).
- Criação de chamado transiciona `novo→em_triagem` automaticamente quando o gatilho de triagem está ativo; resposta do cliente em `em_triagem` reenfileira. `npm run smoke:pipeline` com fixtures reais (repo git, logs, database scratch read-only).

### M9 — Notificações (SMTP + webhook)

- Entidades `CanalNotificacao`, `PreferenciaNotificacao`, `NotificacaoLog` (idempotência por chave única) com RLS (migration 0006); defaults no provisionamento.
- **SmtpAdapter** (nodemailer; mailpit no compose para dev) e **WebhookAdapter** (POST JSON assinado HMAC SHA-256 em `X-Chamados-Signature`, timeout curto, payload sem conteúdo interno — D-003); desativação automática do webhook após N falhas consecutivas + alerta aos admins; sucesso zera o contador.
- Tradução `EventoChamado` → notificações pela matriz da spec 06 (destinatários por papel, preferências respeitadas, obrigatórios não desabilitáveis), templates pt-BR com branding e deep link; convite/reset de senha agora passam pelo gateway real (stub removido).
- UI: config de webhook no admin (segredo mascarado via cofre, evento de teste) e preferências do usuário nas duas áreas. `npm run smoke:notificacoes`.

### Integração

- **Despachante composto** (triagem + notificações) em todas as server actions de mutação das duas áreas, com flush pós-commit — fecha o loop UI → job → IA → notificação; mutações aplicadas pela IA no worker também notificam (rollback não notifica; notas internas nunca).
- `pg` formalizado no worker; docs de desenvolvimento atualizados (worker de IA, mailpit, envs, smokes).
- **Verificação integrada do zero:** 4 serviços healthy, 7 migrations, build 22 rotas, 87/87 testes, 9 smokes, e **E2E dourado pela interface**: chamado do cliente → triagem fake → diagnóstico interno + classificação → e-mails no Mailpit ("não entendeu" → pergunta pública + aguardando_cliente); varredura confirmou zero vazamento de conteúdo interno nos e-mails.

## 2026-07-15 — Marco M6: fila de triagem, worker de IA e abstração AIProvider

- **Contrato `AIProvider`** em `packages/shared` (types puros, nomes exatos da spec 01 §4.1) com ferramentas como handles de função tipados e limites (timeout/budget/turnos).
- **Providers no worker**: `ClaudeAgentProvider` (Claude Agent SDK, model default `claude-opus-4-8`, tools MCP, structured output, telemetria real, fronteira do SDK injetável — testado sem rede) e `FakeProvider` determinístico para dev/teste (marcadores `[[nao-entendeu]]`, `[[complexidade:...]]` etc.). Seleção por `IA_PROVIDER` (default fake). Guardrails fora do provider.
- **Entidade `ExecucaoIA`** (migration 0005) com RLS, sem DELETE (append-only), telemetria custo/duração/tokens, FKs pendentes de `mensagem`/`evento_chamado` criadas.
- **Fila `triagem-ia`** (BullMQ, publicador em `packages/db/src/fila/`): jobId determinístico (dedupe), debounce substituível de 45s, retries com backoff, concorrência global baixa + lock Redis por tenant (um tenant não esgota o worker).
- **Despachante de eventos de domínio** evoluído do seam de auditoria (`eventos-dominio.ts`): mutações publicam `triagem_solicitada` best-effort com flush pós-commit — ponto de plug pronto para as notificações (M9).
- **Worker modular** (`filas/registrar()`): processa triagem com contexto mínimo sem credenciais, ferramentas stub (reais no M7), eventos `ia_iniciou`/`ia_falhou`, timeout/budget → `falhou` com `erro` dedicado. Painel: seção "Assistente IA" real (execuções com status/custo/tokens + reexecutar).
- `npm run smoke:triagem` (dedupe, debounce, lock, falhas, RLS, autorização); **verificado:** format, typecheck, lint, build, migrations zero/incremental/revert, 7 smokes, 80/80 testes, worker processando job real.
- Divergência relatada: enum `status_execucao_ia` com 5 valores (spec 05 §8 manda; spec 02 listava 7) — reconciliação da spec 02 em andamento.

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
