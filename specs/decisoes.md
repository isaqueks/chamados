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

## D-016 — Robustez do pipeline de triagem: lock com heartbeat, espera sem consumir tentativas e redes de segurança contra estado preso (2026-07-16)

**Status:** aceita.
**Contexto:** incidente real — um worker foi morto no meio de uma triagem (no Windows, `concurrently`/`tsx watch` matam o processo sem entregar SIGINT/SIGTERM). O lock por tenant (TTL fixo de 15 min, sem renovação — o comentário da config prometia renovação que não existia) ficou órfão; os retries do job (3 tentativas, backoff exp. 5 s ≈ janela de 105 s) esgotaram matematicamente antes do TTL e o job caiu em `failed` permanente, deixando o chamado preso em `em_triagem` sem qualquer registro — violando a promessa da spec 05 §8 ("o chamado nunca fica preso sem responsável"). Bugs correlatos: TTL fixo menor que o pior caso legítimo (mapa 10 min + triagem 10 min > 15 min → invariante de 1 execução/tenant violável); `ExecucaoIA` do worker morto eterna em `executando`; `Promise.all` sobre o mesmo `EntityManager` transacional (um único cliente pg — warning no pg@8, erro no pg@9).
**Decisão:** (a) **lock com heartbeat**: TTL curto (90 s) renovado a cada 30 s por compare-and-pexpire (Lua); worker morto → lock órfão morre em ≤ 90 s; perda confirmada do lock é logada (`onPerda`). (b) **Lock ocupado não consome tentativa**: o processador lança `lock_tenant_indisponivel` e o registrador da fila reagenda via `moveToDelayed` + `DelayedError` (30–45 s com jitter), com teto de 20 reagendamentos antes de deixar a espera virar falha real (guard-rail). (c) **Compensação de falha final**: quando um job esgota as tentativas do BullMQ com erro que escapou do processador, o handler `failed` cria `ExecucaoIA.falhou` (auditoria) e chama `escalarParaHumano`. (d) **Varredura de manutenção**: `ExecucaoIA` órfã (`na_fila`/`executando` > 30 min) → `falhou` (`execucao_orfa`) + escalonamento; chamado encalhado em `em_triagem` sem execução ativa nem job pendente (> 30 min) → escalonamento (`triagem_nao_executada`). (e) Queries transacionais sequenciais (fim do `Promise.all` sobre o mesmo cliente pg). (f) Aviso no boot quando outra instância do worker está ativa (heartbeat de presença no Redis); handlers `uncaughtException`/`unhandledRejection` como defesa secundária.
**Consequências:** a classe inteira do incidente é neutralizada sem depender de shutdown limpo (requisito no Windows). `escalarParaHumano` aceita `execucaoId` nulo (escalonamento sem execução associada). Novas envs: `TRIAGEM_LOCK_RENOVACAO_MS`, `MANUTENCAO_EXECUCAO_ORFA_MS`, `MANUTENCAO_TRIAGEM_ENCALHADA_MS`; default de `TRIAGEM_LOCK_TTL_MS` 900000 → 90000.

## D-017 — Intake IA-first: natureza `duvida` respondida pela IA, natureza decidida pela IA e triagem contínua (2026-07-16)

