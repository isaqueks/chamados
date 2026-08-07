# 11 — API HTTP e servidor MCP

Este documento especifica a **API HTTP** da plataforma **Chamados** (`/api/v1`) e o **servidor MCP** que a consome, permitindo que um assistente (Claude Code, Claude Desktop ou qualquer cliente MCP) leia chamados, leia a timeline — mensagens públicas **e** notas internas, conforme o papel —, publique mensagens e mude o status.

Escopo relacionado, não duplicado aqui:

- Autenticação, sessões e matriz de permissões: `03-autenticacao-perfis-permissoes.md`.
- Ciclo de vida do chamado, máquina de estados, visibilidade de mensagem: `04-chamados.md`.
- Isolamento por tenant (RLS) e resolução de tenant: `02-modelo-de-dados.md`, `07-multitenancy-whitelabel.md`.
- Ameaças, hardening e LGPD: `09-seguranca-lgpd.md`.
- O `agente_ia` e suas ferramentas MCP **internas** (worker): `05-agente-ia.md` — nada a ver com este documento (lá o MCP é consumido pelo worker; aqui é oferecido a um cliente externo).

Decisão de origem: **D-028** (`specs/decisoes.md`).

---

## 1. Princípios

1. **A API não é um bypass.** Todo endpoint passa pelo MESMO `autorizar()` (specs/03 §8), pelos MESMOS services de domínio e pela MESMA RLS da UI. Não existe caminho "de máquina" com mais poder que o humano equivalente: o token pertence a um `Usuario` real, com o papel dele.
2. **Só login e senha.** Nenhuma credencial nova, nenhum token de API paralelo, nenhum segredo adicional para gerir. A API autentica com e-mail + senha do próprio usuário e devolve uma **sessão server-side** (`Sessao`, specs/02) — a mesma entidade revogável do cookie, apenas transportada em header.
3. **Leitura primeiro.** A superfície de escrita é deliberadamente pequena: publicar mensagem e mudar status. Nada de criar chamado, gerenciar usuários, mexer em branding, sistemas-alvo ou guardrails da IA por esta API.
4. **Sem CSRF por construção.** A API aceita **apenas** `Authorization: Bearer`; o cookie de sessão do navegador **não** autentica `/api/v1`. Um site malicioso não consegue agir em nome do usuário logado no portal, porque o navegador não anexa o header sozinho.
5. **Formato pensado para LLM.** Respostas em JSON compacto com o corpo das mensagens em **texto puro** (projeção do HTML sanitizado), não HTML — menos tokens, menos ruído, nenhuma tag para o modelo interpretar.

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

| Método   | Rota                               | Papéis                | O que faz                                    |
| -------- | ---------------------------------- | --------------------- | -------------------------------------------- |
| `POST`   | `/api/v1/sessao`                   | público               | Login por e-mail + senha → token             |
| `DELETE` | `/api/v1/sessao`                   | autenticado           | Revoga a sessão corrente                     |
| `GET`    | `/api/v1/chamados`                 | todos (escopo abaixo) | Lista/filtra chamados                        |
| `GET`    | `/api/v1/chamados/{ref}`           | todos (escopo abaixo) | Chamado + timeline                           |
| `POST`   | `/api/v1/chamados/{ref}/mensagens` | todos (escopo abaixo) | Publica mensagem `publica` ou nota `interna` |
| `POST`   | `/api/v1/chamados/{ref}/status`    | todos (escopo abaixo) | Transiciona o status                         |

`{ref}` aceita o **UUID** ou o **número** do chamado (`12` ou `#12`) — o número é como a equipe se refere ao chamado no dia a dia. A resolução por número é escopada ao tenant pela RLS (`UNIQUE (tenant_id, numero)`).

### 4.1 `GET /api/v1/chamados`

Query params, todos opcionais: `status` (aceita lista separada por vírgula), `natureza`, `prioridade`, `atribuicao` (`atribuido` | `nao_atribuido` | `<uuid do operador>`), `sistema_alvo_id`, `categoria_id`, `busca` (número ou full-text — specs/04 §10.4), `limite` (1–100, default 20), `cursor`.

Valor inválido de enum é **rejeitado** com `400 parametro_invalido` (nunca silenciosamente ignorado — filtro que mente é pior que erro).

