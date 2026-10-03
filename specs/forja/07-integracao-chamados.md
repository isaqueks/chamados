# 07 — Integração com o Chamados

Este documento especifica como a **Forja** conversa com o Chamados: a conexão e a sessão, a identidade que aparece ao cliente, **qual endpoint da API `/api/v1` é chamado em cada momento do pipeline** (com parâmetros e erros esperados, conferidos no código), como reconhecer as notas da IA do servidor, as cadeias de status, os efeitos colaterais de cada escrita, a convivência com a triagem automática e o polling. Também traz o contrato das **extensões de API da ADR D-036** (L1–L4), que mudam o Chamados e não a Forja.

Fora de escopo aqui:

- Máquina de estados da `execucao`, gates, outbox como mecanismo (estados, retentativas, reconciliação): `specs/forja/03-pipeline.md`.
- Entidades `conexao_chamados`, `chamado_cache`, `outbox_chamado` e seus campos: `specs/forja/02-modelo-de-dados.md`.
- Validador de linguagem (detectores + léxico) e contrato `resposta.v1`: `specs/forja/04-agentes-e-contratos.md`.
- Guarda da senha/token, env limpo dos agentes, modelo de ameaças: `specs/forja/05-seguranca.md`.
- Telas (Fila, Conexão, Aprovação, Diagnóstico): `specs/forja/06-ui-ux.md`.
- A API em si (contrato existente): `specs/11-api-mcp.md`; máquina de estados do chamado: `specs/04-chamados.md` §1.3.

Fontes: pesquisa 02 (contrato real, commit `9710bd5`), `critica.md` F14/F15/X-4/X-5/X-6, síntese F-15/F-16/F-19/F-20. Convenção: **[V]** verificado (fonte citada); **[NV]** a validar (spike indicado + plano B).

---

## 1. Princípios

1. **Só pelo backend.** A API não envia cabeçalho CORS nenhum [V: 02 §0.1], e isso é bom: o navegador da Forja nunca chama o Chamados. Toda chamada sai do processo Fastify, via `@chamados/cliente-api` (F-18).
2. **Token nunca no navegador.** A UI da Forja recebe só projeções (status, sinais, textos) pelo SSE/REST local. Token e senha não aparecem em resposta, log, evento, artefato nem no env do `claude` (F-05). Exceção (FJ-030): o token vai ao env do processo do MCP somente leitura (§2.6).
3. **A API não é bypass.** A Forja é um cliente comum, com o papel do usuário dela (`operador`). Ela não ganha poder que um humano no painel não tem, e as extensões D-036 reutilizam o mesmo `autorizar()`, o mesmo service de domínio e a mesma RLS (spec 11 §1.1).
4. **Escritas só depois de um gesto humano, nunca por agente.** Toda escrita no Chamados (nota, mensagem pública, status, atribuição) é executada pelo **código** da Forja e nasce de um gesto humano registrado: G0 "Implementar", Gdec "Enviar pergunta", G2 "Aprovar", "Replanejar", "Publicado em produção" ou "Descartar". Nenhum agente recebe MCP de escrita ou ferramenta de escrita na API (F-01; CLAUDE.md regra 7). **(FJ-030, 2026-10-03):** planejador e condutor recebem o MCP do Chamados em `CHAMADOS_MCP_SOMENTE_LEITURA=true` (§2.6), antecipado da Fase 2. **(FJ-031, 2026-10-03):** a Forja não escreve mais o silêncio da IA do servidor (L1 fica na API, sem uso pela Forja; §7).
5. **Ler antes de escrever.** Transições não são idempotentes, e repetir a mesma dá `409` [V: 02 §4]. Por isso toda escrita é precedida de um `GET` do detalhe, e a decisão é tomada sobre o estado lido, nunca sobre o cache.
6. **Conteúdo do Chamados é dado não confiável.** Descrição, mensagens, anexos e notas da IA do servidor vão ao planejador delimitados como dados (F-03; spec 11 §7.3). **(FJ-031, 2026-10-03):** o condutor também lê o chamado bruto pelo MCP somente leitura (decisão aceita em FJ-030); a regra passa a ser "o texto do cliente é dado delimitado em todo prompt", não "só o planejador o lê".

---

## 2. Conexão, identidade e sessão

### 2.1 Identidade (F-20)

A Forja publica no Chamados com um **usuário `operador` dedicado** (sugestão de nome: "Equipe de Suporte"), criado pelo admin do tenant no painel.

| Aspecto    | Regra                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Papel      | `operador` (aceita `admin`, com aviso de privilégio maior que o necessário). `cliente` é **recusado** na conexão, porque não vê notas internas nem `complexidade`. O `agente_ia` não autentica pela API [V: 02 §1.1]                            |
| Nome       | Aparece ao cliente como autor das mensagens públicas (`autor_nome`). Precisa ser **único** no tenant, porque a API não expõe o id do autor da mensagem, só `autor_nome` e `autor_papel` [V: 02 §1.4], e a anti-duplicação (§9) compara por nome |
| Auditoria  | Os `EventoChamado` saem com o ator = esse usuário. Com isso o painel distingue "feito pela Forja" de "feito por humano" (spec 11 §7.3)                                                                                                          |
| Credencial | Senha no keyring do SO (fallback: arquivo `0600`) e token cifrado no SQLite. Detalhes em `05-seguranca.md`                                                                                                                                      |
| Dev        | O mesmo arranjo, com um operador dedicado no seed local                                                                                                                                                                                         |

> DECISÃO PENDENTE: usar o operador dedicado ou o próprio usuário humano. Default das specs: **dedicado** (critica §6.8). O trade-off é que o cliente vê "Equipe de Suporte", e não o nome de quem aprovou.

### 2.2 Login e reuso do token

| Regra             | Detalhe                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login 1×          | `POST /api/v1/sessao {email, senha}` → `200 {token, expira_em, usuario{id,nome,email,papel}, tenant{slug,nome_exibicao}}` [V: 02 §1.1]. Guarda `usuario.id` (para L4) e `papel`                                                                                                          |
| Reuso             | O token é persistido e reutilizado entre execuções e reinícios. Cada login cria uma `Sessao` nova e não derruba as outras [V: 02 §1.1], então logar a cada operação só polui e queima o rate limit                                                                                       |
| Validade          | 8 h por **inatividade**, deslizando a cada request, com teto absoluto de 30 d que **não** vem na resposta [V: 02 §1.1, D5]. `expira_em` é só informativo: quem manda é o `401`                                                                                                           |
| Relogin           | `401 nao_autenticado` → **um** relogin (single-flight: chamadas concorrentes esperam o mesmo login) → repete a requisição original **uma** vez. Um segundo `401` marca a conexão como "sessão recusada" e para as escritas                                                               |
| Credencial errada | `401 credenciais_invalidas` no login → conexão "credencial inválida". A Forja não tenta de novo sozinha, pede a senha na tela Conexão, e o outbox fica retido                                                                                                                            |
| Rate limit        | 10 tentativas por e-mail e 30 por IP em 300 s [V: 02 §8]. Os logins bem-sucedidos provavelmente também consomem a cota [NV: lógica interna de `consumirRateLimit`; vale o plano conservador]. `429 muitas_tentativas` → nenhum login antes de 300 s, com contador visível no Diagnóstico |
| Logout            | Encerrar a Forja **não** faz `DELETE /sessao`, porque o token é persistido. "Desconectar" e "Trocar credencial" fazem `DELETE /api/v1/sessao` (sempre `204` [V]) e apagam o token local                                                                                                  |
| Timeout           | Todo `fetch` tem abort: 30 s para JSON, 120 s para anexo. Timeout conta como erro de rede (§2.4)                                                                                                                                                                                         |