**Status:** aceita.
**Contexto:** lote de melhorias pedidas pelo usuário (tarefas #11–#13): (1) uma classe de chamado é só uma PERGUNTA sobre o sistema — hoje cai no fluxo de problema e espera um humano à toa; (2) o cliente frequentemente escolhe a natureza errada (a IA já valida/reclassifica) — pedir isso na abertura é atrito sem valor; (3) a triagem deve disparar automaticamente na abertura e em toda mensagem do cliente.
**Decisão:** (a) **Natureza `duvida`** (migration 0009, `ALTER TYPE natureza ADD VALUE`): a IA investiga e responde a dúvida sozinha via `respostaAoCliente`; com resposta real publicada (não rebaixada pelo validador D-015), o chamado vai de `em_triagem` direto a `resolvido` — **exceção única e deliberada ao guardrail "agente_ia nunca resolve"** (nova aresta `em_triagem → resolvido` na máquina de estados), segura porque numa dúvida nada muda no sistema (o guardrail de produção — nunca merge/deploy — continua intacto); sem resposta utilizável, escala a humano; dúvida nunca gera SPEC nem PR. (b) **Natureza escondida na abertura do portal** (tarefa #13): o cliente não escolhe natureza; o chamado abre com default do servidor e a IA classifica (`naturezaAjustada`). (c) **Triagem contínua** (tarefa #11): enfileiramento automático na criação e em toda mensagem pública do cliente em estado não terminal.
**Consequências:** specs 02 (enum), 04 (§1.3 máquina/guardrail) e 05 (§5.5) atualizadas; rótulo "Dúvida" na UI; o item (b) e o item (c) são implementados nas tarefas #13 e #11 respectivamente, referenciando este ADR.

## D-020 — Instruções do tenant para a IA (system prompt do admin) (2026-07-16)

**Status:** aceita.
**Contexto:** o usuário pediu que o administrador possa incluir um "system prompt" para a IA — orientações próprias da empresa (tom, contexto do negócio, prioridades, vocabulário) que hoje não têm onde viver: o system prompt da triagem é fixo da plataforma.
**Decisão:** coluna `tenant.ia_instrucoes` (text NULL, migration 0010; cap de 4.000 chars imposto no config-service e refletido na UI via `LIMITE_IA_INSTRUCOES_CHARS` de @chamados/shared). O admin edita em `/app/config` (card "Assistente IA"). O contrato `AIProvider` ganha `contexto.instrucoesTenant` (specs/01 §4.1) e o worker o preenche do tenant já carregado no `montarInput`. No `ClaudeAgentProvider`, as instruções entram no SYSTEM PROMPT da triagem numa seção demarcada AO FINAL, com precedência explícita: **as regras da plataforma prevalecem** — o texto é semi-confiável (admin autenticado, não o cliente); personaliza, nunca relaxa guardrails (separação técnico/cliente, formato JSON, nunca merge/deploy, defesa de injection). Não se aplica ao mapeamento (D-013), que é neutro por design.
**Consequências:** specs 01 (§4.1), 02 (tabela Tenant), 05 (§4.1) e 07 (§4.1) atualizadas; teste do provider prova inclusão, posição (após as regras) e ausência da seção quando vazio; vale a partir da PRÓXIMA triagem de cada chamado (o prompt é montado por execução).

## D-023 — Resolução automática também para alteração simples (2026-07-17)

**Status:** aceita.
**Contexto:** caso real em produção — chamado "Alterar disparos" (trocar um texto), classificado `alteracao` + `facil`, tenant habilitado, repo configurado: nenhum PR. Os gates (specs/05 §6) restringiam a resolução automática a `natureza = problema`; a diretriz do usuário sempre foi "qualquer tipo de mudança no código, desde que `facil`" — o limitador é a complexidade, não a natureza.
**Decisão:** as naturezas elegíveis nos DOIS gates (pré e pós-call) passam a ser `problema` e `alteracao` (`NATUREZAS_RESOLVIVEIS`); `duvida` segue fora (nada a mudar no sistema). O prompt orienta o modelo: alteração só é implementável quando pontual e inequívoca (texto/rótulo/valor) — regra de negócio, fluxo ou ambiguidade não é `facil`. A SPEC continua sendo gerada; a mensagem pública de PR-em-revisão (D-022) vira texto neutro ("proposta de mudança"). Todos os demais guardrails intactos: complexidade `facil`, confiança ≥ limiar, tenant habilitado, PR com aprovação humana, nunca merge/deploy.
**Consequências:** specs/05 §6 atualizada (título "problema/alteração + fácil"); testes dos gates invertidos para alteracao (+ caso `duvida` negado); alterações fáceis de texto passam a virar PR automaticamente.

## D-022 — Correção da IA é proposta em revisão, nunca "resolvido" ao cliente (2026-07-17)

**Status:** aceita.
**Contexto:** o usuário observou a IA alterando código e anunciando ao cliente que o problema estava "resolvido". Falso duas vezes: (a) a tentativa da IA é sempre um PR que exige aprovação humana + deploy manual (guardrail D-006/specs/09 §4) — nada muda em produção na hora; (b) quando a complexidade não é `facil`, o gate PÓS-call nem sequer cria o PR e a alteração é descartada — o "resolvido" anunciado não corresponde a NADA. Os gates (specs/05 §6) já condicionavam o PR a `complexidade = facil`; faltava governar a COMUNICAÇÃO.
**Decisão:** três camadas: (1) **prompt** — o system prompt condiciona explicitamente a escrita de código a `complexidade = facil` autoavaliada, explica que a alteração é PROPOSTA em revisão humana e proíbe anunciar "resolvido/corrigido/aplicado" ao cliente (exceção: `duvida` respondida, D-017); (2) **validador determinístico** (`detectarPromessaResolucao` em `@chamados/shared`) — nos fluxos `problema`/`alteracao`, resposta pública que AFIRMA correção concluída ("resolvi", "foi corrigido", "voltou a funcionar") é REBAIXADA para o fallback genérico, com o original preservado na nota interna (mesma mecânica do rebaixamento técnico D-015); (3) **mensagem pública do pipeline** — quando o PR/push é criado com sucesso, o worker publica mensagem FIXA (`MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO`) informando que a correção proposta está em revisão pela equipe — único canal que fala da correção ao cliente, sem jargão e sem prometer prazo.
**Consequências:** specs/05 (§5.4, §6) atualizada; o cliente passa a ser informado do avanço real (antes o desfecho do PR era 100% interno); a promessa falsa vira caso auditável na nota interna; nenhuma mudança nos gates (já corretos).

## D-021 — Consulta de logs via SFTP para a IA (2026-07-16)

**Status:** aceita.
**Contexto:** o usuário pediu que a IA consiga consultar logs em servidores remotos via SFTP, com diretório e conexão configuráveis. A ferramenta `logs_consultar` (specs/05 §4.2) já era adapter-based (`logs_tipo` texto + `logs_config` jsonb + `logs_credencial_ref` no cofre), mas só implementava o tipo `arquivo` (local do worker) e a UI nem expunha os campos de configuração.
**Decisão:** novo adapter **`sftp`** no worker (dependência `ssh2-sftp-client`, import dinâmico): conecta com `logs_config.{host, porta (22), usuario}` e credencial do COFRE — interpretada como **senha** ou, se começar com `-----BEGIN`, **chave privada PEM**; lê o diretório/glob remoto (`logs_config.caminho`), mais recentes primeiro, com os MESMOS limites do tipo arquivo (tail por offset ≤ `IA_LOGS_MAX_BYTES`, ≤ `IA_LOGS_MAX_ARQUIVOS`, ≤ `IA_LOGS_MAX_LINHAS`) + timeout de conexão (`IA_LOGS_SFTP_TIMEOUT_MS`, 8s). O caminho/host são FIXADOS pelo admin — o modelo continua controlando apenas filtro/limite (menor privilégio, specs/09). UI de sistemas-alvo: fonte de logs vira SELECT (`sem fonte`/`arquivo`/`sftp`) com campos condicionais (host/porta/usuário/diretório) — antes nem o `caminho` do tipo arquivo era configurável pela UI. Sem migration (colunas já existiam). Testes com cliente SFTP fake injetado (`FabricaSftp`).
**Consequências:** specs 05 (§4.2) e 07 (§5.1) atualizadas; worker ganha `ssh2-sftp-client`; tipos não suportados seguem retornando erro claro à IA; a superfície `ClienteSftp` mantém o adapter testável sem rede.

## D-019 — Paleta padrão com cor: azul-petróleo sobre neutros frios (2026-07-16)

**Status:** aceita — complementa D-009/D-018 (não os substitui).
**Contexto:** o usuário avaliou que o sistema, todo em preto e branco (chroma 0 em TODOS os tokens do tema, inclusive `--chart-1..5`), ficava "morto". Agravante estrutural: `--background` e `--card` eram ambos branco puro — nenhuma camada de superfície. Os badges de domínio (status/prioridade/complexidade) já tinham cor; o problema era o tema base.
**Decisão:** paleta padrão do produto no `globals.css` (spec 08 §2.3.1): (a) primário **azul-petróleo** (claro `oklch(0.46 0.09 215)`, escuro `oklch(0.76 0.09 210)` com foreground invertido) — matiz que não colide com as cores de status do domínio e serve de identidade default do whitelabel; (b) **neutros frios** (chroma ≤ 0.02) em fundo/muted/bordas/sidebar — nunca cinza puro, discretos o bastante para conviver com qualquer marca de tenant; (c) **camadas de superfície** (`--background` ≠ `--card` nos dois temas); (d) `--chart-1..5` vira paleta categórica real (petróleo/indigo/âmbar/esmeralda/vermelho); (e) KPIs do dashboard ganham ponto de cor na linguagem dos badges de status (`PontoStatus` exportado do módulo único de badges). Todos os pares texto/fundo validados numericamente ≥ AA (maioria ≥ 6:1). O mecanismo whitelabel fica intacto: o branding do tenant continua sobrescrevendo `--primary`/`--marca-acento`, e os efeitos D-018 derivam de `var(--primary)` via `color-mix()` — recolorem sozinhos.
**Consequências:** spec 08 (§2.3.1, §7) atualizada; "fallback neutro" nos comentários de `branding.ts`/`BrandingVars` vira "paleta padrão"; nenhum componente `ui/*` alterado (tudo via tokens); tenants sem branding passam a ver a identidade petróleo em vez de preto e branco.
**Refinamento v2 (mesma data, após revisão visual com Playwright):** a v1 ficou tímida — as três zonas do shell (sidebar/topbar/conteúdo) tinham quase a mesma cor e a UI "flutuava num mar branco". Ajustes: (a) **sidebar ESCURA azul-petróleo nos dois temas** (âncora de identidade; sheet mobile idem) — o item ativo e o chip da marca derivam de `var(--primary)` **clareado** via `color-mix(..., white 45%)`, garantindo contraste sobre o fundo escuro mesmo com marca de tenant escura; a sidebar/sheet preferem a variante **dark** do logo (fallback light); (b) fundo do conteúdo com tinta mais presente (`oklch(0.964 0.008 230)`); (c) login com véu radial derivado de `--primary` (recolore com o branding); (d) empty states do dashboard compactados (linha única em vez de caixas altas); (e) inputs de config/convite com `max-w` (domínio, webhook, e-mail) — campos de 800px não fazem sentido.

## D-018 — Linguagem visual v2: controles "levemente 3D" com inspiração Cloudflare (2026-07-16)

**Status:** aceita — refina D-009 (não o substitui).
**Contexto:** o usuário avaliou a UI como "primitiva, crua, quadrada" e pediu aparência de sistema moderno A+, com inspiração leve na UI da Cloudflare (botões e inputs levemente em 3D). Na investigação, um bug agravava tudo: `--font-sans: var(--font-sans)` (auto-referência circular no `globals.css`) fazia o app INTEIRO renderizar com a fonte serifada default do navegador — a Geist carregada via `next/font` nunca era aplicada.
**Decisão:** (a) corrigir o mapeamento da fonte (`--font-sans: var(--font-geist-sans)`); (b) linguagem visual v2 centralizada em TOKENS no `globals.css` (sombras `--shadow-*`, gradientes `--grad-*`, realces `--realce-*`, `--radius` 0.7rem): botões/inputs com gradiente vertical sutil, borda um tom mais escura, realce interno no topo, hover elevando e pressed afundando; cards/superfícies flutuantes/tabelas/sidebar/timeline refinados. Componentes `ui/*` só referenciam tokens (nada ad-hoc). Todo efeito do primário deriva de `var(--primary)` via `color-mix()` — whitelabel por tenant recolore tudo; realces têm override no `.dark`.
**Consequências:** spec 08 §2.3 documenta a linguagem; contraste AA e foco acessível preservados (sombras compõem com o ring); nenhuma dependência nova; 17 arquivos de apresentação alterados (tokens + ui/* + shell + páginas-chave), zero mudança de lógica.

## D-024 — Silenciar a IA por chamado (operador/admin) (2026-07-22)

**Status:** aceita.
**Contexto:** incidente em produção (chamado #8 do tenant piloto): após a resposta da cliente, a triagem devolveu uma mensagem-template fora de contexto ("detalhe o passo a passo para reproduzir" numa alteração já entendida). A equipe não tinha como impedir novas intervenções automáticas naquele chamado — só orientar via nota interna, que depende de a IA obedecer.
**Decisão:** flag `chamado.ia_silenciada` (boolean, default false), controlada por **operador/admin** (nunca pela `agente_ia`, nunca pelo cliente — ação `silenciar_ia` na matriz de autorização). Silenciada: **nenhuma** triagem roda no chamado — o worker descarta qualquer job (automático ou já enfileirado) no início da Tx1, e o reprocessamento manual é recusado na action. Reativação manual (mesmos papéis) volta ao comportamento normal nos próximos gatilhos, sem reanálise retroativa. Auditoria via eventos internos `ia_silenciada`/`ia_reativada` (o cliente não vê nem a flag nem os eventos — allowlist do serializer).
**Consequências:** migration 0011 (coluna + valores no enum `tipo_evento`); specs 02 e 05 §2 atualizadas; painel "Assistente IA" ganha aviso + botão "Silenciar IA"/"Reativar IA" (o "Reexecutar triagem" some enquanto silenciada). O silêncio é por chamado — desligar a IA do tenant inteiro continua sendo outra conversa (não coberta aqui).

## D-025 — Confiança da análise é categórica (baixa/média/alta), nunca número (2026-07-22)

**Status:** aceita — supersede o `LIMIAR_TENANT` numérico de specs/05 §5.1.
**Contexto:** o contrato pedia ao modelo `confianca: 0..1` e a nota interna exibia "Confiança da análise: 0.78". Avaliação do usuário: o número é um chute da LLM com precisão ilusória — duas casas decimais fingem uma exatidão que não existe, e comparar `0.78 >= 0.7` no gate é aritmética sobre ruído.
**Decisão:** `confianca` vira o enum canônico `ConfiancaAnalise` (`baixa`/`media`/`alta`) em todo o contrato (`AIProviderResult`, prompt, nota interna, eventos). Critério dado ao modelo: `alta` só com conclusão ancorada em evidência concreta (código/logs/BD); `media` = plausível com lacunas; `baixa` = mais hipótese que evidência. O gate de resolução automática compara categorias (`baixa < media < alta`; `IA_RESOLUCAO_CONFIANCA_MIN`, default **`alta`** — mais exigente que o antigo 0.7, apropriado para escrever código). Normalização defensiva no provider: número legado 0..1 → faixa (≥0.75 alta, ≥0.4 media, senão baixa); valor desconhecido → `baixa` (fail-closed: confiança ilegível nunca habilita resolução automática).
**Consequências:** specs 01 §4.1 e 05 (§5.1, §6) atualizadas; `ExecucaoIA.resultado` antigos guardam números (jsonb, sem migração — só leitura histórica); env `IA_RESOLUCAO_CONFIANCA_MIN` aceita categoria ou o número legado.

## D-026 — Artefatos entregáveis gerados pela IA (relatório PDF/CSV anexado à resposta) (2026-07-22)

**Status:** aceita.
**Contexto:** um chamado pode pedir um MATERIAL pronto, não uma mudança no sistema — ex.: "quero um relatório dos números do mês". A IA já sabia levantar os dados (`bd_consultar`/`logs_consultar`/código), mas só podia respondê-los como texto de chat; não havia como entregar um arquivo. Pedido do usuário na mesma leva: garantir que as respostas saiam com formatação (já existia — markdown → doc rico sanitizado, com tabelas GFM — mas o modelo não sabia).
**Decisão:** nova ferramenta MCP `artefato_gerar` (`nome_arquivo`, `formato: pdf|csv|md|txt`, `conteudo`, `titulo?`), sempre disponível na triagem. Divisão de responsabilidade: o provider entrega só CONTEÚDO textual; o worker materializa (PDF renderizado localmente do markdown com o lexer do marked + pdfkit — sem HTML intermediário nem browser headless; CSV com BOM UTF-8), sanitiza o nome (extensão forçada ao formato) e valida o buffer com a MESMA allowlist do upload de usuário (`detectarTipo`) — falha volta como erro da ferramenta ao modelo (corrigível), nunca estoura a aplicação em Tx2. O aplicador anexa os artefatos à mensagem pública de `respostaAoCliente` (mesma entidade `Anexo`, storage, autorização e download de sempre — nenhum canal paralelo, zero migration); sem resposta pública, caem na nota interna de diagnóstico; resposta rebaixada mantém os anexos (o rebaixamento é do texto); `compreendido=false` descarta com log. Tetos: `IA_ARTEFATOS_MAX` (5) e `IA_ARTEFATO_MAX_CHARS` (500k); nome repetido substitui. O system prompt também passa a anunciar a formatação markdown das mensagens e as regras de uso do artefato (só quando o cliente pediu; conteúdo em linguagem do cliente; sempre com `respostaAoCliente` mencionando o anexo).
**Consequências:** specs 01 §4.1 (contrato `artefato_gerar`) e 05 (§4.2 tabela, §5.4, novo §5.6) atualizadas; worker ganha deps `pdfkit`/`marked`; testes de sanitização/limites/validação/PDF real + prompt. Fica de fora (conversa futura): artefatos em formatos binários ricos (xlsx/docx) e geração fora da triagem (ex.: relatório agendado).
