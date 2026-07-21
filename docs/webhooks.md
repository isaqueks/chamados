# Webhooks — guia de integração

> Documento de referência para **integradores** (o sistema externo do tenant que recebe os webhooks) e **admins** (que configuram o canal no painel). Fonte da verdade: `specs/06-notificacoes.md` §3.2 (D-003). Se este guia divergir da spec, a spec ganha.

O Chamados envia um `POST` JSON **assinado** ao endpoint do tenant a cada atualização relevante de chamado. O caso de uso típico: o tenant já possui um sistema próprio que entrega mensagens aos usuários finais (WhatsApp, app, painel interno) — o Chamados apenas o notifica.

---

## 1. Natureza do canal

- **Por tenant, não por usuário.** Cada tenant tem no máximo **um** webhook (URL + segredo). Cada evento qualificável dispara **um único** `POST`, independentemente das preferências individuais de notificação por e-mail — inclusive dos defaults anti-flood (`mudanca_status`/`mudanca_prioridade` nascem desligados **só no e-mail**; no webhook sempre disparam).
- **Nunca carrega conteúdo interno.** Notas `interna`, complexidade, diagnóstico/SPEC, dados de `ExecucaoIA` ou qualquer campo restrito a operador/admin/agente_ia jamais entram no payload (specs/06 §3.2, specs/09).

## 2. Configuração (painel do admin)

Em **`/app/config` → Webhook de notificações**:

| Campo       | Descrição                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------- |
| **URL**     | Endpoint `http(s)` público que recebe o `POST`. Validada contra SSRF (ver §7).                 |
| **Segredo** | Chave do HMAC SHA-256. Armazenado no **cofre** (envelope encryption) — nunca exibido de volta. |
| **Ativo**   | Liga/desliga o canal. Salvar/reativar com "ativo" **zera o circuito de falhas** (§6).          |

O botão **"Enviar evento de teste"** dispara um `POST` real, assinado com o segredo persistido, e mostra o status HTTP retornado:

```json
{
  "evento": { "tipo": "teste", "id": "<uuid>", "timestamp": "<ISO-8601>" },
  "teste": true,
  "mensagem": "Evento de teste enviado pelo painel do Chamados."
}
```

Headers do teste: `x-chamados-event: teste` (assinatura normal, ver §4).

## 3. Eventos

Os eventos notificáveis do catálogo (specs/06 §6) mapeiam para **7 categorias** de webhook (D-003). O tipo vai em `evento.tipo` no corpo e no header `x-chamados-event`:

| `evento.tipo`         | Disparado quando…                                          |
| --------------------- | ---------------------------------------------------------- |
| `criado`              | Chamado aberto.                                            |
| `mensagem_publica`    | Nova mensagem **pública** na timeline.                     |
| `status_alterado`     | Transição de status — inclui **reabertura** e **cancelamento** (ambas são transições de status). |
| `prioridade_alterada` | Prioridade do chamado alterada.                            |
| `atribuicao`          | Operador atribuído/desatribuído.                           |
| `resolvido`           | Chamado marcado como resolvido.                            |
| `fechado`             | Chamado fechado (manual ou automático).                    |

Nota interna, mudança de complexidade, anexos e eventos internos da IA (`ia_*`) **nunca** disparam webhook.

## 4. A requisição

`POST` com `Content-Type: application/json` e os headers:

| Header                 | Conteúdo                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `x-chamados-signature` | `sha256=<hex>` — HMAC SHA-256 do **corpo bruto**, com o segredo.  |
| `x-chamados-event`     | Categoria do evento (§3).                                         |
| `x-chamados-event-id`  | Id único do evento — use para **deduplicar** no receptor (§5).    |

### Verificando a assinatura (obrigatório no receptor)