Resposta: `{ "itens": [...], "proximo_cursor": "…" | null }`. Cada item é uma **projeção compacta** (sem a descrição, que só vem no detalhe): `id`, `numero`, `titulo`, `status`, `natureza`, `prioridade`, `complexidade` (só equipe), `operador_nome`, `solicitante_nome`, `sistema_nome`, `categoria_nome`, `created_at`, `updated_at`.

### 4.2 `GET /api/v1/chamados/{ref}`

Resposta: o chamado (incluindo `descricao` já em texto puro) + `mensagens`, em ordem cronológica:

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
    "ia_silenciada": false,
    "descricao": "…",
    "solicitante_nome": "…",
    "operador_nome": "…",
    "sistema_nome": "…",
    "created_at": "…",
    "updated_at": "…"
  },
  "mensagens": [
    {
      "id": "…",
      "autor_nome": "…",
      "autor_papel": "cliente",
      "visibilidade": "publica",
      "corpo": "…",
      "created_at": "…"
    }
  ]
}
```

`complexidade`, `ia_silenciada` e as mensagens `interna` **só existem na resposta para operador/admin** — para o `cliente` a query nem as traz (filtro no repositório, `listarMensagens`) e o serializer as remove (specs/03 §7). Chamado inexistente **ou** fora do escopo do papel → `404` idêntico (não vaza existência).

### 4.3 `POST /api/v1/chamados/{ref}/mensagens`

Corpo: `{ "visibilidade": "publica" | "interna", "corpo": "<markdown>" }`.

- O corpo é **markdown**, convertido pelo mesmo `markdownParaDoc` usado nas respostas da IA e submetido ao MESMO pipeline de validação/sanitização do editor (specs/04 §5) — nada de HTML cru.
- `interna` exige operador/admin; cliente recebe `403` (fronteira inegociável, specs/03 §7).
- Estados terminais (`fechado`/`cancelado`) recusam mensagens (`409 estado_terminal`, specs/04 §1.1).
- Dispara os MESMOS efeitos da UI (`comDespacho`): notificações e, quando é resposta pública de cliente, re-enfileiramento da triagem (specs/05 §2).
- Sucesso `201`: `{ "id": "…" }`.

### 4.4 `POST /api/v1/chamados/{ref}/status`

Corpo: `{ "status": "<status canônico>", "motivo": "<opcional>" }`.

Delega a `transicionarStatus`: a **máquina de estados** (specs/04 §1.3) decide, com o papel do token. Transição inválida → `409` com o motivo de domínio (ex.: `transicao_invalida`, `papel_nao_pode`); sem permissão → `403`. O evento de auditoria sai com o `motivo` informado, como em qualquer mudança pela UI.

Sucesso `200`: `{ "status": "resolvido" }`.

---

## 5. Escopo por papel

A API herda integralmente a matriz de specs/03 §8.1 — não redefine nada:

| Ação                        | admin  | operador | cliente                   |
| --------------------------- | ------ | -------- | ------------------------- |
| Listar/ler chamados         | tenant | tenant   | só os próprios            |
| Ler mensagem `publica`      | ✅     | ✅       | ✅ (nos próprios)         |
| Ler nota `interna`          | ✅     | ✅       | ❌ (nem sabe que existe)  |
| Ver `complexidade`          | ✅     | ✅       | ❌                        |
| Escrever mensagem `publica` | ✅     | ✅       | ✅ (nos próprios)         |
| Escrever nota `interna`     | ✅     | ✅       | ❌                        |
| Mudar status                | ✅     | ✅       | ⚠️ só reabrir `resolvido` |

O `agente_ia` não usa esta API: é service account do worker, sem senha (specs/03 §6).

---

## 6. Erros

Sempre JSON: `{ "erro": "<mensagem legível>", "codigo": "<slug estável>" }`.

| HTTP | Código                                       | Quando                                      |
| ---- | -------------------------------------------- | ------------------------------------------- |
| 400  | `corpo_invalido`, `parametro_invalido`       | JSON malformado, enum/valor fora do domínio |
| 401  | `credenciais_invalidas`, `nao_autenticado`   | login falhou; token ausente/expirado        |
| 403  | `sem_permissao`                              | papel não pode a ação                       |
| 404  | `tenant_desconhecido`, `chamado_inexistente` | host sem tenant; chamado fora do escopo     |
| 409  | `estado_terminal`, `transicao_invalida`, …   | regra de domínio recusou                    |
| 429  | `muitas_tentativas`                          | rate limit do login                         |

O `codigo` é o contrato estável (o cliente decide por ele); a `mensagem` é para humanos.

---

## 7. Servidor MCP

Processo Node **stdio** (`apps/mcp`) que fala a API acima. É um cliente como outro qualquer: não acessa banco, fila nem storage, e **não** tem privilégio algum além do papel do usuário configurado.

### 7.1 Configuração

| Variável                       | Obrigatória | Descrição                                                             |
| ------------------------------ | ----------- | --------------------------------------------------------------------- |
| `CHAMADOS_URL`                 | sim         | Base da instalação (ex.: `https://suporte.empresa.com`)               |
| `CHAMADOS_EMAIL`               | sim         | E-mail do usuário                                                     |
| `CHAMADOS_SENHA`               | sim         | Senha do usuário                                                      |
| `CHAMADOS_TENANT`              | não         | Slug do tenant (só onde o host não resolve — ex.: `localhost` em dev) |
| `CHAMADOS_MCP_SOMENTE_LEITURA` | não         | `true` registra apenas as ferramentas de leitura                      |

