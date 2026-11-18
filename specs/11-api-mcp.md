# 11 — API HTTP e servidor MCP

Este documento especifica a **API HTTP** da plataforma **Chamados** (`/api/v1`) e o **servidor MCP** que a consome, permitindo que um assistente (Claude Code, Claude Desktop ou qualquer cliente MCP) leia chamados, leia a timeline — mensagens públicas **e** notas internas, conforme o papel —, publique mensagens, mude o status, **abra chamados** (D-032) e **acesse os anexos** — imagens e arquivos — do chamado (D-035).

Escopo relacionado, não duplicado aqui:

- Autenticação, sessões e matriz de permissões: `03-autenticacao-perfis-permissoes.md`.
- Ciclo de vida do chamado, máquina de estados, visibilidade de mensagem: `04-chamados.md`.
- Isolamento por tenant (RLS) e resolução de tenant: `02-modelo-de-dados.md`, `07-multitenancy-whitelabel.md`.
- Ameaças, hardening e LGPD: `09-seguranca-lgpd.md`.
- O `agente_ia` e suas ferramentas MCP **internas** (worker): `05-agente-ia.md` — nada a ver com este documento (lá o MCP é consumido pelo worker; aqui é oferecido a um cliente externo).

Decisões de origem: **D-028** (API + MCP), **D-032** (criação de chamado), **D-035** (anexos e formato rico) e **D-036** (extensões mínimas para a Forja — L1 silenciar IA, L2 ids na projeção, L3 filtro `complexidade`, L4 atribuição) e **D-043** (estimativa de custo e custo final) em `specs/decisoes.md`. O contrato de uso pela Forja está em `specs/forja/07-integracao-chamados.md` §11.

---

## 1. Princípios

1. **A API não é um bypass.** Todo endpoint passa pelo MESMO `autorizar()` (specs/03 §8), pelos MESMOS services de domínio e pela MESMA RLS da UI. Não existe caminho "de máquina" com mais poder que o humano equivalente: o token pertence a um `Usuario` real, com o papel dele.
2. **Só login e senha.** Nenhuma credencial nova, nenhum token de API paralelo, nenhum segredo adicional para gerir. A API autentica com e-mail + senha do próprio usuário e devolve uma **sessão server-side** (`Sessao`, specs/02) — a mesma entidade revogável do cookie, apenas transportada em header.
3. **Leitura primeiro.** A superfície de escrita é deliberadamente pequena: publicar mensagem, mudar status, **abrir chamado** (D-032 — o mesmo formulário mínimo do portal, specs/04 §2) e, para integradores da equipe, **silenciar/reativar a IA** e **atribuir** um chamado (D-036 — os mesmos botões do painel). Nada de gerenciar usuários, mexer em branding, sistemas-alvo ou na configuração da IA por esta API.
4. **Sem CSRF por construção.** A API aceita **apenas** `Authorization: Bearer`; o cookie de sessão do navegador **não** autentica `/api/v1`. Um site malicioso não consegue agir em nome do usuário logado no portal, porque o navegador não anexa o header sozinho.
5. **Formato pensado para LLM.** Respostas em JSON compacto com o corpo das mensagens em **texto puro** por default (projeção do HTML sanitizado) — menos tokens, menos ruído, nenhuma tag para o modelo interpretar. Quando a estrutura ou as imagens importam, o consumidor pede `?formato=markdown` (gerado do documento fonte, imagens como `![alt](url)` no lugar em que o autor as colou) ou `?formato=html` (o HTML já sanitizado na escrita). Os **anexos** são sempre listados com metadados e baixados por rota própria (§4.7) — nunca embutidos em base64 no JSON.

---

## 2. Autenticação

### 2.1 Abrir sessão

`POST /api/v1/sessao` — corpo `{ "email": "...", "senha": "..." }`.

- Usa `autenticarComSenha` (specs/03 §4.1): Argon2id, verificação em tempo constante, `agente_ia` nunca autentica por aqui (senha nula), tenant `suspenso`/`cancelado` bloqueia.
- **Rate limiting** idêntico ao do login da UI (`consumirRateLimit('login', …)`, chaves `tenant+IP` e `tenant+e-mail`, fail-open — specs/03 §4.1).
- **Anti-enumeração**: falha sempre com `401` e a mesma mensagem genérica, sem distinguir "conta não existe" de "senha errada".
- Sucesso `200`:

```json
{
  "token": "<token opaco da sessão>",
  "expira_em": "2026-08-08T12:00:00.000Z",
  "usuario": { "id": "…", "nome": "…", "email": "…", "papel": "operador" },
  "tenant": { "slug": "acme", "nome_exibicao": "ACME" }
}
```

O `token` é o MESMO token opaco do cookie (só o `token_hash` vive no banco). Vale a duração de sessão da spec 03 §4.4 (idle + absoluta) e é revogável.

### 2.2 Usar a sessão

Todo endpoint autenticado exige `Authorization: Bearer <token>`. A validação usa `carregarSessao` **dentro do contexto do tenant resolvido** — um token de outro tenant nunca resolve (specs/03 §3). Token ausente/expirado/revogado → `401` com código `nao_autenticado`; cabe ao cliente reautenticar.