"Testar conexão" (tela Conexão) = login (só se não houver token válido) → `GET /api/v1/sistemas-alvo` → checa o papel → detecta a D-036 (§2.5).

### 2.3 Resolução de tenant: dev × produção

| Ambiente | `url_base`                                               | Tenant                                                                         | Regras                                                                                                     |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Produção | Host do tenant: domínio próprio ou `<slug>.<plataforma>` | Resolvido pelo host. **Não** enviar `x-tenant-slug`                            | **HTTPS obrigatório**: a senha vai no corpo do login e o token no header (`validarBaseUrl`, spec 11 §7.3)  |
| Dev      | `http://localhost:3000`                                  | Header `x-tenant-slug: <slug>` (o que o `cliente.ts` do MCP já faz [V: 02 §8]) | Alternativa válida: `http://<slug>.localhost:3000`. `?tenant=` não é usado                                 |
| Proibido | `http://127.0.0.1:3000`                                  | —                                                                              | O proxy extrai o slug `"127"` do host (4 rótulos) e ignora o header [V: 02 D7] → `404 tenant_desconhecido` |

A tela Conexão **recusa** IP literal como host local e explica o motivo. O campo de tenant só aparece quando o host é `localhost` (FJ-030); em produção ele não é pedido. Em `@chamados/cliente-api`, o `validarBaseUrl` passa a emitir aviso para `127.0.0.1`, em vez de aceitá-lo calado. O comportamento do MCP fica compatível, e só a Forja recusa.

A Forja escuta em `127.0.0.1:4317` (F-17) e não colide com a porta 3000 do `npm run dev` do Chamados.

### 2.4 Tratamento de erros (comum a todas as chamadas)

Forma de erro: `{erro, codigo}`. A Forja decide **pelo `codigo`** [V: 02 §1].

| HTTP · `codigo`                             | Significado real (com as divergências D1–D7)                                                                                  | Reação da Forja                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 corpo_invalido` / `parametro_invalido` | Bug da Forja ou corpo > 50.000 caracteres [V: 02 §1.5]                                                                        | Não retenta. Evento vermelho; a execução vai a `precisa_humano`. Nota longa → trunca antes de enviar (§9)                                                                                         |
| `401 nao_autenticado`                       | Token expirado/revogado                                                                                                       | Relogin 1× (§2.2)                                                                                                                                                                                 |
| `401 credenciais_invalidas`                 | Só no login                                                                                                                   | Conexão inválida; outbox retido                                                                                                                                                                   |
| `403 sem_permissao`                         | Em `/status`: **papel fora da aresta** (não existe `papel_nao_pode`) [V: D1]. Nas demais rotas: papel do usuário insuficiente | Em `/status`: relê e recalcula a cadeia (§5). Senão: alerta de configuração da conexão                                                                                                            |
| `404 chamado_inexistente`                   | Inexistente, fora do escopo ou de outro tenant (idêntico, não vaza)                                                           | A execução vai a `precisa_humano` ("chamado inacessível"), sem mais escritas                                                                                                                      |
| `404 tenant_desconhecido`                   | Host/slug errado (inclusive `127.0.0.1`)                                                                                      | Erro de configuração, com destaque na tela Conexão                                                                                                                                                |
| `404 anexo_inexistente`                     | Anexo negado ou ausente [V: D2]                                                                                               | Registra no plano "anexo indisponível" e segue                                                                                                                                                    |
| `409 estado_terminal`                       | Chamado `fechado`/`cancelado`                                                                                                 | Passo do outbox `pulado` + aviso; nenhuma escrita a mais                                                                                                                                          |
| `409 transicao_invalida`                    | Aresta inexistente **ou** mesmo status [V: 02 §1.6]                                                                           | **Nunca** conta como sucesso às cegas (critica A-5): relê, recalcula 1× e, se persistir, vai a `precisa_humano`                                                                                   |
| `409 conflito`                              | Default genérico do `respostaDeMotivo` [V: D2]                                                                                | `precisa_humano`, com o texto do erro                                                                                                                                                             |
| `429 muitas_tentativas`                     | Rate limit do login                                                                                                           | Espera a janela (§2.2)                                                                                                                                                                            |
| 5xx, rede, timeout                          | —                                                                                                                             | Backoff exponencial com jitter (leituras: 1 s → 5 min; escritas do outbox: a escada de `03-pipeline.md` §9.3, até 30 min). **Antes** de retentar uma escrita, faz a checagem de idempotência (§9) |

### 2.5 Detecção da D-036

As extensões L1–L4 entram juntas no mesmo deploy do Chamados (U-6). A Forja as detecta pela **presença do campo `ia_silenciada` no item da lista** (é parte da L1, §11.1). Sem o campo, roda no "modo sem D-036": silêncio manual, mapeamento por nome, complexidade só em memória e sem atribuição. O Diagnóstico mostra o modo ativo. A detecção é refeita a cada "Testar conexão" e a cada boot.

### 2.6 MCP do Chamados somente leitura para os agentes (FJ-030, 2026-10-03)

Antecipa a FORA-07 da Fase 2. O usuário já trabalha com o `claude` + o MCP do Chamados; a Forja dá o mesmo aos agentes, sem escrita.

| Aspecto                | Regra                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quem recebe            | planejador e condutor (`04-agentes-e-contratos.md` §2). Subagentes não                                                                                                                                                                                                                                                                                                         |
| Servidor               | o **`apps/mcp` existente**, por stdio, com `CHAMADOS_MCP_SOMENTE_LEITURA=true`: `chamados_listar`, `chamado_obter`, `anexo_obter` (o modelo vê imagens), `sistemas_alvo_listar`. Nenhuma ferramenta de escrita (L1/L4 continuam só no app, §11)                                                                                                                                |
| Autenticação           | **token de sessão** da conexão da Forja, sem senha e sem novo login (não queima o rate limit, §2.2). Novo: `@chamados/cliente-api` aceita `tokenInicial`, e o `apps/mcp` aceita `CHAMADOS_TOKEN` no lugar de `CHAMADOS_SENHA` (com `CHAMADOS_URL`, `CHAMADOS_EMAIL` e, em dev, `CHAMADOS_TENANT`). Token recusado (`401`) no MCP = a ferramenta devolve erro; o MCP não reloga |
| Spawn                  | `--strict-mcp-config --mcp-config <dados>/execucoes/<id>/mcp.<n>.json` gerado por etapa (`0600`, negado ao Read dos agentes, apagado no fim da etapa). O token vai no `env` do servidor dentro desse arquivo, nunca no env do `claude`. `validarInit` aborta se aparecer outro servidor em `mcp_servers`; `chamados` ausente ou fora do ar só gera alerta                      |
| Relação com `entrada/` | o app continua gravando `entrada/` (chamado em markdown + anexos) para auditoria e para o prompt do planejador; o MCP é complemento (reler, chamados relacionados, imagens)                                                                                                                                                                                                    |
| Escritas               | continuam **só** pelo outbox do app, depois de gesto humano (§1, princípio 4)                                                                                                                                                                                                                                                                                                  |

**Exposto (aceito em FJ-030):** o processo do MCP carrega o token; um script do agente em bypass (mesmo usuário) pode lê-lo e chamar a API **com escrita** como o operador dedicado. Como os agentes já rodam em bypass como o usuário e alcançavam `forja.db` e o keyring destravado (FJ-006), isso não amplia a exposição. O condutor passa a poder ler o texto do cliente pelo MCP (FJ-005 enfraquecido; `05-seguranca.md` §4.3).

---

## 3. Uso da API por momento do pipeline

Contrato real conferido no código (02 §1). `{ref}` = UUID do chamado, guardado no `chamado_cache`. A Forja usa o UUID e não o número, porque `#` exige codificação [V: 02 §1.4].

