# Changelog

> Registro de todas as alterações do projeto (política D-008 em `specs/decisoes.md`): toda mudança de comportamento, spec ou decisão entra aqui, da mais recente para a mais antiga.

## 2026-07-17 — D-023: resolução automática também para alteração simples (fácil)

- **Caso real (produção):** chamado "alterar um texto" saiu `alteracao` + `facil` com tenant/repo OK e NÃO gerou PR — os gates limitavam a resolução automática a `natureza = problema`. A diretriz do produto é que o limitador seja a COMPLEXIDADE (`facil`), não a natureza.
- **Mudança (ADR D-023):** gates pré e pós-call aceitam `problema` e `alteracao` (`duvida` segue fora). Prompt orienta: alteração implementável só quando pontual e inequívoca (texto/rótulo/valor); regra de negócio/fluxo/ambiguidade não é `facil`. SPEC continua sendo gerada; mensagem pública de PR-em-revisão virou texto neutro ("proposta de mudança"). Demais guardrails intactos (confiança, tenant, PR com aprovação humana, nunca merge/deploy).
- Spec 05 §6 atualizada; testes dos gates ajustados (+ caso `duvida` negado).

## 2026-07-17 — Prompt: respostas da IA formatadas para chat (parágrafos e listas)

- **Relato do usuário:** respostas da IA continuavam sem quebra de linha. **Investigação em produção provou que o renderizador está correto**: o texto CRU devolvido pelo modelo (gravado na ExecucaoIA) não tinha nenhum `\n` — parágrafo único de centenas de caracteres; onde o cru tem `\n`, o HTML tem `<br>`/`<p>` (fix de 2026-07-16 funcionando).
- **Correção (spec 05 §5.3):** o system prompt agora exige formatação de chat na resposta: parágrafos curtos (1–3 frases) separados por linha em branco, enumerações como lista markdown, nunca bloco único corrido. Mensagens antigas (HTML já gravado) não mudam retroativamente.

## 2026-07-17 — Anti-flood de e-mails: status/prioridade viram opt-in (spec 06 §7)

- **Relato do usuário (com print):** cada chamado gerava 5+ e-mails em minutos — "status Em triagem", "status Em atendimento", "prioridade Média"… A infraestrutura de preferências por evento (usuário × evento × canal, specs/06 §7) já existia e funcionava (páginas em `/portal/preferencias` e no painel; dispatcher consulta); o problema era o DEFAULT "ausência de linha = tudo ligado".
- **Mudança:** default agora vem do CATÁLOGO (`defaultDoEvento`, fonte única para dispatcher, serviço e UI): `mudanca_status` e `mudanca_prioridade` nascem DESLIGADOS (quem quiser, liga na página de preferências); os demais seguem ligados — confirmação de abertura, nova mensagem pública, resolvido, fechado, reaberto, cancelado, atribuição. Obrigatórios continuam invioláveis; teste de coerência garante que nenhum obrigatório nasça desligado.
- Preferências explícitas já salvas não mudam (a linha do usuário sempre vence o default).

## 2026-07-17 — Script `tenant:provisionar` (provisionamento de produção)

- **Novo script `tenant:provisionar`** (packages/db + atalho na raiz): provisionamento de tenant de PRODUÇÃO parametrizado por CLI — tenant + agente_ia + categoria geral + admin humano (senha forte gerada e impressa uma única vez, ou `--admin-senha`), ativação ao final; idempotente. O `seed:dev` continua exclusivo de dev (dados de exemplo, senhas conhecidas). Detalhes operacionais de ambiente (hosts, infra, credenciais) ficam FORA do repositório — vivem na documentação do próprio ambiente.

## 2026-07-17 — D-022: correção da IA é proposta em revisão, nunca "resolvido" ao cliente