### 2.3 Encerrar sessão

`DELETE /api/v1/sessao` revoga a sessão corrente (`revogarSessaoPorToken`). Idempotente: sempre `204`.

---

## 3. Resolução de tenant

Igual ao resto da aplicação (specs/07 §3.4): o tenant vem do **host** — domínio próprio ou subdomínio (`acme.chamados.app`). Em desenvolvimento, onde o host é `localhost:3000`, vale o mesmo fallback já existente no proxy: header `x-tenant-slug: <slug>` (ou `?tenant=<slug>`).

Host que não resolve tenant → `404` com código `tenant_desconhecido`, sem revelar a lista de tenants.

---

## 4. Endpoints

| Método   | Rota                                | Papéis                | O que faz                                    |
| -------- | ----------------------------------- | --------------------- | -------------------------------------------- |
| `POST`   | `/api/v1/sessao`                    | público               | Login por e-mail + senha → token             |
| `DELETE` | `/api/v1/sessao`                    | autenticado           | Revoga a sessão corrente                     |
| `GET`    | `/api/v1/chamados`                  | todos (escopo abaixo) | Lista/filtra chamados                        |
| `GET`    | `/api/v1/chamados/{ref}`            | todos (escopo abaixo) | Chamado + timeline                           |
| `POST`   | `/api/v1/chamados/{ref}/mensagens`  | todos (escopo abaixo) | Publica mensagem `publica` ou nota `interna` |
| `POST`   | `/api/v1/chamados/{ref}/status`     | todos (escopo abaixo) | Transiciona o status                         |
| `POST`   | `/api/v1/chamados`                  | todos (escopo abaixo) | Abre um chamado (D-032)                      |
| `GET`    | `/api/v1/sistemas-alvo`             | todos                 | Sistemas-alvo ativos (id, nome, descrição)   |
| `GET`    | `/api/v1/anexos/{id}`               | todos (escopo abaixo) | Bytes de um anexo (imagem/arquivo) — D-035   |
| `POST`   | `/api/v1/chamados/{ref}/ia`         | operador/admin        | Silencia/reativa a IA no chamado — D-036 L1  |
| `POST`   | `/api/v1/chamados/{ref}/atribuicao` | operador/admin        | Atribui/desatribui o operador — D-036 L4     |

`{ref}` aceita o **UUID** ou o **número** do chamado (`12` ou `#12`) — o número é como a equipe se refere ao chamado no dia a dia. A resolução por número é escopada ao tenant pela RLS (`UNIQUE (tenant_id, numero)`).

### 4.1 `GET /api/v1/chamados`

Query params, todos opcionais: `status` (aceita lista separada por vírgula), `natureza`, `prioridade`, `complexidade` (lista separada por vírgula, como `status` — **só equipe**, D-036 L3), `atribuicao` (`atribuido` | `nao_atribuido` | `<uuid do operador>` — **só equipe**: o responsável é interno; `cliente` recebe `403 sem_permissao`), `sistema_alvo_id`, `categoria_id`, `busca` (número ou full-text — specs/04 §10.4), `meus` (`true` | `false` — D-037), `limite` (1–100, default 20), `cursor`.

**`meus` (D-037)** recorta para os chamados em que o **usuário autenticado é o solicitante**. Default `false`: sem o parâmetro, a lista é todo o escopo do papel — para o `cliente`, desde a D-037, **todos os chamados do tenant** na visão pública. O default difere do portal (que abre em "Meus chamados") de propósito: na API, "sem filtro" significa "tudo o que o papel alcança", como em qualquer outro filtro. Vale para qualquer papel (para a equipe, que abre chamados em nome de clientes, costuma vir vazio — o recorte de "minha fila" é `atribuicao=<uuid>`). Valor diferente de `true`/`false` → `400 parametro_invalido`.

Valor inválido de enum é **rejeitado** com `400 parametro_invalido` (nunca silenciosamente ignorado — filtro que mente é pior que erro). Parâmetro **desconhecido** é ignorado (não é filtro do contrato); quem integra não deve presumir que um parâmetro novo filtra antes de ele constar aqui.

**`complexidade` (D-036 L3)** é atributo interno (specs/04 §3.3): filtrar por ele revelaria o campo ao cliente pelo conjunto do resultado. Por isso o `cliente` que o envia recebe `403 sem_permissao` — recusa explícita, pelo mesmo critério (`ehEquipe`) que esconde o campo na projeção; o serviço `listarChamados` ainda o ignora para o cliente, como rede de segurança. Com o filtro presente, chamados de complexidade `null` (ainda não classificados) ficam de fora.