Recalcule o HMAC sobre o corpo **exatamente como recebido** (bytes crus, antes de qualquer parse) e compare em tempo constante:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function assinaturaValida(corpoBruto, headerAssinatura, segredo) {
  const esperada = `sha256=${createHmac('sha256', segredo).update(corpoBruto).digest('hex')}`;
  const a = Buffer.from(esperada);
  const b = Buffer.from(headerAssinatura ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Rejeite (4xx) requisições com assinatura ausente ou inválida.

### Payload

```jsonc
{
  "evento": {
    "tipo": "status_alterado",        // categoria (§3)
    "id": "8f2c…",                    // mesmo valor de x-chamados-event-id
    "timestamp": "2026-07-20T14:03:11.000Z"
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123",
    "titulo": "Erro ao emitir nota",
    "status": "em_atendimento",
    "prioridade": "alta",
    "natureza": "problema",
    "sistema_alvo": "ERP Web",        // nome, ou null
    "categoria": "Financeiro"         // nome, ou null
  },
  // Só em mensagem_publica (autor e trecho PÚBLICO, HTML removido, máx. ~240 chars):
  "autor": { "nome": "Maria Silva" },
  "mensagem": { "trecho": "Boa tarde! O erro acontece quando…" },
  // Só em status_alterado / prioridade_alterada:
  "mudanca": { "de": "em_triagem", "para": "em_atendimento" },
  "linkChamado": "https://<dominio-do-tenant>/portal/chamados/<id>"
}
```

Campos condicionais vêm `null` quando não se aplicam. Valores de `status`, `prioridade` e `natureza` usam os enums canônicos do Chamados (`novo`, `em_triagem`, `aguardando_cliente`, `em_atendimento`, `resolvido`, `fechado`, `cancelado` · `baixa`…`urgente` · `problema`/`alteracao`/`duvida`).

## 5. Entrega, retries e idempotência

- **Sucesso = qualquer 2xx.** Responda rápido (idealmente `200`/`204` imediato) e processe de forma assíncrona — o timeout por requisição é **curto** (default 5 s) e **redirects não são seguidos**.
- **Retentativas:** falha temporária (5xx, `408`, `429`, timeout, erro de rede) → a fila re-tenta com **backoff exponencial** (até 5 tentativas, base 30 s). Demais 4xx = falha **permanente** (endpoint/configuração errada): não há nova tentativa daquele evento.
- **Idempotência:** o Chamados nunca reenvia um evento já **aceito** (log de entrega com chave determinística). Ainda assim, entre falha parcial e retry o mesmo evento pode chegar mais de uma vez — **deduplique por `x-chamados-event-id`** no receptor.
- **Ordem não garantida.** Retries e concorrência podem entregar eventos fora de ordem; use `evento.timestamp` (e o estado atual em `chamado.status`) em vez de assumir sequência.

## 6. Circuito de falhas (desativação automática)

Cada falha de entrega incrementa um contador de **falhas consecutivas** (qualquer sucesso zera). Ao atingir o limite (default **10**), o canal é **desativado automaticamente** e os admins do tenant recebem um **e-mail de alerta** com o motivo e o link da configuração — evita fila entupida contra um endpoint morto.

A reativação é **manual**: o admin corrige o destino e salva/reativa no painel, o que zera o contador. O painel exibe `falhas_consecutivas`, `desativado_em` e `ultimo_erro`.

## 7. Segurança

- **Anti-SSRF (specs/09):** a URL é validada no **salvamento**, no **envio** e no **teste** — só `http(s)`, sem credenciais embutidas, e hosts privados/loopback/link-local/metadata/CGNAT bloqueados (incl. IPv6, IPv4-mapeado e IPs ofuscados em decimal/hex). Redirects nunca são seguidos no envio. Em dev, `NOTIFICACOES_WEBHOOK_PERMITIR_PRIVADO=true` libera receptor local (ex.: `http://localhost:4000/hook`).
- **Segredo no cofre:** o segredo HMAC é gravado com envelope encryption e referenciado por `segredo_ref`; a UI nunca o reexibe (campo vazio na edição = mantém o atual).
- **Recomendações ao receptor:** exponha o endpoint só em HTTPS, valide a assinatura sempre (§4), trate o payload como dado não confiável e não registre o segredo em logs.

## 8. Variáveis de ambiente (worker)

| Variável                                  | Default | Efeito                                            |
| ----------------------------------------- | ------- | ------------------------------------------------- |
| `NOTIFICACOES_WEBHOOK_TIMEOUT_MS`         | `5000`  | Timeout por requisição de webhook.                |
| `NOTIFICACOES_WEBHOOK_MAX_FALHAS`         | `10`    | Falhas consecutivas até a desativação automática. |
| `NOTIFICACOES_WEBHOOK_PERMITIR_PRIVADO`   | `false` | (Dev) permite hosts privados na URL.              |

## 9. Referências no código

- Catálogo de eventos e payload: `packages/db/src/notificacoes/tipos.ts` (`CATALOGO_NOTIFICACOES`, `PayloadWebhook`, `assinarWebhook`)
- Resolução de destinatários/disparo: `packages/db/src/notificacoes/dispatcher.ts`
- Validação anti-SSRF: `packages/db/src/notificacoes/validar-url-webhook.ts`
- Canal por tenant + circuito de falhas: `packages/db/src/notificacoes/canal-service.ts`
- Adapter de envio (HMAC, timeout, classificação): `apps/worker/src/notificacoes/webhook-adapter.ts`
- Processamento/idempotência/alerta ao admin: `apps/worker/src/notificacoes/processador.ts`
- UI de configuração + evento de teste: `apps/web/src/app/app/config/actions.ts`