- **Incômodo (relato do usuário):** a IA alterava código e anunciava ao cliente que o problema estava "resolvido" — falso: a alteração vira PR pendente de aprovação humana + deploy manual, e quando a complexidade não é `facil` o gate PÓS-call nem cria o PR (a alteração é descartada). Os gates já estavam corretos (PR só com `facil` + confiança ≥ limiar); faltava governar a comunicação.
- **Três camadas (ADR D-022):** (1) system prompt condiciona a escrita a `complexidade = facil` autoavaliada e proíbe anunciar resolução (a alteração é PROPOSTA em revisão humana); (2) novo validador `detectarPromessaResolucao` (@chamados/shared) rebaixa, nos fluxos problema/alteração, resposta pública que afirma correção concluída ("resolvi", "foi corrigido", "voltou a funcionar") — fallback genérico ao cliente, original preservado na nota interna; (3) quando o PR/push é criado, o pipeline publica mensagem pública FIXA (`MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO`): correção proposta em revisão pela equipe, sem jargão nem promessa de prazo — antes o desfecho do PR era 100% interno e o cliente ficava no escuro.
- Specs 05 (§5.4, §6) + ADR D-022; testes dos padrões do validador (positivos e anti-falso-positivo) e do prompt.

## 2026-07-17 — Prompt: IA não cumprimenta a cada mensagem

- **Incômodo (relato do usuário):** a IA abria TODA resposta com "Olá" — cada triagem é uma execução nova do modelo (ainda que receba a timeline completa, D-015), e nada no prompt vetava a saudação repetida.
- **Correção (spec 05 §5.3):** o bloco CONVERSA CONTÍNUA do system prompt agora manda cumprimentar no máximo na PRIMEIRA interação do chamado; se a timeline já tem mensagem da IA, a resposta entra direto no assunto, como num chat real. +1 asserção no teste do prompt.

## 2026-07-16 — Correção: IA analisava a branch DEFAULT do remoto, não a configurada

- **Bug (achado pelo usuário):** `sincronizarRepo` clonava sem `--branch` → o checkout ficava na branch **default do remoto** (main/master), e `git_branch_padrao` só era usado como **base do PR** (resolucao.ts). Com configurada ≠ default, TUDO que a IA via (Read/Grep/Glob, mapa de conhecimento D-013, working copy da resolução) vinha da branch errada — e o PR abria contra a certa com conteúdo da errada.
- **Correção (spec 05 §3.2):** clone com `--branch <git_branch_padrao> --single-branch`; no cache existente, se a branch do checkout difere da configurada (admin trocou a config, ou cache antigo preso na default), apaga e re-clona (cache descartável, mesmo padrão da autocura). Branch inexistente falha ALTO (`git_sync_falhou`) — nunca cai na default silenciosamente.
- 4 testes de integração com git REAL (origem local com `main` + `des`): clona a configurada, re-clona na troca, reaproveita cache na mesma branch, falha com branch inexistente. Caches criados antes do fix se autocorrigem na próxima triagem.

## 2026-07-16 — D-021: consulta de logs via SFTP + polling do chamado + prompt "é um chat"

- **Logs via SFTP (ADR D-021):** novo adapter `sftp` em `logs_consultar` — a IA lê logs de um servidor remoto do cliente. Configurável por sistema-alvo na UI (fonte de logs virou select com campos condicionais): host, porta (default 22), usuário, **diretório remoto dos logs** (ou glob de 1 nível); credencial no cofre (senha OU chave privada PEM, heurística `-----BEGIN`). Mesmos limites do tipo `arquivo` (tail por offset, tetos de bytes/arquivos/linhas) + `IA_LOGS_SFTP_TIMEOUT_MS` (8s). Caminho/host fixados pelo admin — o modelo só controla filtro/limite. Sem migration (colunas já existiam); a UI também passa a expor o `caminho` do tipo `arquivo` (antes inconfigurável). Dependência `ssh2-sftp-client` (import dinâmico); 4 testes com cliente fake injetado.
- **Short-polling de 1 min no chamado (spec 08 §6):** componente `AtualizacaoPeriodica` nas páginas de detalhe (painel e portal) — `router.refresh()` a cada 60s, pausa com aba oculta, refresh imediato ao voltar o foco; estado do editor preservado. Novas respostas aparecem sozinhas.
- **Prompt: chat contínuo + ambiguidade → perguntar (spec 05 §5.3):** o system prompt da triagem agora diz explicitamente que o chamado é um CHAT (o cliente pode responder; a IA é re-acionada a cada mensagem — D-017) e que solicitação AMBÍGUA, mesmo após investigar, exige PERGUNTAR (`compreendido=false`) em vez de assumir interpretação; tom de conversa, nunca relatório final. +1 teste do prompt.