Resposta: `{ "itens": [...], "proximo_cursor": "…" | null }`. Cada item é uma **projeção compacta** (sem a descrição, que só vem no detalhe): `id`, `numero`, `titulo`, `status`, `natureza`, `prioridade`, `complexidade` (só equipe), `operador_nome` (só equipe), `solicitante_nome`, `sistema_nome`, `categoria_nome`, `estimativa_custo` (código `A`–`E`/`I` ou `null`) e `custo_final` (número em BRL ou `null`) — **para todos os papéis, inclusive o cliente (D-043)** —, `created_at`, `updated_at` e, **só para a equipe (D-036)**, `ia_silenciada` (L1), `sistema_alvo_id`, `categoria_id` e `operador_id` (L2, UUID ou `null`). Os ids existem para quem integra (o nome de um sistema-alvo muda; o id não) e não custam query nova — já estão na view do chamado. A view do cliente traz `sistema_alvo_id`/`categoria_id` (ele os escolhe no formulário), mas a API **não** os repassa: o cliente recebe os nomes.

### 4.2 `GET /api/v1/chamados/{ref}`

Query param opcional `formato` = `texto` (default) | `markdown` | `html` (§1.5). Valor fora disso → `400 parametro_invalido`.

Resposta: o chamado (com `descricao` no formato pedido e os **anexos da descrição**) + `mensagens`, em ordem cronológica, cada uma com os **seus anexos**:

```json
{
  "chamado": {
    "id": "…",
    "numero": 12,
    "titulo": "…",
    "status": "em_atendimento",
    "natureza": "problema",
    "prioridade": "alta",
    "complexidade": "facil",
    "estimativa_custo": "B",
    "custo_final": null,
    "ia_silenciada": false,
    "sistema_alvo_id": "…",
    "categoria_id": null,
    "operador_id": "…",
    "descricao": "…",
    "formato": "texto",
    "anexos": [
      {
        "id": "…",
        "nome_arquivo": "imagem-colada.png",
        "content_type": "image/png",
        "tamanho_bytes": 48211,
        "inline": true,
        "url": "/api/v1/anexos/…"
      }
    ],
    "solicitante_nome": "…",
    "operador_nome": "…",
    "sistema_nome": "…",
    "categoria_nome": null,
    "created_at": "…",
    "updated_at": "…",
    "resolvido_em": null,
    "fechar_automaticamente_em": null,
    "fechado_em": null,
    "reaberto_count": 0
  },
  "mensagens": [
    {
      "id": "…",
      "autor_nome": "…",
      "autor_papel": "cliente",
      "visibilidade": "publica",
      "corpo": "…",
      "anexos": [
        {
          "id": "…",
          "nome_arquivo": "erro.log",
          "content_type": "text/plain",
          "tamanho_bytes": 1024,
          "inline": false,
          "url": "/api/v1/anexos/…"
        }
      ],
      "created_at": "…"
    }
  ]
}
```

- **`anexos`** (D-035) inclui tanto arquivos anexados à parte (`inline: false`) quanto imagens coladas no rich text (`inline: true`). Em `texto` a imagem some do corpo (como sempre) mas continua listada; em `markdown`/`html` ela aparece no lugar em que foi colada, com a `src` reescrita para `/api/v1/anexos/{id}` — a rota que um cliente da API consegue seguir com o mesmo Bearer (a `/api/anexos/` da UI autentica por cookie).
- A lista vem de `listarAnexosVisiveis`, alimentada **só** com os ids das mensagens que `listarMensagens` já devolveu ao papel: anexo de nota interna nunca chega ao cliente, por construção — não há filtro paralelo para desalinhar.

O detalhe traz tudo o que o item da lista traz (§4.1) mais a descrição, os anexos e as datas do ciclo de vida (`resolvido_em`, `fechar_automaticamente_em` — num `resolvido`, o **prazo para o cliente aprovar ou contestar** (D-042); vencido sem resposta, o chamado é fechado por aprovação tácita —, `fechado_em`, `reaberto_count`). Vem também para o `cliente`.

`complexidade`, `ia_silenciada`, os ids de L2 (`sistema_alvo_id`, `categoria_id`, `operador_id` — D-036) e as mensagens `interna` (com seus anexos) **só existem na resposta para operador/admin** — para o `cliente` a query nem as traz (filtro no repositório, `listarMensagens`) e o serializer as remove (specs/03 §7). Chamado inexistente **ou** fora do escopo do papel → `404` idêntico (não vaza existência).

### 4.3 `POST /api/v1/chamados/{ref}/mensagens`

Corpo: `{ "visibilidade": "publica" | "interna", "corpo": "<markdown>" }`.