| Momento                           | Chamada(s)                                                                                                                                        | Parâmetros / corpo                                                                                                                                                                                                                                                                            | Sucesso                                         | Erros esperados → reação                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fila**                          | `GET /api/v1/chamados` **2×** (uma por natureza, porque `natureza` não aceita lista [V: 02 §2]), paginando até `proximo_cursor = null`            | `status=em_atendimento,aguardando_cliente&natureza=alteracao&limite=100` e o mesmo com `natureza=problema`. `duvida` fica fora (não muda o sistema). Com D-036: `+&complexidade=…` (§11.3)                                                                                                    | `200 {itens, proximo_cursor}`                   | `400 parametro_invalido` → bug. Sem D-036, a complexidade é filtrada em memória (`?complexidade=` seria **ignorado em silêncio** [V: D4]); com D-036 o filtro em memória continua como defesa. A Forja só envia `?complexidade=` depois de detectar a D-036; com filtro, chamado sem complexidade fica fora (implementação, 2026-10-02/03) |
| **Mapeamento**                    | — (lista)                                                                                                                                         | Sem D-036: `sistema_nome` × `mapeamento_sistema` (frágil a renomear). Com D-036 (L2): `sistema_alvo_id`. Na primeira vez que o id aparece, o mapeamento por nome é convertido em mapeamento por id                                                                                            | —                                               | Chamado sem projeto mapeado → aparece na fila como "sem projeto", não implementável                                                                                                                                                                                                                                                        |
| **Sinais** (lazy, concorrência 4) | `GET /api/v1/chamados/{ref}?formato=markdown`                                                                                                     | `markdown` preserva os títulos para o parsing das notas (§4) [V: 02 §3]                                                                                                                                                                                                                       | `200 {chamado, mensagens[]}`                    | Cache por `(id, updated_at)`, **mas** isso não basta para os chamados em voo (§8). `404` → some da fila                                                                                                                                                                                                                                    |
| **Pré-condições** (G0)            | `GET` detalhe **fresco**                                                                                                                          | Exige: status `em_atendimento` (ou `aguardando_cliente` com confirmação explícita); natureza ≠ `duvida`; projeto mapeado; nenhuma execução ativa da Forja no mesmo chamado. Recusa `novo`, `em_triagem` (§5) e os terminais. **Sem** pré-condição de `ia_silenciada` (FJ-031, 2026-10-03; §7) | —                                               | Pré-condição falhou → o botão explica qual e oferece a ação (Mapear sistema, Conexão, Diagnóstico)                                                                                                                                                                                                                                         |
| **Início**                        | (L4) `POST …/atribuicao {operador_id: usuario.id}` · `POST …/mensagens` (sem L1: a Forja não silencia a IA, FJ-031, 2026-10-03)                   | Nota `interna` em linhas: "Implementação local iniciada (Forja)", `Branch: forja/chamado-<n>-<slug>`, aviso de acompanhamento e, como **rodapé** (fora de crases), `[forja:<execucao_id>:inicio]` (implementação, 2026-10-02/03)                                                              | `200` / `200` / `201 {id}`                      | L4 com o chamado atribuído **a outra pessoa** → não reatribui sem confirmação no G0 (§11.4). Nota interna não notifica ninguém [V: 02 §5.1]                                                                                                                                                                                                |
| **Anexos**                        | `GET /api/v1/anexos/{id}` para cada anexo da descrição e das mensagens (inclusive de notas internas)                                              | Grava em `<exec>/entrada/anexos/<id>-<basename sanitizado>`, **fora da worktree**. Um nome vindo do servidor nunca vira caminho. No markdown, `/api/v1/anexos/<id>` é reescrito para o caminho local                                                                                          | `200` bytes, `content-type` pinado [V: 02 §1.9] | `404 anexo_inexistente` → "anexo indisponível" no plano. Um id malformado pode dar 404 ou 500 [NV: 02 §1.9; tratar 5xx como indisponível]                                                                                                                                                                                                  |
| **Polling** (em voo)              | `GET` detalhe a cada 3 min + sob demanda                                                                                                          | Compara `status`, `ia_silenciada` (só informativo, FJ-031) e o id da última mensagem (§8)                                                                                                                                                                                                     | —                                               | `404` → `precisa_humano`. Terminal → para tudo                                                                                                                                                                                                                                                                                             |
| **Pergunta ao cliente** (Gdec)    | `GET` → `POST …/mensagens {visibilidade:"publica", corpo}` → `POST …/status {status:"aguardando_cliente", motivo:"pergunta_via_forja"}`           | Texto aprovado pelo humano e **revalidado** (§10). A transição só é feita se o status lido não for `aguardando_cliente` (arestas do operador a partir de `em_atendimento` e de `em_triagem` [V: maquina-estados.ts:49,58])                                                                    | `201` / `200`                                   | `409 estado_terminal` → aborta. A execução vai a `aguardando_cliente_resposta`                                                                                                                                                                                                                                                             |
| **Retomada após resposta**        | `GET` → se `em_triagem`: `POST …/status {status:"em_atendimento", motivo:"retomada_via_forja"}`                                                   | Disparado pelo humano em "Replanejar" (§8.2)                                                                                                                                                                                                                                                  | `200`                                           | Ver §8.2 (caso F14/F15)                                                                                                                                                                                                                                                                                                                    |
| **Descartar**                     | `POST …/mensagens {interna}` (opcional, com motivo) · (L4) restaurar a atribuição anterior **se foi a Forja que mudou** (sem reativar IA, FJ-031) | Marcador `[forja:<execucao_id>:descarte]`                                                                                                                                                                                                                                                     | `201` / `200`                                   | `409 estado_terminal` → ignora (nada a restaurar)                                                                                                                                                                                                                                                                                          |
| **Concluir**                      | Sequência de encerramento (§9) via outbox                                                                                                         | —                                                                                                                                                                                                                                                                                             | —                                               | §9                                                                                                                                                                                                                                                                                                                                         |

---

## 4. Identificação das notas da IA do servidor

A API **não** expõe `execucao_ia_id` [V: 02 §1.4, §3]. Diagnóstico, SPEC e PR da IA do servidor são reconhecidos por **texto**, sobre o detalhe pedido em `?formato=markdown`.

**Filtro base:** `visibilidade = "interna"` ∧ `autor_papel = "agente_ia"`. Mensagens da própria Forja têm `autor_papel = operador` e o marcador `[forja:…]`, e nunca entram nesta classificação.