**Login preguiçoso**: a sessão é aberta na primeira ferramenta usada, mantida em memória e renovada automaticamente **uma vez** ao receber `401` (sessão expirada). A senha vive só na memória do processo e **nunca** é logada nem devolvida em mensagem de erro.

### 7.2 Ferramentas

| Ferramenta                  | Tipo    | Mapeia para                             |
| --------------------------- | ------- | --------------------------------------- |
| `chamados_listar`           | leitura | `GET /api/v1/chamados`                  |
| `chamado_obter`             | leitura | `GET /api/v1/chamados/{ref}`            |
| `chamado_publicar_mensagem` | escrita | `POST /api/v1/chamados/{ref}/mensagens` |
| `chamado_alterar_status`    | escrita | `POST /api/v1/chamados/{ref}/status`    |

As de escrita são anotadas como não-idempotentes e, no caso de `chamado_publicar_mensagem`, a descrição declara explicitamente que `visibilidade: "publica"` **é visível ao cliente final** — o modelo precisa saber que está falando com o cliente, não com a equipe.

Erros da API voltam ao modelo como erro de ferramenta com o `codigo` — corrigível (ex.: `transicao_invalida` leva o modelo a escolher outro status), no mesmo espírito das ferramentas do worker (specs/05 §4.2).

### 7.3 Segurança

- O MCP **não amplia** poder: um `cliente` configurado enxerga só os próprios chamados e nunca notas internas — a fronteira é server-side, não na ferramenta.
- Recomendação de instalação: usar um usuário `operador` dedicado, para que a trilha de auditoria (`EventoChamado`) distinga as ações feitas via assistente das feitas por humanos no painel.
- `CHAMADOS_URL` deve ser **HTTPS** fora de `localhost`: a senha trafega no corpo do login e o token em header.
- Conteúdo de chamado que chega ao modelo é **dado não confiável** (mesma regra de specs/05 §9 e specs/09 §4.1) — o cliente MCP não interpreta nada do corpo como instrução.

---

## 8. Fora de escopo (por ora)

- **Criar chamado** pela API/MCP: a abertura é do cliente final, com formulário mínimo e anexos; entra se houver demanda.
- **Anexos** (upload/download) e **eventos** (`EventoChamado`) na resposta do detalhe: a timeline de mensagens cobre o uso pretendido.
- **Atribuição, prioridade, complexidade, silenciar IA, reexecutar triagem**: mutações de painel, deliberadamente fora da superfície inicial.
- **Streaming/transport HTTP do MCP**: só stdio, que é o modo local do Claude Code/Desktop.

> DECISÃO PENDENTE: se a API deve ganhar um **token de aplicação** de longa duração (escopo reduzido, revogável no painel) como alternativa a login/senha em variável de ambiente. Hoje o token é a própria sessão, com a duração da spec 03 §4.4.