- O corpo é **markdown**, convertido pelo mesmo `markdownParaDoc` usado nas respostas da IA e submetido ao MESMO pipeline de validação/sanitização do editor (specs/04 §5) — nada de HTML cru.
- `interna` exige operador/admin; cliente recebe `403` (fronteira inegociável, specs/03 §7).
- Estados terminais (`fechado`/`cancelado`) recusam mensagens (`409 estado_terminal`, specs/04 §1.1) — para escrever, reabra antes (§4.4, D-038).
- Dispara os MESMOS efeitos da UI (`comDespacho`): notificações e, quando é resposta pública de cliente, re-enfileiramento da triagem (specs/05 §2).
- **Contestação (D-042):** mensagem `publica` do cliente solicitante num chamado `resolvido` é a **contestação** da solução — o chamado volta a `em_atendimento` com evento `chamado_contestado` (`reaberto_count` + 1), notificação `contestado` à equipe e webhook `contestado` (o corpo vira o `mensagem.trecho`).
- **Quem responde fica responsável (D-039, specs/04 §7.1):** mensagem `publica` de operador/admin torna o usuário do token o responsável (`operador_id`), substituindo o anterior, na mesma transação — evento `operador_atribuido` (ator = autor, `dados.motivo = "resposta_publica"`) e webhook `atribuicao`, como em §4.9; sem e-mail ao próprio autor. Se o token já é o responsável, nada muda (sem evento). Nota `interna` não atribui. Consequência para integradores (MCP, Forja): publicar em público "assume" o chamado — quem só quer comentar sem assumir usa `interna`. A resposta não muda (`201 { "id" }`); confira o `operador_id` no detalhe.
- Sucesso `201`: `{ "id": "…" }`.

### 4.4 `POST /api/v1/chamados/{ref}/status`

Corpo: `{ "status": "<status canônico>", "motivo": "<opcional>", "custo_final": <opcional> }`.

**Custo final ao resolver (D-043):** `custo_final` (número em reais, ≥ 0, até 2 casas, ou `null` para limpar) só é aceito com `"status": "resolvido"` — em qualquer outra transição → `400 parametro_invalido` (nunca ignorado em silêncio); string (ex.: `"150,00"`) → `400`. Só a equipe: `cliente`/`agente_ia` → `403` (o domínio nega antes de escrever). Mudou o valor → evento `custo_final_definido` com `origem: 'resolucao'` (sem webhook próprio: o webhook `resolvido` já traz `chamado.custo_final`). Omitido → o custo atual não muda. Para corrigir depois, §4.10.

Delega a `transicionarStatus`: a **máquina de estados** (specs/04 §1.3) decide, com o papel do token. Transição inválida → `409` com o motivo de domínio (ex.: `transicao_invalida`, `papel_nao_pode`); sem permissão → `403`. O evento de auditoria sai com o `motivo` informado, como em qualquer mudança pela UI.

**Reabertura (D-038):** `{"status": "em_atendimento"}` reabre um chamado `fechado` ou `cancelado` — operador/admin em qualquer chamado do tenant, `cliente` só nos que solicitou (alheio → `403 sem_permissao`; de outro tenant → `404`) — e um `resolvido` pela equipe. Efeitos iguais aos da UI: `chamado_reaberto`, `reaberto_count` + 1, datas de resolução/fechamento limpas, notificação `reaberto`; não dispara triagem.

**Janela de aprovação (D-042):** num `resolvido`, o `cliente` solicitante **aprova** com `{"status": "fechado"}` → evento `chamado_aprovado`, `fechado_em` gravado, webhook `aprovado` (`forma: 'explicita'`). **Contestar** exige motivo: `{"status": "em_atendimento"}` do cliente num `resolvido` responde `409 motivo_obrigatorio` — publique o motivo em `POST …/mensagens` (§4.3), que reabre. Cliente alheio → `403`; outro tenant → `404`; `agente_ia` → `403`. Operador/admin fechando um `resolvido` é fechamento manual (`chamado_fechado`, webhook `fechado`), não aprovação. A partir de `fechado`/`cancelado` qualquer outro destino continua `409 estado_terminal`. O MCP `chamado_alterar_status` herda a regra (mesma rota).

Sucesso `200`: `{ "status": "resolvido", "custo_final": 150.5 | null }`.

### 4.5 `POST /api/v1/chamados` (D-032)

Abre um chamado com o **mesmo formulário mínimo** do portal (specs/04 §2). Corpo:

```json
{
  "titulo": "Impressora parou",
  "descricao": "Não imprime **desde ontem**.\n\n- fila travada",
  "natureza": "problema",
  "prioridade": "alta",
  "sistema_alvo_id": "…",
  "solicitante_email": "ana@cliente.com"
}
```

| Campo                                  | Obrigatório | Regra                                                                                                                                                                                                       |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `titulo`                               | sim         | 3–160 caracteres (limite do domínio, specs/04 §4).                                                                                                                                                          |
| `descricao`                            | sim         | **Markdown**, pelo mesmo `markdownParaDoc` + pipeline de validação/sanitização das mensagens (§4.3). Nunca HTML cru.                                                                                        |
| `natureza`                             | não         | `problema` \| `alteracao` \| `duvida`. Omitida → `problema`, e a IA reclassifica na triagem (D-017, mesma regra do portal).                                                                                 |
| `prioridade`                           | não         | Omitida → `media`.                                                                                                                                                                                          |
| `sistema_alvo_id` / `categoria_id`     | condicional | Um **ou** outro. Regra de specs/04 §2 aplicada pelo serviço: 1 sistema ativo → preenchido sozinho; 0 → categoria geral; >1 sem escolha → `409 sistema_alvo_obrigatorio` (liste-os em `GET /sistemas-alvo`). |
| `estimativa_custo`                     | não         | D-043: `A`–`E`/`I` (faixas em specs/04 §3.4). Só equipe — `cliente` → `403`. Código desconhecido → `400`.                                                                                                   |
| `solicitante_email` / `solicitante_id` | condicional | **Quem abre EM NOME DE quem.** Obrigatório (um ou outro) para operador/admin; proibido para `cliente` (abre para si → `403` se informar). O solicitante precisa ser conta **ativa** com papel `cliente`.    |