| Tipo                  | Marcador (primeira linha / conteúdo)                                                                                                                                                                | Fonte [V]                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Diagnóstico           | 1ª linha `Diagnóstico automático (Assistente IA)`; contém `Confiança da análise:` e, se houver, `Complexidade avaliada:`. Pode terminar com o apêndice `Resposta pública rebaixada pelo validador…` | `triagem-notas.ts:78-84`                           |
| PR / branch da IA     | 1ª linha `Resolução automática (Assistente IA) — Pull Request aguardando revisão`; linhas `Pull Request: <url>` e/ou `Branch: ia/chamado-<N>-<slug>`                                                | `triagem-notas.ts:318-333`                         |
| Falha de resolução    | `Tentativa de resolução automática NÃO concluída (Assistente IA).`                                                                                                                                  | `triagem-notas.ts:353`                             |
| Escalonamento         | `Triagem automática não concluída — encaminhado para atendimento humano.`                                                                                                                           | `triagem-notas.ts:110`                             |
| SPEC (só `alteracao`) | **Heurística**: nota que não casa com nenhum marcador acima **e** (começa com `# SPEC` **ou** contém `## Critérios de aceite`)                                                                      | `triagem-notas.ts:166,197`; `aplicador.ts:398-415` |
| Pública "em revisão"  | `publica` ∧ `agente_ia` ∧ texto = `MENSAGEM_PUBLICA_CORRECAO_EM_REVISAO`                                                                                                                            | `triagem-notas.ts:548`                             |

Regras:

- **A SPEC nem sempre usa o template literal.** O aplicador grava a SPEC que o modelo devolveu e só usa `montarTemplateSpec` quando ela vem vazia [V: 02 §3]. Por isso vale a heurística acima, e a classificação "outra nota da IA" fica como fallback: ela também vai ao planejador, rotulada como tal.
- **Use a mais recente.** Cada resposta do cliente re-dispara a triagem e gera uma nova rodada de notas [V: 02 §3]. Para cada tipo, vale a **última** da lista (que vem em ordem ASC). As anteriores ficam acessíveis no painel da execução, mas não vão ao planejador.
- **PR/branch da IA.** O nome vem de `nomeBranchResolucao` = `ia/chamado-<n>-<slugChamado(titulo)>` [V: `triagem-notas.ts:233`]. A Forja extrai `Branch:`/`Pull Request:` da nota, exibe o sinal "PR da IA existe" na fila e, no G0, oferece **"aproveitar como referência"** (o planejador recebe o resumo e os arquivos alterados, como dado) ou **"ignorar"**. Partir da branch da IA fica para a Fase 2 (F-15). A branch da Forja usa o prefixo `forja/` e nunca colide (F-09).
- O que vai ao planejador (diagnóstico, SPEC e resumo do PR mais recentes) é **dado não confiável derivado do texto do cliente** e vai delimitado (F-03). Os detalhes do prompt estão em `04-agentes-e-contratos.md`.
- Um parsing que falha (mudança de texto no Chamados) degrada para "nota da IA não classificada" e **nunca** bloqueia a fila. O teste de contrato da Forja importa os construtores de `@chamados/shared` (`montarNotaResolucaoPr` etc.) e verifica que o classificador reconhece a saída deles. Assim, uma mudança no Chamados quebra o teste, e não a produção.

---

## 5. Cadeias de status (operador/admin)

Fonte: `TRANSICOES` em `packages/shared/src/maquina-estados.ts:46-63` [V]; `admin` herda as permissões de `operador`. A Forja importa `transicaoValida`/`transicoesDoPapel` de `@chamados/shared` (F-18) e **calcula** a cadeia a partir do status lido, nunca de uma tabela própria.

| Status lido             | Cadeia até `resolvido`                                                                                                                                          | `fechado` (só se configurado) | Erros se pular passos [V: 02 §4]                                                                      | Forja implementa?                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `novo`                  | **Impossível**: o operador só pode `cancelado`; `novo→em_triagem` é do `sistema`                                                                                | —                             | `→em_triagem`: `403 sem_permissao`; `→em_atendimento`/`resolvido`/`fechado`: `409 transicao_invalida` | **Não**                                                                             |
| `em_triagem`            | `em_atendimento` → `resolvido` (a aresta direta `em_triagem→resolvido` existe, mas a Forja não a usa: o caminho por `em_atendimento` deixa a auditoria legível) | `resolvido → fechado`         | `→fechado`: `409 transicao_invalida`                                                                  | **Não iniciar** (corrida com a triagem). Só aparece **durante** uma execução (§8.2) |
| `aguardando_cliente`    | `em_atendimento` → `resolvido`                                                                                                                                  | idem                          | `→resolvido`: `409`; `→em_triagem`: `403` (é do `sistema`)                                            | Sim, com confirmação                                                                |
| `em_atendimento`        | `resolvido`                                                                                                                                                     | idem                          | `→fechado`: `409 transicao_invalida`                                                                  | **Sim** (caso normal)                                                               |
| `resolvido`             | já está                                                                                                                                                         | `fechado`                     | `→resolvido`: `409 transicao_invalida` (mesmo status)                                                 | Não (a fila não mostra). Se aparecer durante a execução, foi um humano → §8         |
| `fechado` / `cancelado` | terminal                                                                                                                                                        | —                             | `409 estado_terminal` (ou `transicao_invalida` se for o mesmo status, porque esse check vem antes)    | Não; qualquer execução para                                                         |

**Cadeias calculadas** (implementação, 2026-10-02/03): `calcularCadeia(lido, alvo)` nunca usa `em_triagem → resolvido` nem `cancelado`, e **nunca reabre** por padrão — um chamado que precisaria ser reaberto volta como `exige_reabrir` e fica para uma pessoa.

**Por que não implementar em `novo`/`em_triagem`.** Em `novo` não há caminho até `resolvido`. Em `em_triagem` a triagem pode estar rodando. A Tx2 do aplicador relê o chamado e, se o status já mudou, **não transiciona, mas ainda publica** diagnóstico, SPEC e possivelmente uma resposta pública [V: 02 §4, `aplicador.ts:132-135,449-461`]. O certo é esperar `em_atendimento`, onde a SPEC e o diagnóstico já são os finais.

---

## 6. Efeitos colaterais de cada escrita

Toda escrita pela API passa pelo mesmo `comDespacho` da UI [V: 02 §5.1]: notificação, webhook do tenant e auditoria. A Forja **não tem** como suprimir esses efeitos. Ela os conta e ordena as escritas para minimizar o ruído.

| Escrita da Forja                                             | Evento                         | Cliente recebe?                             | Equipe recebe?                                                                                                     | Webhook do tenant  |
| ------------------------------------------------------------ | ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Nota `interna`                                               | nenhum                         | **nunca**                                   | não                                                                                                                | não                |
| Mensagem `publica`                                           | `mensagem_publica`             | sim (default ligado, desligável)            | sim                                                                                                                | `mensagem_publica` |
| `→ aguardando_cliente` / `→ em_atendimento` (não reabertura) | `mudanca_status`               | **default desligado**                       | default desligado                                                                                                  | `status_alterado`  |
| `→ resolvido`                                                | `resolvido`                    | **sim, obrigatório**                        | sim                                                                                                                | `resolvido`        |
| `→ fechado` (manual)                                         | `fechado`                      | sim (default ligado)                        | sim                                                                                                                | `fechado`          |
| L1 silenciar/reativar IA (**não usada pela Forja**, FJ-031)  | `ia_silenciada`/`ia_reativada` | nunca (`ia_*` não notifica [V: `tipos.ts`]) | não                                                                                                                | não                |
| L4 atribuir/desatribuir                                      | `atribuicao`                   | não                                         | **obrigatório** para o operador destino [V: `tipos.ts:139-145,194-196`]; o destinatário da desatribuição está [NV] | `atribuicao`       |