## 2026-07-16 — Portal do cliente: sidebar no desktop + número do chamado integrado ao título

- **Sidebar no portal** (pedido do usuário; spec 08 §3 atualizada): o portal ganha menu lateral no desktop com Meus chamados / Abrir chamado / Notificações — mesma superfície escura e visual do painel (reusa `Marca` e `LinhaNav` do app-shell, D-009). No mobile a sidebar some e a marca volta ao header (portal segue mobile-first). O detalhe do chamado marca "Meus chamados" como ativo; a sidebar prefere o logo `dark` (fallback `light`).
- **"#6" órfão corrigido**: o número do chamado ficava sozinho numa linha acima do título (detalhe e cards da lista do portal); agora é integrado à linha do título ("#6 Alterações"), como o painel já fazia. Verificado com screenshots via Playwright.

## 2026-07-16 — D-020: instruções do tenant para a IA (system prompt do admin)

- **Novo:** o admin define instruções próprias para a IA em `/app/config` (card "Assistente IA"): tom, contexto do negócio, prioridades, vocabulário. Persistidas em `tenant.ia_instrucoes` (migration 0010; cap 4.000 chars — `LIMITE_IA_INSTRUCOES_CHARS` em @chamados/shared, imposto no config-service e na UI).
- **Fio completo:** contrato `AIProvider` ganha `contexto.instrucoesTenant` (specs/01 §4.1) → worker preenche no `montarInput` → `ClaudeAgentProvider` injeta no SYSTEM PROMPT da triagem em seção demarcada AO FINAL, com precedência explícita das regras da plataforma (semi-confiável: personaliza, nunca relaxa guardrails). Mapeamento (D-013) não usa — é neutro por design.
- Specs 01/02/05/07 atualizadas; ADR D-020; teste do provider cobre inclusão, posição e ausência quando vazio (207/207 verdes).

## 2026-07-16 — Correção: respostas da IA sem quebra de linha (\n não virava `<br>`)

- **Bug:** `markdownParaDoc` usava `marked.lexer(..., { breaks: false })` — um `\n` simples dentro de parágrafo ficava literal no texto e o HTML o colapsava em espaço: as respostas da IA perdiam TODA quebra de linha simples (o conversor até já mapeava tokens `br` → `hardBreak` → `<br>`, mas o lexer nunca os emitia).
- **Correção:** `breaks: true` (GFM "hard breaks", o comportamento de comentários do GitHub e o que se espera de um chat): `\n` simples → `hardBreak` → `<br>`; parágrafos (linha em branco) seguem inalterados. O fallback de texto plano (`textoParaDoc`) já fazia isso — os dois caminhos agora são coerentes. +1 teste (206→207).

## 2026-07-16 — D-019: paleta padrão com cor — azul-petróleo sobre neutros frios

- **Antes:** todos os tokens do tema tinham chroma 0 (preto e branco literal), `--background` = `--card` = branco puro (nenhuma camada de superfície) e `--chart-1..5` eram 5 tons de cinza — o sistema parecia "morto".
- **Paleta padrão do produto (spec 08 §2.3.1, ADR D-019):** primário **azul-petróleo** (claro `oklch(0.46 0.09 215)`, escuro `oklch(0.76 0.09 210)` com foreground invertido); neutros frios (chroma ≤ 0.02) em fundo/muted/bordas/sidebar; camadas de superfície (`--background` ≠ `--card` nos dois temas); charts com paleta categórica real (petróleo/indigo/âmbar/esmeralda/vermelho); gradientes neutros dos controles D-018 tingidos na mesma família.
- **Dashboard:** KPIs com ponto de cor na linguagem dos badges de status (`PontoStatus` exportado do módulo único `chamado/badges.tsx`).
- **Whitelabel intacto:** branding do tenant continua sobrescrevendo `--primary`/`--marca-acento` (com checagem AA); efeitos D-018 derivam de `var(--primary)` e se recolorem sozinhos. Contraste de TODOS os pares texto/fundo da paleta validado numericamente (≥ 4.5:1, maioria ≥ 6:1).
- **v2 (revisão visual com Playwright — login real na UI, screenshots de 9 telas):** sidebar **escura azul-petróleo nos dois temas** (âncora de identidade; sheet mobile idem; item ativo/chip da marca derivam de `--primary` clareado via `color-mix` p/ contraste garantido; sidebar prefere logo `dark` com fallback `light`); fundo do conteúdo com tinta mais presente; login com véu radial de marca; empty states do dashboard em linha única (antes: caixas de py-12 dominavam a tela); inputs longos de config/convite contidos com `max-w`.