- Delega a `criarChamado`: `autorizar()` decide (cliente cria o próprio; operador/admin em nome de um cliente; `agente_ia` nunca — specs/03 §8.1), o serviço valida limites e resolve o alvo. A rota não reimplementa nada disso.
- `solicitante_email` é resolvido **dentro do contexto do tenant** (RLS): e-mail de outro tenant nunca resolve. É o campo natural para um assistente — ele conhece o e-mail do cliente, não o UUID.
- Dispara os MESMOS efeitos da UI (`comDespacho`): `EventoChamado` de criação, notificação de "chamado criado" e, se a triagem está ativa no tenant, a transição `novo → em_triagem` pelo `sistema` + enfileiramento da triagem (specs/05 §2). Um chamado aberto pela API não é de segunda classe.
- **Sem anexos**: a API aceita só texto (markdown). Imagem/arquivo continua sendo pelo portal (§8).

Sucesso `201`: `{ "id": "…", "numero": 42 }` — o número é como a equipe passa a se referir ao chamado.

### 4.6 `GET /api/v1/sistemas-alvo`

Resposta: `{ "sistemas": [{ "id", "nome", "descricao" }], "sistema_alvo_obrigatorio": true | false }` — só os sistemas **ativos** e só os campos que o formulário de abertura já mostra a qualquer papel (portal do cliente inclusive). Nada de repositório, logs, BD ou credenciais: isso é `sistema_alvo · ler` (equipe, specs/03 §8.2) e **não** passa por esta rota.

`sistema_alvo_obrigatorio` vem calculado com a mesma regra de `criarChamado` (>1 sistema ativo), para o cliente da API não ter de deduzi-la.

### 4.7 `GET /api/v1/anexos/{id}` (D-035)

Entrega os **bytes** do anexo. Autentica por Bearer e autoriza com o MESMO `autorizarDownloadAnexo` da rota de cookie (specs/04 §6): RLS isola o tenant, cliente baixa de qualquer chamado do seu tenant (D-037 — a leitura acompanha `chamado · ler`), anexo de nota `interna` nunca sai para cliente. Qualquer negação → `404 anexo_inexistente` (não vaza existência).

Diferença deliberada da rota da UI: os bytes saem **pela aplicação** (`obterObjeto`), não por redirect a URL assinada do storage. O consumidor é um processo (servidor MCP) que muitas vezes não alcança o bucket (MinIO interno à VPS) e cujo `fetch` descarta o `Authorization` num redirect cross-origin. Os controles de specs/09 §5 se mantêm: `Content-Type` pinado ao tipo validado no upload, `Content-Disposition` seguro (`inline` só para imagem, `attachment` para o resto, nome em RFC 5987), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Não há **upload** por esta API (§8).

### 4.8 `POST /api/v1/chamados/{ref}/ia` (D-036 L1)

Silencia (`true`) ou reativa (`false`) a IA no chamado — o mesmo botão do painel (D-024). Existe para um integrador da equipe (a Forja, `specs/forja/07-integracao-chamados.md` §7) tirar a triagem automática do caminho enquanto implementa: uma mensagem do cliente re-dispara a triagem (specs/05 §2), que poderia responder ao cliente, gerar SPEC nova e abrir PR concorrente.

Corpo: `{ "silenciada": true | false }` — booleano JSON; `"true"`/`1` são recusados (`400 parametro_invalido`).

- Delega a `definirSilencioIa`, o MESMO serviço do painel: `autorizar(chamado · silenciar_ia)` — operador/admin sim, `cliente` e `agente_ia` nunca (a IA não silencia/reativa a si mesma).
- **Idempotente**: repetir o valor atual é no-op, sem `EventoChamado` novo (comportamento do serviço).
- Terminais (`fechado`/`cancelado`) recusam: `409 estado_terminal`.
- Efeito: evento `ia_silenciada`/`ia_reativada` (interno). Sem notificação, sem webhook.
- **Silenciar cancela a triagem em andamento (D-041):** pós-commit, a triagem que estiver rodando no chamado é interrompida (sinal Redis + releitura da flag antes de aplicar) e os jobs pendentes dele saem da fila — nada daquela análise é aplicado (nenhuma mensagem ao cliente, classificação, SPEC ou PR); a `ExecucaoIA` fica `cancelado` e o chamado em `em_triagem` vai a `em_atendimento` com nota interna. Detalhe em specs/05 §2. A resposta não muda. Reativar não reanalisa.
- O `cliente` recebe `403 sem_permissao` **antes** da resolução do `{ref}` (o mesmo `autorizar()`, consultado na rota): responder 403 para chamado existente e 404 para inexistente vazaria a existência de chamados alheios.