Consequências:

- **Encerramento padrão = 2 e-mails ao cliente** (mensagem pública + `resolvido`). O `fechado` manual seria o 3º; o auto-fechamento manda o seu 3 dias depois (`chamado_fechado_auto` → `fechado`).
- **Pergunta ao cliente = 1 e-mail** (a pública). A mudança para `aguardando_cliente` não notifica por default.
- **Re-disparo da triagem só por mensagem pública do cliente final**, em qualquer status não terminal, com debounce de 45 s [V: 02 §5.2]. Mensagem pública da Forja (operador), nota interna e mudança de status **não** re-disparam.
  - Em `aguardando_cliente`, o sistema move o chamado para `em_triagem`.
  - Em `resolvido`, o chamado **reabre** para `em_atendimento` (`reaberto_count++`, auto-fechamento cancelado).
  - Nos demais status, a triagem só é re-enfileirada.
- **Auto-fechamento:** um job a cada 5 min fecha os `resolvido` vencidos, por default 3 dias depois (`fechar_automaticamente_em`, exposto no detalhe [V: D3]). A Forja mostra esse prazo na tela de concluídos.
- **Webhook do tenant:** dispara para a URL do tenant em toda escrita acima. A Forja não depende dele, porque ele não alcança `localhost` (§8).
- **(FJ-031, 2026-10-03)** A Forja não escreve `ia_silenciada`: a triagem do servidor segue o que o painel definir. Uma mensagem pública do cliente pode, portanto, rodar a triagem num chamado em voo — risco aceito e informativo (§7).

> DECIDIDO (2026-10-02): o status final padrão é **`resolvido`** + auto-fechamento do servidor (U-1). `fechado` imediato e `aguardar_deploy` são opções por projeto. O `fechado` é terminal: elimina o canal "não funcionou" e conflita com D-022 (merge ≠ deploy) (critica X-5).

> DECISÃO PENDENTE: merge = deploy? (U-5). Default por projeto = **não**. Isso faz a resposta pública usar o modelo "aguardando publicação" (§10). Num projeto com deploy mais lento que 3 dias, o auto-fechamento chega antes da publicação (critica X-6): a tela Projeto avisa quando `entrega.merge_publica = false` ∧ `ao_concluir = resolvido` e sugere `aguardar_deploy`.

---

## 7. A IA do servidor: informativa, nunca pré-condição (FJ-031, 2026-10-03)

**O risco [V: 02 §5.3].** Uma mensagem pública do cliente re-dispara a triagem mesmo em `em_atendimento`. Durante a implementação local, a IA do servidor pode então:

- publicar uma resposta pública ao cliente;
- gravar uma SPEC nova que contradiz o plano aprovado;
- em `facil` com confiança alta, abrir branch `ia/chamado-N-*` e um PR concorrente. Se o gate pré-call abre no reprocesso a partir de `em_atendimento` é [NV: 02 §5.3]; trate como possível.

**Decisão (FJ-031, decisão do usuário):** _"quem vai implementar é o meu claude local, nada tem a ver com a IA do sistema de chamados."_ A "briga" vira **risco aceito e informativo**:

- **Sem pré-condição** de `ia_silenciada` no G0 (nem bloqueio, nem "não se sabe", nem confirmação) e sem configuração para ligá-la.
- **A Forja nunca silencia nem reativa** a IA (os passos `silenciar_ia`/`reativar_ia` do outbox nunca são enfileirados; `execucao.ia_silenciada_pelo_app` não é escrito). A L1 (§11.1) continua na API para o painel e o MCP.
- **Sinais só informativos:** o badge da fila mostra "IA ativa"/"IA silenciada" em tom neutro; `ia_silenciada → false` e nota/PR novo do `agente_ia` publicam o evento `chamado.sinal` (nível `info`) e entram como contexto (dado não confiável) — sem `precisa_humano` e sem bloquear o merge. O PR `ia/chamado-N-*` continua como aviso no plano (`trabalho_existente`, força o G1) e no G2.
- O que continua protegendo o trabalho: o status (`novo`/`em_triagem` não são implementáveis; `status_mudou` inesperado leva a `precisa_humano`, §8), o polling com "li" na aprovação para mensagem nova, e o humano no G2 com o diff.

Histórico: até FJ-031 havia a pré-condição `ia_silenciada = true` (FJ-018) — manual sem D-036; com L1, a Forja silenciava no início e reativava no fim só se tivesse sido ela.

---

## 8. Polling dos chamados em voo

**Por que polling.** Não há SSE, e o webhook é por tenant e precisa de URL pública, que não alcança `localhost` [V: 02 §5.4]. Além disso, **mensagem nova não altera `chamado.updated_at`**: `criarMensagem` não faz `UPDATE chamado` [V: 02 §0.8]. A lista não serve para detectar novidade, e é preciso ler o detalhe.

### 8.1 Regra

- **Quem é polled:** toda execução fora de `concluido`, `descartado` e `cancelado`, inclusive `mergeado_pendente_chamado`, `aguardando_deploy`, `precisa_humano`, laterais e `aguardando_cliente_resposta`.
- **Frequência:** a cada 3 min, com jitter de ±20 % e concorrência 4.
- **Leitura extra obrigatória:**
  - ao abrir a tela de Aprovação (G2);
  - imediatamente antes do merge;
  - antes de cada passo do outbox;
  - no botão "Atualizar".
- O polling é pausado sem conexão válida (§2.2) e não gera login.

Comparação com o último snapshot (`chamado_cache`): `status`, `ia_silenciada` (só informativo, FJ-031) e o **id da última mensagem**. As mensagens novas são as que vêm depois do id guardado.

| Novidade                                                              | Reação                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mensagem `publica` do **cliente**                                     | Badge "cliente escreveu". O conteúdo **não** é injetado no agente sem humano (critica §4, B). A aprovação G2 passa a exigir "li" e o merge fica bloqueado até lá. Em `aguardando_cliente_resposta`: §8.2 |
| Mensagem/nota de **outro humano** da equipe                           | Badge informativo; "li" na aprovação                                                                                                                                                                     |
| Nota/mensagem do **`agente_ia`**                                      | Evento informativo e classificação (§4); PR novo da IA vira aviso no G2 — sem mudar o estado (FJ-031, §7)                                                                                                |
| `status` mudou por terceiro (ex.: humano resolveu, cancelou, reabriu) | Pausa **antes do merge** e exige reaprovação com o novo status visível                                                                                                                                   |
| Status terminal                                                       | A execução vai a `precisa_humano` ("chamado encerrado no Chamados"), e o outbox não escreve mais nada                                                                                                    |
| `ia_silenciada` → `false`                                             | Evento informativo `ia_reativada`, sem efeito no estado (FJ-031, §7)                                                                                                                                     |
| `404`                                                                 | `precisa_humano` ("chamado inacessível")                                                                                                                                                                 |

### 8.2 Pergunta → resposta do cliente (critica F14/F15)