## 2026-07-16 — D-018 (tarefa #18): linguagem visual v2 — controles "levemente 3D" (inspiração Cloudflare) + bug da fonte

- **Bug crítico de fonte:** `--font-sans: var(--font-sans)` (auto-referência circular no `globals.css`) — o app INTEIRO renderizava na serifada default do navegador desde o M3; a Geist (next/font) nunca chegou a valer. Corrigido para `var(--font-geist-sans)`. Grande parte do aspecto "cru" vinha daí.
- **Linguagem visual v2 (spec 08 §2.3, ADR D-018):** tokens novos no `globals.css` — sombras de elevação (`--shadow-ctrl*`, `--shadow-campo`, `--shadow-cartao*`, `--shadow-flutuante`), gradientes (`--grad-primario/neutro` + hover) e realces (`--realce-*`, com override no `.dark`); `--radius` 0.625→0.7rem. Botões com gradiente vertical sutil + borda um tom mais escura + realce interno + pressed afundando; inputs/selects/textarea com sombra interna e foco suave; cards com sombra sutil (hover eleva); dialog/sheet/menu/select flutuantes; tabelas com cabeçalho discreto; sidebar com indicador de item ativo; topbar sticky com blur; auth com fundo suave; timeline do chamado com bolhas diferenciadas (cliente/equipe/nota interna âmbar) e marcadores anelados.
- **Whitelabel preservado por construção:** todo efeito do primário deriva de `var(--primary)` via `color-mix()`; sombras/realces são neutros. Componentes `ui/*` só referenciam tokens — um lugar único controla a linguagem (D-009).
- Implementado por subagente Opus 4.8 sob orquestração; 17 arquivos de apresentação, zero lógica. typecheck/lint/prettier verdes + CSS de teste compilado via @tailwindcss/postcss confirmando os utilitários novos (classes Tailwind inválidas não aparecem no typecheck). `npm run build` deferido (dev server ativo compartilha o `.next`).

## 2026-07-16 — Tarefa #19: meta-análise de intenção antes da investigação