Sucesso `200`: `{ "ia_silenciada": true | false }`.

### 4.9 `POST /api/v1/chamados/{ref}/atribuicao` (D-036 L4)

Atribui o chamado a um operador (`"operador_id": "<uuid>"`) ou o desatribui (`"operador_id": null`) — o mesmo seletor do painel (specs/04 §7). É como um integrador marca quem está implementando, sem status novo.

Corpo: `{ "operador_id": "<uuid>" | null }`. A **chave é obrigatória**: um corpo sem ela é `400 parametro_invalido` (nunca desatribui por omissão). Valor que não é UUID nem `null` → `400 parametro_invalido`.

- Delega a `atribuirOperador`/`desatribuirOperador`: `autorizar(chamado · atribuir)` — operador/admin; `cliente` → `403` (antes da resolução do `{ref}`, como em §4.8).
- O alvo precisa ser usuário **ativo**, não excluído, com papel `operador` ou `admin` — o mesmo universo que o seletor do painel oferece. Fora disso o domínio devolve `operador_invalido`, que a API traduz em **`400 parametro_invalido`** (é entrada inválida, não conflito). A busca do alvo roda sob RLS: um usuário de **outro tenant** simplesmente não é encontrado e cai no mesmo `400`.
- Terminais recusam: `409 estado_terminal`.
- Efeitos (os mesmos do painel, via `comDespacho`): `EventoChamado` `operador_atribuido`/`operador_desatribuido`, notificação `atribuicao` ao operador destino e webhook `atribuicao`.
- **Não idempotente**: reatribuir à mesma pessoa grava outro evento e notifica de novo. Quem integra compara com o `operador_id` lido antes de chamar.
- Além desta rota, a atribuição também acontece **implicitamente** quando operador/admin publica mensagem `publica` (§4.3, D-039).

Sucesso `200`: `{ "operador_id": "<uuid>" | null }`.

### 4.10 `POST /api/v1/chamados/{ref}/custo` (D-043)

Define a **estimativa de custo** e/ou o **custo final** — os mesmos serviços do painel (`definirEstimativaCusto`/`definirCustoFinal`), numa transação só.

Corpo: `{ "estimativa_custo"?: "A" | "B" | "C" | "D" | "E" | "I" | null, "custo_final"?: number | null }`. Pelo menos **uma** das chaves (senão `400`); chave ausente não mexe; `null` limpa. Código fora do domínio (inclusive minúsculo) ou custo não numérico/negativo/com mais de 2 casas → `400 parametro_invalido`.

- `autorizar(chamado · definir_custo)` — operador/admin; `cliente` → `403` **antes** da resolução do `{ref}` (como §4.8/§4.9: não vaza existência). O cliente **lê** os dois campos (§4.1/§4.2), nunca os define.
- Estimativa: qualquer status não encerrado; `fechado`/`cancelado` → `409 estado_terminal`.
- Custo final: só com o chamado em `resolvido` → senão `409 custo_fora_da_resolucao` (código novo). Recusa em qualquer parte desfaz a outra (a estimativa enviada junto não fica gravada).
- Efeitos: `estimativa_custo_alterada` / `custo_final_definido` (`{de, para}`), notificações (estimativa: opt-in; custo final: ligada por padrão) e webhooks `estimativa_custo_alterada` / `custo_final_definido`. **Idempotente:** o mesmo valor não grava evento nem dispara webhook.
- Outro tenant (RLS) → `404`.

Sucesso `200`: `{ "estimativa_custo": "B" | null, "custo_final": 120 | null }` (valores atuais).

---

## 5. Escopo por papel

A API herda integralmente a matriz de specs/03 §8.1 — não redefine nada:

| Ação                                         | admin                    | operador                 | cliente                                                                        |
| -------------------------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------ |
| Listar/ler chamados                          | tenant                   | tenant                   | tenant, visão pública¹                                                         |
| Ler mensagem `publica`                       | ✅                       | ✅                       | ✅ (tenant)¹                                                                   |
| Ler nota `interna`                           | ✅                       | ✅                       | ❌ (nem sabe que existe)                                                       |
| Ver `complexidade`                           | ✅                       | ✅                       | ❌                                                                             |
| Escrever mensagem `publica`                  | ✅                       | ✅                       | ✅ (nos próprios)                                                              |
| Escrever nota `interna`                      | ✅                       | ✅                       | ❌                                                                             |
| Mudar status                                 | ✅                       | ✅                       | ⚠️ cancelar e reabrir `resolvido`/`fechado`/`cancelado` (nos próprios — D-038) |
| Abrir chamado (D-032)                        | ✅ em nome de um cliente | ✅ em nome de um cliente | ✅ só para si                                                                  |
| Listar sistemas-alvo (§4.6)                  | ✅                       | ✅                       | ✅ (id/nome/descrição)                                                         |
| Filtrar por `complexidade`                   | ✅                       | ✅                       | ❌ (`403`) — D-036 L3                                                          |
| Ver ids de L2 / `ia_silenciada`              | ✅                       | ✅                       | ❌ — D-036 L1/L2                                                               |
| Silenciar/reativar IA (§4.8)                 | ✅                       | ✅                       | ❌ — D-036 L1                                                                  |
| Atribuir/desatribuir (§4.9)                  | ✅                       | ✅                       | ❌ — D-036 L4                                                                  |
| Ver `estimativa_custo`/`custo_final`         | ✅                       | ✅                       | ✅ — D-043                                                                     |
| Definir custo (§4.10, `custo_final` no §4.4) | ✅                       | ✅                       | ❌ (`403`) — D-043                                                             |