Com a IA silenciada (pelo painel — a Forja não silencia desde FJ-031), a resposta do cliente a um chamado em `aguardando_cliente` deixa o chamado **parado em `em_triagem`**. O sistema transiciona o status, e o worker descarta o job [V: critica F14, `mensagem-service.ts:213-222`]. O operador **pode** mover `em_triagem → em_atendimento` [V: critica F15, `maquina-estados.ts:50`]. O gatilho de retomada, portanto, é a **mensagem nova do cliente**, nunca "voltou a `em_atendimento`" (o erro A-2/B-6 da crítica).

```mermaid
sequenceDiagram
    participant H as Usuário (Forja)
    participant F as Forja (backend)
    participant C as Chamados API
    participant W as Worker (triagem)
    H->>F: Gdec: aprova pergunta
    F->>C: GET detalhe; POST mensagens {publica}; POST status aguardando_cliente
    Note over F: execucao = aguardando_cliente_resposta
    Note over C: cliente responde no portal
    C->>C: sistema: aguardando_cliente → em_triagem
    C->>W: enfileira triagem
    W-->>W: ia_silenciada → descarta o job
    F->>C: polling: GET detalhe (msg nova do cliente, status em_triagem)
    F->>H: "cliente respondeu" + Replanejar
    H->>F: Replanejar
    F->>C: GET; POST status em_atendimento (motivo retomada_via_forja)
    F->>F: novo planejar com a resposta (dado não confiável)
```

Casos de borda:

- **IA não silenciada no momento da resposta** (o caso comum desde FJ-031, 2026-10-03, porque a Forja não silencia): a triagem roda e pode mover o status sozinha. A Forja **não corre** contra ela nem a espera: "Replanejar" lê o status e, se ainda for `em_triagem`, leva a `em_atendimento` (rodada `status_em_atendimento`); se a triagem já moveu, não transiciona. As notas novas da IA entram como contexto (dado não confiável).
- **Status já `em_atendimento`** (um humano moveu): não transiciona e só replaneja.
- **Cliente respondeu sem existir pergunta da Forja** (chamado em `em_atendimento`): o status não muda. Mesmo tratamento do badge (§8.1). O "Replanejar" é opcional.

Spike **S7** valida o ciclo inteiro no Chamados local (critério na §13).

---

## 9. Sequência de encerramento: a visão da API

O mecanismo (passos do `outbox_chamado`, estados `mergeado_pendente_chamado`/`aguardando_deploy`, botão "tentar agora", reconciliação no boot) é de `03-pipeline.md`. Aqui ficam as chamadas e a **checagem de idempotência** de cada passo. A API não é idempotente [V: 02 §4], e a checagem é o que torna a retentativa segura.

Todo passo começa com `GET /api/v1/chamados/{ref}?formato=markdown`.

| #   | Passo                   | Chamada                                                                    | Já feito? (checar antes de enviar e antes de retentar)                                                                                                                                                      | Condição                                                                                          |
| --- | ----------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `nota_interna`          | `POST …/mensagens {visibilidade:"interna", corpo}`                         | Existe nota `interna` de papel `operador`/`admin` contendo o marcador `[forja:<execucao_id>:conclusao]` (o UUID torna o marcador único; o nome do autor **não** é comparado (implementação, 2026-10-02/03)) | Sempre, logo após `mergeado`                                                                      |
| 2   | `mensagem_publica`      | `POST …/mensagens {visibilidade:"publica", corpo}`                         | Existe `publica` do mesmo `autor_nome`, com `created_at ≥ enviado_em − 5 min` e **corpo normalizado** igual (critica X-4)                                                                                   | Retido em `aguardar_deploy`                                                                       |
| 3   | `status_em_atendimento` | `POST …/status {status:"em_atendimento", motivo:"implementado_via_forja"}` | Status lido ∉ {`aguardando_cliente`, `em_triagem`}                                                                                                                                                          | Só a partir desses dois                                                                           |
| 4   | `status_resolvido`      | `POST …/status {status:"resolvido", motivo:"implementado_via_forja"}`      | Status lido = `resolvido`                                                                                                                                                                                   | Grava `resolvido_em` e agenda o auto-fechamento [V: 02 §4]                                        |
| 5   | `status_fechado`        | `POST …/status {status:"fechado", motivo:"implementado_via_forja"}`        | Status lido = `fechado`                                                                                                                                                                                     | **Só** com `ao_concluir = fechado_imediato`                                                       |
| 6   | ~~(L1) reativar IA~~    | —                                                                          | —                                                                                                                                                                                                           | **Removido (FJ-031, 2026-10-03):** nunca enfileirado; o passo fica no enum só para linhas antigas |

Regras:

- **A pública vem antes de qualquer `fechado`.** Depois do `fechado`, toda mensagem dá `409 estado_terminal` [V: 02 §4].
- **Nota interna.** O formato é próximo de `montarNotaResolucaoPr`, para o painel e a equipe reconhecerem:
  - 1ª linha: `Implementação local (Forja) — aprovada e integrada`;
  - `Branch: forja/chamado-<n>-<slug>`;
  - `Commit: <sha do merge>`;
  - `Destino: <branch> (<modo de entrega>)`;
  - `Nível de verificação: <nivel>`;
  - `Resumo da mudança:`, `Arquivos alterados:`;
  - com o selo `altera_ui` (FJ-026): `Prints antes/depois em <n> telas disponíveis na Forja (execução <id>)` com a lista das telas e o `o_que_mudou_para_quem_usa` de cada uma; sem prints, a linha diz `Alteração de interface sem prints: <motivo>` e, se houve, "aprovado sem prints";
  - rodapé `[forja:<execucao_id>:conclusao]`.

  Limite de **50.000 caracteres de texto** [V: 02 §1.5]: acima disso, o relatório é truncado com "relatório completo na Forja, execução <id>". Imagens em markdown viram texto alternativo [V], então os prints **ficam na Forja** (`retencao.evidencias_dias` = 90 dias após `concluido`, `02-modelo-de-dados.md` §9; não seguem `entrada/`) e publicá-los no chamado depende da L7 (§11.5).