- **Caso real:** chamado "Alterações" (novos prazos de financiamento + reordenar etapas — claramente alteração) classificado como Problema, com pergunta genérica de reprodução ("o que aconteceu, passo a passo"). Duas causas: (a) o protocolo do prompt era enviesado para bug (investigar defeito → reproduzir); (b) o fluxo "não entendeu" IGNORAVA `naturezaAjustada` — a classificação só era aplicada quando a IA compreendia tudo.
- **ETAPA 0 — meta-análise da intenção** no prompt (specs/05 §5.1): antes de qualquer ferramenta, decidir O QUE o cliente quer (problema/alteracao/duvida, com sinais típicos de alteração explicitados) e registrar SEMPRE em `naturezaAjustada` (inclusive com `compreendido=false`); o restante da análise segue protocolo específico por natureza — perguntas de reprodução são EXCLUSIVAS de problema; em alteração a investigação mira o ESTADO ATUAL (evidências para a SPEC) e as perguntas só especificam a mudança.
- **Aplicador**: `naturezaAjustada` passa a ser aplicada também no fluxo não-entendeu (evento `natureza_alterada`); FakeProvider honra `[[natureza:...]]` junto com `[[nao-entendeu]]`.
- Alternativa registrada (se o prompt não bastar em produção): execução META dedicada e barata antes da triagem — descartada por ora para não duplicar custo/latência, já que o modelo tem todo o contexto na própria execução.
- Smoke:pipeline +1 cenário (#19); validado AO VIVO com o texto exato do caso real (ver commit). Spec 05 §5.1.

## 2026-07-16 — Tarefa #16: imagem colada na descrição (bug de CSP) + IA lê os prints (multimodal)

- **Bug real ("imagem não aparece"):** o pipeline SEMPRE persistiu a imagem colada (anexo + `/api/anexos/<id>` no HTML — comprovado por reprodução server-side), mas o download é um **302 para a URL pré-assinada do storage** e o CSP `img-src 'self' data: blob:` avalia a URL FINAL do redirect → o browser bloqueava silenciosamente TODA imagem colada (descrição e mensagens). Correção: `img-src` passa a incluir a origem do storage (espelha a resolução de endpoint de `@chamados/storage`: `STORAGE_ENDPOINT` ou `http://MINIO_HOST:MINIO_PORT`). Exige restart do dev server.
- **IA lê os prints (multimodal):** o contexto da triagem ganha `imagens` (contrato em specs/01 §4.1): prints da DESCRIÇÃO e de mensagens PÚBLICAS (nunca notas internas), coletados na Tx1 (metadados) e baixados pós-transação (best-effort; ≤ 8 imagens, ≤ 4 MB cada). O `ClaudeAgentProvider` envia via streaming input do SDK — uma mensagem de usuário `[texto, imagem…]`; o prompt anuncia as imagens como dado não confiável. `ExecucaoIA.entrada` espelha `imagens_contexto`.
- **Validado AO VIVO** (Opus 4.8, US$ 0,14): chamado com um print gerado programaticamente (quadrado vermelho) e a pergunta "qual a cor predominante?" — a IA respondeu **"a cor predominante da imagem é o vermelho"** (e, de quebra, exercitou o fluxo D-017: classificou como dúvida, respondeu público e resolveu sozinha). Smoke:pipeline +1 cenário (`#16`: anexo materializado + fake ecoando a contagem + espelho na entrada); 205/205 testes; typecheck.
- Specs 01 (contrato) e 05 (§4.1) atualizadas; worker ganha dependência `@chamados/storage`.

## 2026-07-16 — Tarefa #15: respostas da IA renderizadas como markdown

- **Antes**: toda saída da IA (respostas, diagnósticos, SPECs) entrava como texto plano — o cliente/operador via `# SPEC`, `**negrito**` e `- [ ]` crus.
- **Conversor `markdownParaDoc`** (packages/db, usa o LEXER do `marked` — nunca o renderer): mapeia markdown para os MESMOS nós da allowlist do pipeline de rich text, que continua sendo a fronteira (validação + sanitização + render HTML). Cobre headings (clamp 1–3), listas (incl. tarefas GFM como texto `[ ]`/`[x]`), código bloco/inline, blockquote, tabelas, hr, links (href revalidado), bold/itálico/strike. **HTML embutido nunca vira nó** (degrada para texto escapado); imagem externa degrada para o texto alternativo. Falha de parse → fallback texto plano.
- **Aplicador**: todas as mensagens autoradas pelo `agente_ia` (perguntas, resposta pública, diagnóstico, SPEC, notas de resolução/falha/escalonamento) passam pelo conversor. Perguntas viram `<ol>`, SPEC vira headings/checklists.
- **Web**: `classesConteudoRico` ganhou estilos de tabela; o restante (headings/listas/código) já era estilizado.
- 12 testes novos do conversor (205/205), asserts do smoke:pipeline atualizados para o HTML renderizado (verde). Spec 05 §3.1 atualizada. Dependência nova `marked` no packages/db.

## 2026-07-16 — D-017 (parte 3, tarefa #11): triagem automática em toda mensagem do cliente

- **Antes**: mensagem pública do cliente só re-disparava a triagem em `aguardando_cliente`/`em_triagem`; em `em_atendimento`/`resolvido` a IA ficava de fora.
- **Agora (specs/05 §2, specs/04 §1.3/§4.2/§8)**: mensagem pública do cliente re-dispara a triagem em QUALQUER estado não terminal — de `aguardando_cliente` → `em_triagem` (sistema, como antes); em `em_atendimento` apenas re-enfileira (status intacto — o operador segue com o chamado e a IA analisa a mensagem nova); em **`resolvido` a mensagem REABRE o chamado** (aresta do autor na máquina; `chamado_reaberto`, prazo de auto-fechamento limpo) e a triagem analisa. Notas internas e mensagens de operador nunca disparam (canal humano→IA é a nota interna, D-015). A criação já enfileirava automaticamente (M7) — inalterada.
- O debounce substituível (45s) segue valendo: rajadas de mensagens colapsam numa única triagem sobre a última.
- Smoke:mensagens +2 cenários (6b em_atendimento sem mudar status + triagem; 6c resolvido reabre + triagem). ADR D-017 (parte 3).

## 2026-07-16 — D-017 (parte 2, tarefa #13): natureza opcional na abertura — a IA identifica

- **Portal do cliente**: o bloco proeminente "Qual é a natureza do chamado?" saiu do formulário; a escolha agora vive em **"Opções avançadas"** como select opcional com default **"Automático — nossa assistente identifica"** (inclui Dúvida). Menos atrito na abertura; o caminho normal é não escolher.
- **Server action**: `natureza` ausente/vazia → default `problema` no servidor; a IA reclassifica na triagem via `naturezaAjustada` (comportamento já existente do aplicador). Painel do operador (abrir em nome de cliente) continua com natureza explícita.
- Specs 04 (§2 formulário, §3.1) atualizadas; typecheck/lint verdes. ADR D-017 (parte 2).

## 2026-07-16 — D-017 (parte 1, tarefa #12): natureza "dúvida" — a IA responde e resolve sozinha

- **Novo valor de enum `duvida`** (migration 0009, `ALTER TYPE natureza ADD VALUE`; down remapeia para `problema` e recria o tipo — aplicada/revertida/reaplicada com sucesso): o cliente só quer ENTENDER algo; nada muda no sistema.
- **Fluxo (specs/05 §5.5)**: a IA investiga o código, escreve a resposta completa em `respostaAoCliente` (linguagem simples) e, com resposta REAL publicada (não vazia e não rebaixada pelo validador D-015), transiciona `em_triagem → resolvido` — **exceção única e deliberada ao guardrail "agente_ia nunca resolve"** (nova aresta na máquina de estados, restrita pelo aplicador à dúvida respondida). Resposta rebaixada/ausente → `em_atendimento` (humano responde); não entendeu → perguntas (fluxo normal). Dúvida NUNCA gera SPEC nem PR (gates continuam problema-only).
- **Prompt do provider real**: definição das três naturezas + protocolo de dúvida (responder completo, capichar, nunca spec/tentativa); validação aceita `duvida` em `naturezaAjustada`. FakeProvider: marcador `[[natureza:duvida]]`.
- **UI**: rótulo "Dúvida" (badges/filtros pegam automático); opção no formulário do portal (some na parte 2 do D-017, tarefa #13).
- **Validado AO VIVO** (Opus 4.8, US$ 0,29): dúvida real sobre a régua de cobrança do sistema-alvo, declarada de propósito como `problema` — a IA reclassificou para `duvida`, publicou resposta amigável completa (sem jargão) e RESOLVEU sozinha; diagnóstico técnico citando arquivos/linhas ficou na nota interna. Smoke:pipeline com 2 cenários novos (D-017a resolvido / D-017b rebaixada → humano); 193/193 testes (guardrail da máquina atualizado); migrations zero/incremental/revert.
- Specs 02/04/05 e ADR D-017 (cobre também as tarefas #13 e #11, partes 2 e 3).

## 2026-07-16 — bd_consultar: suporte a MySQL/MariaDB (tarefa #14)

- **Bug real:** o `bd_consultar` sempre usava o driver `pg`, independentemente do `bd_tipo` do sistema-alvo — contra um MySQL, o handshake falhava com `received invalid response: 5b` (visto na triagem real do sistema Solving, MySQL 3306).
- **Correção:** executor por SGBD atrás da mesma fachada — `bd_tipo` `mysql`/`mariadb` usa **mysql2** (pool preguiçoso, `connectionLimit: 2`); demais continuam no `pg`. Semântica idêntica nos dois: validação léxica (só `SELECT`/`WITH`, sem `;`), **sessão `READ ONLY` no servidor**, timeout de statement (`MAX_EXECUTION_TIME` no MySQL, fallback `max_statement_time` no MariaDB, best-effort) e **LIMIT forçado por envelope**. Credencial aceita `user:senha`, só senha ou URI (`mysql://`).
- **Validado ao vivo** contra o MySQL real do sistema-alvo do usuário (pelo caminho de produção: cofre → `resolverConfigFerramentas` → `criarFerramentaBd`): `SELECT 1` ok, `information_schema` listou tabelas reais, `DELETE` rejeitado antes de conectar. 193/193 testes; typecheck/lint.
- Spec 05 §4.2 atualizada (SGBDs suportados e garantias); dependência nova `mysql2` no worker.

## 2026-07-16 — D-016: robustez do pipeline de triagem (lock com heartbeat + espera sem consumir tentativas + redes de segurança)

- **Incidente real (causa-raiz confirmada por investigação):** worker morto no meio de uma triagem (Windows mata sem sinal) deixou o lock por tenant órfão por 15 min; os retries do job (3 × backoff 5s ≈ 105s) esgotaram antes do TTL → job em `failed` permanente e chamado preso em `em_triagem` sem registro algum. Bugs correlatos: TTL sem renovação (o comentário da config prometia "renovado a cada execução" — não existia), TTL menor que o pior caso legítimo (mapa+triagem > 15 min), `ExecucaoIA` eterna em `executando`, e `Promise.all` sobre o mesmo cliente pg transacional (erro no pg@9).
- **Lock com heartbeat** (`lock-tenant.ts`): TTL 90s renovado a cada 30s (Lua compare-and-pexpire); worker morto → lock órfão expira em ≤ 90s; perda confirmada loga e para o heartbeat (`manterLockVivo`/`renovarLockTenant`).
- **Lock ocupado não consome tentativa** (`filas/espera-lock.ts`): reagendamento via `moveToDelayed` + `DelayedError` (30–45s com jitter), teto de 20 reagendamentos (guard-rail); aplicado às filas `triagem-ia` e `mapeamento-ia`.
- **Compensação de falha final** (`filas/triagem-ia.ts`): esgotadas as tentativas com erro que escapou do processador, o handler `failed` cria `ExecucaoIA.falhou` (auditável) e escala a humano — cumpre specs/05 §8 também no nível da fila.
- **Varredura de manutenção (redes de segurança)**: `ExecucaoIA` órfã (`na_fila`/`executando` > 30 min) → `falhou` (`execucao_orfa`) + escalonamento; chamado encalhado em `em_triagem` sem execução ativa nem job pendente na fila (> 30 min) → escalonamento (`triagem_nao_executada`). `escalarParaHumano` aceita `execucaoId` nulo.
- **pg@9-proof**: queries do contexto da triagem e das credenciais agora sequenciais (o `em` transacional usa um único cliente pg — o paralelismo era ilusório e virava DeprecationWarning/erro futuro).
- **Boot do worker**: aviso quando outra instância ativa é detectada (presença com heartbeat no Redis — dois `npm run dev` foi o gatilho do incidente); `uncaughtException`/`unhandledRejection` fecham os workers como defesa secundária.
- Novas envs: `TRIAGEM_LOCK_RENOVACAO_MS` (30000), `MANUTENCAO_EXECUCAO_ORFA_MS`/`MANUTENCAO_TRIAGEM_ENCALHADA_MS` (1800000); `TRIAGEM_LOCK_TTL_MS` default 900000 → 90000. `.env.example` também corrige `NOTIFICACOES_SMTP_HOST` para `127.0.0.1`.
- Verificado: typecheck, lint, 193/193 testes (11 novos: heartbeat e reagendamento), smoke:pipeline e smoke:manutencao. Spec 05 (§2, §8) e ADR D-016.

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