¹ D-037 (decisão do usuário): o cliente **lê** qualquer chamado do tenant — sem nota interna, `complexidade`, operador, `ia_silenciada` nem ids de L2 — e só **age** (escrever, mudar status) nos que solicitou; escrita em chamado alheio → `403 sem_permissao`. `meus=true` (§4.1) devolve só os dele.

O `agente_ia` não usa esta API: é service account do worker, sem senha (specs/03 §6).

---

## 6. Erros

Sempre JSON: `{ "erro": "<mensagem legível>", "codigo": "<slug estável>" }`.

| HTTP | Código                                                                                                                                  | Quando                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 400  | `corpo_invalido`, `parametro_invalido`                                                                                                  | JSON malformado, enum/valor fora do domínio; operador alvo inválido na atribuição (D-036)                   |
| 401  | `credenciais_invalidas`, `nao_autenticado`                                                                                              | login falhou; token ausente/expirado                                                                        |
| 403  | `sem_permissao`                                                                                                                         | papel não pode a ação (inclui `cliente` filtrando por `complexidade`, silenciando IA ou atribuindo — D-036) |
| 404  | `tenant_desconhecido`, `chamado_inexistente`                                                                                            | host sem tenant; chamado fora do escopo                                                                     |
| 409  | `estado_terminal`, `transicao_invalida`, `sistema_alvo_obrigatorio`, `motivo_obrigatorio` (D-042), `custo_fora_da_resolucao` (D-043), … | regra de domínio recusou                                                                                    |
| 429  | `muitas_tentativas`                                                                                                                     | rate limit do login                                                                                         |

O `codigo` é o contrato estável (o cliente decide por ele); a `mensagem` é para humanos.

---

## 7. Servidor MCP

Processo Node **stdio** (`apps/mcp`) que fala a API acima. É um cliente como outro qualquer: não acessa banco, fila nem storage, e **não** tem privilégio algum além do papel do usuário configurado.

### 7.1 Configuração

| Variável                       | Obrigatória  | Descrição                                                             |
| ------------------------------ | ------------ | --------------------------------------------------------------------- |
| `CHAMADOS_URL`                 | sim          | Base da instalação (ex.: `https://suporte.empresa.com`)               |
| `CHAMADOS_EMAIL`               | sim          | E-mail do usuário                                                     |
| `CHAMADOS_SENHA`               | uma das duas | Senha do usuário                                                      |
| `CHAMADOS_TOKEN`               | uma das duas | Token de uma sessão já aberta (`POST /api/v1/sessao`) — FJ-030        |
| `CHAMADOS_TENANT`              | não          | Slug do tenant (só onde o host não resolve — ex.: `localhost` em dev) |
| `CHAMADOS_MCP_SOMENTE_LEITURA` | não          | `true` registra apenas as ferramentas de leitura                      |

**Login preguiçoso**: a sessão é aberta na primeira ferramenta usada, mantida em memória e renovada automaticamente **uma vez** ao receber `401` (sessão expirada). A senha vive só na memória do processo e **nunca** é logada nem devolvida em mensagem de erro.

**Sessão já aberta (`CHAMADOS_TOKEN`, D-036/FJ-030 §4)**: em vez da senha, o processo recebe o token de uma sessão existente e o usa como `Bearer` sem login (`@chamados/cliente-api`: `ConfigCliente.tokenInicial`, com `obterSenha` agora opcional). É assim que a Forja dá aos seus agentes este MCP em modo somente leitura, reaproveitando o token da própria conexão. Sem senha não há relogin: se o token for recusado (`401`), toda ferramenta falha com `ErroApi` `401 sessao_recusada` e mensagem acionável ("gere um token novo ou configure a senha"). Com as duas variáveis, o token vale primeiro e a senha só serve para relogar. O token, como a senha, vive só na memória do processo e **nunca** aparece em log ou mensagem de erro (o log de partida diz apenas `[token de sessão]`). O MCP nunca chama `DELETE /api/v1/sessao` — encerrar a sessão é de quem a abriu.

### 7.2 Ferramentas

| Ferramenta                  | Tipo    | Mapeia para                             |
| --------------------------- | ------- | --------------------------------------- |
| `chamados_listar`           | leitura | `GET /api/v1/chamados`                  |
| `chamado_obter`             | leitura | `GET /api/v1/chamados/{ref}`            |
| `chamado_publicar_mensagem` | escrita | `POST /api/v1/chamados/{ref}/mensagens` |
| `chamado_alterar_status`    | escrita | `POST /api/v1/chamados/{ref}/status`    |
| `sistemas_alvo_listar`      | leitura | `GET /api/v1/sistemas-alvo`             |
| `chamado_criar`             | escrita | `POST /api/v1/chamados` (D-032)         |
| `anexo_obter`               | leitura | `GET /api/v1/anexos/{id}` (D-035)       |