- **Normalização do corpo** (passos 1 e 2): o corpo volta do servidor convertido markdown → rich text → markdown. Antes de comparar, a Forja normaliza:
  - forma NFC;
  - remoção dos escapes `\` do markdown;
  - espaços colapsados;
  - aparas.

  Que isso baste para casar byte a byte é [NV: S7]. O plano B é casar por autor + janela de tempo + os primeiros 200 caracteres normalizados. Os marcadores `[forja:…]` também passam pela mesma normalização.

- **`409 transicao_invalida` num passo de status** → relê e recalcula 1× (§2.4). **`409 estado_terminal`** → o passo fica `pulado`, com aviso; os seguintes também.
- **Boot:** `git merge-base --is-ancestor` garante que nada é re-mergeado, e o outbox retoma do primeiro passo não confirmado (F-16).

---

## 10. Linguagem da mensagem pública e mensagens-modelo

Toda mensagem `publica` é validada **duas vezes**: ao exibir o rascunho e imediatamente antes do envio, sobre o texto final, já editado. A validação usa:

- `detectarConteudoTecnico` + `detectarPromessaResolucao` de `@chamados/shared`;
- o **léxico extra** da Forja.

A API **não** valida a linguagem [V: 02 §0.3], e o detector do servidor não pega "fizemos o merge da branch" [V: D6]. A especificação completa do validador, do léxico e do "publicar mesmo assim" está em `04-agentes-e-contratos.md`.

Dois requisitos que nascem da integração e valem para o léxico de 04:

- **Fronteira de palavra Unicode.** `\b` do JavaScript é ASCII: `/\bPR\b/i` casa com "**pr**óxima" [V: executado em 2026-10-02]. O léxico usa as fronteiras `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` com a flag `u`. As siglas (`PR`, `API`) são sensíveis a maiúsculas.
- **Nunca usar forma de fato consumado, nem depois do deploy.** O detector de promessa não sabe se a publicação já aconteceu: "foi corrigido" é reprovado em qualquer modo [V: `triagem-notas.ts:475-501`]. O modelo "disponível" diz "já está disponível".

**Mensagens-modelo.** Rodadas contra os detectores do commit `9710bd5` e o léxico Unicode em 2026-10-02: todas passaram, e "Fizemos o merge da branch e o PR foi aprovado" foi reprovada só pelo léxico [V: execução local]. Os `{{campos}}` são preenchidos a partir do `resposta.v1`. A validação roda **depois** da substituição.

| Tipo (`resposta.v1.tipo`) | Quando                                                                   | Texto                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pergunta`                | Gdec                                                                     | "Olá, {{primeiro_nome}}! Para seguirmos com o seu pedido, precisamos de uma confirmação:<br><br>{{perguntas_numeradas}}<br><br>Assim que você responder por aqui, damos continuidade."                                                                                               |
| `aguardando_publicacao`   | Concluído com merge ≠ deploy, modo `resolvido`                           | "Olá, {{primeiro_nome}}! A mudança que você pediu foi preparada e aprovada pela nossa equipe e entra no sistema na próxima atualização.<br><br>O que muda para você: {{o_que_muda}}<br><br>Se, depois da atualização, algo não ficar como esperado, é só responder a esta mensagem." |
| `disponivel`              | Merge = deploy, ou depois de "Publicado em produção" (`aguardar_deploy`) | "Olá, {{primeiro_nome}}! A mudança que você pediu já está disponível no sistema.<br><br>O que muda para você: {{o_que_muda}}<br><br>Por favor, confira e, se algo não estiver como esperado, é só responder a esta mensagem: o chamado volta para a nossa equipe."                   |

O `aguardando_publicacao` **não promete aviso futuro** ("avisaremos quando…"): no modo `resolvido`, o chamado pode auto-fechar antes da publicação (X-6), e um chamado fechado não aceita mais mensagens. Quem quer avisar na publicação usa `aguardar_deploy`. `{{primeiro_nome}}` vem de `solicitante_nome`.

---

## 11. Extensões da API: ADR D-036 (F-19)

O D-036 vive em `specs/decisoes.md` do Chamados e registra o nascimento da Forja mais as extensões L1–L4. Não há migration, porque todos os campos e services já existem.

Cada extensão segue o padrão D-028/D-032/D-035: rota fina (`exigirContexto` → `resolverIdChamado` → `comDespacho(service de domínio)` → `respostaDeMotivo`), o mesmo `autorizar()`, RLS, entrada na **spec 11**, `CHANGELOG.md` e **smoke cross-tenant** em `smoke:api` (`apps/mcp/src/scripts/smoke-api.ts` [V: existe]), conforme a regra 6 do CLAUDE.md.

O MCP do Chamados **não** ganha ferramentas de escrita para L1/L4: os agentes nunca escrevem. Os campos novos (L2) passam por `chamado_obter`/`chamados_listar` sem mudança.

> RESOLVIDO (2026-10-02): U-6 = **sim**. L1–L4 foram entregues antes do M5 (`smoke:api` §13 passando contra o Chamados local, cross-tenant com mesmo número de chamado). Desvios: o `cliente` recebe `403` antes da resolução do `{ref}` em `/ia` e `/atribuicao` (não vaza existência); `atribuirOperador` exige alvo **ativo**; `?complexidade=` inválido dá `400` mesmo para `cliente` (o `403` vem depois). O modo sem D-036 (§2.5) continua para servidores antigos.

### 11.1 L1 — `POST /api/v1/chamados/{ref}/ia`

> **(FJ-031, 2026-10-03)** A Forja **não chama** esta rota (não silencia nem reativa a IA do servidor). Ela continua na API para o painel e o MCP; a presença de `ia_silenciada` no item da lista ainda detecta a D-036 (§2.5).

| Item        | Contrato                                                                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpo       | `{ "silenciada": true \| false }`                                                                                                                                                                                                                                          |
| Sucesso     | `200 { "ia_silenciada": <bool> }`. **Idempotente**: repetir o mesmo valor é no-op, sem evento [V: `definirSilencioIa`, `chamado-service.ts:746-769`]                                                                                                                       |
| Service     | `definirSilencioIa(em, ator, id, silenciada, hooks)`, o mesmo do painel (`app/chamados/actions.ts`) [V]                                                                                                                                                                    |
| Autorização | `autorizar(ator, 'chamado', 'silenciar_ia', {tenant_id})`: operador/admin sim; `cliente` e `agente_ia` não [V: `autorizacao.ts:135`, D-024]                                                                                                                                |
| Erros       | JSON malformado → `400 corpo_invalido`; `silenciada` ausente ou não booleana → `400 parametro_invalido`; `401 nao_autenticado`; `403 sem_permissao`; `404 chamado_inexistente`; `409 estado_terminal`                                                                      |
| Efeitos     | Evento `ia_silenciada`/`ia_reativada` (interno). Sem notificação e sem webhook                                                                                                                                                                                             |
| Junto       | `ia_silenciada` passa a vir no **item da lista** (só equipe; já está em `ChamadoView` [V: 02 §1.3]). É o campo que a Forja usa para detectar a D-036                                                                                                                       |
| Spec 11     | §4 (tabela de endpoints), nova §4.8, §4.1 (campo na lista), §5 (linha "Silenciar/reativar IA": admin ✅, operador ✅, cliente ❌), §8 (sai "silenciar IA" do fora de escopo)                                                                                               |
| Smoke       | Token do tenant A com o UUID de um chamado de B → `404`. Mesmo **número** existente em A e B → muda só o de A (conferido com a conexão admin). `cliente` → `403`. Terminal → `409`. Repetição → `200` e nenhum evento novo. Item da lista do `cliente` sem `ia_silenciada` |

### 11.2 L2 — campos na projeção

| Item    | Contrato                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Campos  | `sistema_alvo_id`, `categoria_id`, `operador_id` (UUID ou `null`) no **item da lista** (`projetarItemLista`) e no **detalhe** (`projetarDetalhe`)                                                                              |
| Escopo  | **Só equipe**, pelo mesmo predicado que já esconde `complexidade` do cliente (`ehEquipe`) [V: `api-chamados.ts:166-209,352`]                                                                                                   |
| Custo   | Zero queries novas: os valores já estão em `ChamadoView` [V: 02 §6 L2]                                                                                                                                                         |
| Spec 11 | §4.1 (lista de campos) e §4.2 (exemplo). Aproveita para documentar as divergências D3 (`categoria_nome`, `resolvido_em`, `fechar_automaticamente_em`, `fechado_em`, `reaberto_count`) e D4 (parâmetro desconhecido é ignorado) |
| Smoke   | A lista de A nunca traz ids de B; a resposta do `cliente` não tem `operador_id`, `sistema_alvo_id` nem `categoria_id`                                                                                                          |

### 11.3 L3 — filtro `complexidade`