As de escrita são anotadas como não-idempotentes e, no caso de `chamado_publicar_mensagem`, a descrição declara explicitamente que `visibilidade: "publica"` **é visível ao cliente final** — o modelo precisa saber que está falando com o cliente, não com a equipe.

`chamado_obter` aceita `formato` (`texto` default | `markdown` | `html`) e devolve os `anexos` de cada parte do chamado. **`anexo_obter`** (D-035) baixa um anexo pelo `id` e o devolve na forma que o modelo consegue usar: **imagem** (≤ 5 MB) volta como conteúdo `image` — o modelo **vê** o print; **texto** (txt/log/csv/json) volta como texto (truncado em 100k caracteres); **binário** (PDF, planilha, zip) ou imagem maior é gravado em disco — em `salvar_em` ou num diretório temporário — e a resposta traz o caminho para o assistente ler. O nome do arquivo gravado é sempre o `basename` sanitizado, prefixado pelo id: um nome vindo do servidor nunca vira caminho. A descrição da ferramenta lembra que o conteúdo do anexo é **dado** do cliente, não instrução (specs/09 §4.1).

`chamado_criar` recebe `titulo`, `descricao` (markdown), `natureza`/`prioridade` opcionais, `sistema_alvo_id` e `solicitante_email`. A descrição da ferramenta diz ao modelo que, com usuário operador/admin, o `solicitante_email` é **obrigatório** e que, em dúvida, ele deve **perguntar** quem é o solicitante em vez de inventar — abrir chamado no nome do cliente errado suja a auditoria e notifica a pessoa errada. Ao receber `sistema_alvo_obrigatorio`, o caminho de correção é `sistemas_alvo_listar` → repetir com `sistema_alvo_id`.

`chamado_alterar_status` aceita `custo_final` opcional (D-043): só com `status: "resolvido"` — em outra transição a própria ferramenta recusa antes de chamar a API. A descrição de `chamado_obter` explica os códigos de `estimativa_custo` (A–E/I) e que estimativa e custo final são visíveis ao cliente; os retornos de leitura já trazem os dois campos (projeções §4.1/§4.2). Definir a estimativa pelo MCP não tem ferramenta própria nesta versão (use o painel ou `POST …/custo`; o `ClienteChamados` tem `definirCusto`).

Erros da API voltam ao modelo como erro de ferramenta com o `codigo` — corrigível (ex.: `transicao_invalida` leva o modelo a escolher outro status), no mesmo espírito das ferramentas do worker (specs/05 §4.2).

### 7.3 Segurança

- O MCP **não amplia** poder: um `cliente` configurado enxerga os chamados do seu tenant só na visão pública (D-037; `chamados_listar` aceita `meus: true` para os dele), nunca notas internas, e só escreve nos que solicitou — a fronteira é server-side, não na ferramenta.
- Recomendação de instalação: usar um usuário `operador` dedicado, para que a trilha de auditoria (`EventoChamado`) distinga as ações feitas via assistente das feitas por humanos no painel.
- `CHAMADOS_URL` deve ser **HTTPS** fora de `localhost`: a senha trafega no corpo do login e o token em header.
- Conteúdo de chamado que chega ao modelo é **dado não confiável** (mesma regra de specs/05 §9 e specs/09 §4.1) — o cliente MCP não interpreta nada do corpo como instrução.

---

## 8. Fora de escopo (por ora)

- ~~**Criar chamado** pela API/MCP~~ — entrou em **D-032** (§4.5), sem anexos.
- **Upload de anexos** pela API (na abertura ou em mensagem): só texto/markdown entra por aqui; imagem e arquivo continuam pelo portal. Download e listagem entraram em **D-035** (§4.2, §4.7).
- **Eventos** (`EventoChamado`) na resposta do detalhe: a timeline de mensagens cobre o uso pretendido.
- ~~**Atribuição** e **silenciar IA**~~ — entraram em **D-036** (§4.9, §4.8), para integradores da equipe (Forja).
- **Prioridade, complexidade (escrita), reexecutar triagem**: mutações de painel, deliberadamente fora da superfície. A complexidade só se **lê** e **filtra** (equipe — §4.1).
- **Ferramentas MCP para silenciar IA e atribuir**: o MCP não as ganha (D-036) — assistentes não decidem quem atende nem desligam a triagem. Os campos novos da projeção passam por `chamados_listar`/`chamado_obter` sem mudança.
- **Streaming/transport HTTP do MCP**: só stdio, que é o modo local do Claude Code/Desktop.

> DECISÃO PENDENTE: se a API deve ganhar um **token de aplicação** de longa duração (escopo reduzido, revogável no painel) como alternativa a login/senha em variável de ambiente. Hoje o token é a própria sessão, com a duração da spec 03 §4.4.