| Item          | Contrato                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parâmetro     | `?complexidade=facil,medio` (CSV de valores do enum, como `status`). Chamados com complexidade `null` ficam fora quando o filtro está presente                       |
| Implementação | `parsearFiltros` + `FiltrosChamado.complexidade` + um `andWhere` em `listarChamados` [V: 02 §6 L3]                                                                   |
| Autorização   | **Recusado para `cliente`** com `403 sem_permissao`: o filtro revelaria o campo interno pelo conjunto do resultado (specs/04 §3.3). O predicado é o mesmo `ehEquipe` |
| Erros         | Valor fora do enum → `400 parametro_invalido`; `cliente` → `403 sem_permissao`                                                                                       |
| Spec 11       | §4.1 (parâmetro + regra do cliente) e §5 (linha "Filtrar por complexidade")                                                                                          |
| Smoke         | `?complexidade=facil` em A não traz chamados de B; `cliente` → `403`; `?complexidade=xyz` → `400`                                                                    |

### 11.4 L4 — `POST /api/v1/chamados/{ref}/atribuicao`

| Item           | Contrato                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpo          | `{ "operador_id": "<uuid>" \| null }`. `null` desatribui                                                                                                                                                                                                                                          |
| Sucesso        | `200 { "operador_id": <uuid \| null> }`                                                                                                                                                                                                                                                           |
| Service        | `atribuirOperador(em, ator, id, operadorId, hooks)` / `desatribuirOperador(em, ator, id, hooks)` [V: `chamado-service.ts:624-673`]                                                                                                                                                                |
| Autorização    | `autorizar(ator, 'chamado', 'atribuir')`: operador/admin [V: `autorizacao.ts:127`]. O alvo precisa ser `operador`/`admin` não excluído; senão o motivo é `operador_invalido`                                                                                                                      |
| Erros          | JSON malformado → `400 corpo_invalido`; chave ausente ou UUID malformado → `400 parametro_invalido`; `operador_invalido` → **`400 parametro_invalido`** (é preciso um `case` novo em `respostaDeMotivo`, que hoje cairia em `409 conflito` [V: `api-v1.ts`]); `403`; `404`; `409 estado_terminal` |
| Efeitos        | Evento `operador_atribuido`/`operador_desatribuido` → notificação `atribuicao` (obrigatória para o operador) e webhook `atribuicao` [V: `tipos.ts`]. O service **não** é idempotente: reatribuir ao mesmo operador gera outro evento. A Forja só chama quando o valor muda                        |
| Uso pela Forja | Atribui a si (`usuario.id` do login) no início. Se o chamado está atribuído a **outra pessoa**, o G0 mostra "atribuído a <nome>" e só reatribui com confirmação. Ao descartar, restaura o valor anterior se foi ela que mudou. Ao concluir, mantém                                                |
| Spec 11        | §4 (tabela), nova §4.9, §5 (linha "Atribuir"), §8 (sai "atribuição" do fora de escopo)                                                                                                                                                                                                            |
| Smoke          | `operador_id` de um usuário do tenant B, com token de A → `400` (a busca do usuário roda sob RLS e não o encontra); `{ref}` de B → `404`; `cliente` → `403`; `null` desatribui; `agente_ia` não tem token (não se aplica)                                                                         |

### 11.5 L7 — anexos por multipart (pendente)

> DECISÃO PENDENTE: aceitar `multipart/form-data` em `POST …/mensagens` (`visibilidade`, `corpo`, `arquivos[]` → `criarMensagem({anexos})`, que já valida magic bytes, a quantidade máxima e 25 MB [V: 02 §6 L7]) para anexar o PDF do relatório e prints do e2e. Isso reverte o "sem upload" de D-035/spec 11 §8 e exige **ADR próprio**, fora do D-036. Até lá, o relatório entra como markdown na nota interna (≤ 50.000 caracteres, sem imagens).

**Prioridade: logo após o MVP** (FJ-026, 2026-10-02). Deixou de ser "só se houver demanda": os prints antes/depois de alteração de interface já existem na Forja desde o M4, e a L7 é o que permite anexá-los à nota interna de conclusão (o par de PNGs por tela, como anexos de nota `interna`, nunca na pública). O conteúdo do contrato acima não muda; muda a ordem em `08-roadmap.md`.

### 11.6 O que não fazer

- **Não criar status "em implementação"** (L5). Mudaria o enum canônico (specs/02), a máquina, o painel e as notificações. `em_atendimento` + nota interna `[forja:…:inicio]` + L4 + L1 cobrem.
- **Não abrir CORS** (L13). O cliente da API é o backend da Forja.
- **Não mover a validação de linguagem para o servidor** (L11). A API serve humanos, que podem querer escrever termos técnicos.
- **Não depender de token de aplicação.** Ele segue como DECISÃO PENDENTE da spec 11 §8; a sessão de 8 h deslizante basta para o uso diário (L10).
- **Não usar `?complexidade=` antes da D-036** como se filtrasse (D4). Não tratar `409 transicao_invalida` como "já estava" sem o `GET` prévio.

---

## 12. O que fica exposto (decisões do usuário)

Os agentes rodam sem sandbox, com `--dangerously-skip-permissions` (U-3, DECIDIDO 2026-10-02):

- **Exposto:** um script ou teste escrito por agente a partir de um chamado malicioso pode ler o que o usuário lê. Isso inclui o keyring desbloqueado da sessão e, se não estiver negado, o diretório de dados da Forja, onde fica o token cifrado.
- **Exposto também (FJ-030):** o token no env do processo do MCP somente leitura (§2.6), legível por um script do agente.
- **Compensa:** o token nunca está no env do `claude` (F-05); o `Read` dos caminhos sensíveis do diretório de dados da Forja está em `deny`, que vale em bypass contra a ferramenta Read [V: F-04; lista em `05-seguranca.md` §4.4]; e a sessão do Chamados é revogável no painel. O efeito de um vazamento fica limitado ao papel `operador` de um único tenant.

O detalhe está em `05-seguranca.md`.

---

## 13. Critérios de aceite

Spike **S7**, no Chamados local (`http://localhost:3000` + `x-tenant-slug`):

1. A pergunta da Forja chega ao cliente: 1 e-mail no Mailpit.
2. A resposta do cliente, com a IA silenciada, leva o chamado a `em_triagem` (F14).
3. O polling detecta a mensagem nova em ≤ 3 min, embora `updated_at` da lista não mude.
4. "Replanejar" move o chamado para `em_atendimento` (F15).
5. O outbox publica nota → pública → `resolvido`: **exatamente 2 e-mails**.
6. Matar a Forja entre os passos 1 e 2 e reiniciar **não** duplica a nota nem a pública. Isso prova a normalização (X-4).
7. A detecção de duplicata funciona sobre o corpo normalizado devolvido em `?formato=markdown`.

Testes unitários (`vitest.config.ts` da raiz):

- o classificador de notas (§4) com as saídas reais dos construtores de `@chamados/shared`;
- a cadeia de status (§5) para todos os status × destino, via `transicaoValida`;
- o léxico com "próxima" (aceito) e "o PR foi aprovado" (reprovado);
- as três mensagens-modelo (§10) aprovadas.

Conexão:

- `127.0.0.1` é recusado com mensagem explicativa;
- `401` provoca exatamente 1 relogin;
- `429` bloqueia novos logins por 300 s.

D-036 (no repo do Chamados): os quatro smokes de §11 passam em `npm run smoke:api`, mais `npm run smoke:rls`.
