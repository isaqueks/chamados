# Webhooks — guia de integração

> Documento de referência **interna** (spec + código). Fonte da verdade: `specs/06-notificacoes.md` §3.2 (D-003) — se este guia divergir da spec, a spec ganha. Para enviar a integradores externos, use a versão autossuficiente (sem referências internas): [`docs/webhooks-integracao.md`](webhooks-integracao.md).

O Chamados envia um `POST` JSON **assinado** ao endpoint do tenant a cada atualização relevante de chamado. O caso de uso típico: o tenant já possui um sistema próprio que entrega mensagens aos usuários finais (WhatsApp, app, painel interno) — o Chamados apenas o notifica.

---

## 1. Natureza do canal

- **Por tenant, não por usuário.** Cada tenant tem no máximo **um** webhook (URL + segredo). Cada evento qualificável dispara **um único** `POST`, independentemente das preferências individuais de notificação por e-mail — inclusive dos defaults anti-flood (`mudanca_status`/`mudanca_prioridade` nascem desligados **só no e-mail**; no webhook sempre disparam).
- **Nunca carrega conteúdo interno.** Notas `interna`, complexidade, diagnóstico/SPEC, dados de `ExecucaoIA` ou qualquer campo restrito a operador/admin/agente_ia jamais entram no payload (specs/06 §3.2, specs/09).

## 2. Configuração (painel do admin)

Em **`/app/config` → Webhook de notificações**:

| Campo       | Descrição                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------- |
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

Os eventos notificáveis do catálogo (specs/06 §6) mapeiam para **11 categorias** de webhook (as 7 da D-003 + `aprovado`/`contestado` da D-042 + `estimativa_custo_alterada`/`custo_final_definido` da D-043). O tipo vai em `evento.tipo` no corpo e no header `x-chamados-event`:

| `evento.tipo`               | Disparado quando…                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `criado`                    | Chamado aberto.                                                                                                                                                                                                                                                                  |
| `mensagem_publica`          | Nova mensagem **pública** na timeline.                                                                                                                                                                                                                                           |
| `status_alterado`           | Transição de status — inclui **reabertura** e **cancelamento** (ambas são transições de status).                                                                                                                                                                                 |
| `prioridade_alterada`       | Prioridade do chamado alterada.                                                                                                                                                                                                                                                  |
| `atribuicao`                | Operador atribuído/desatribuído.                                                                                                                                                                                                                                                 |
| `resolvido`                 | Chamado marcado como resolvido — abre a janela de aprovação do cliente (D-042).                                                                                                                                                                                                  |
| `fechado`                   | Chamado fechado **manualmente pela equipe** (`chamado_fechado`). Desde a D-042 não cobre mais o fechamento automático.                                                                                                                                                           |
| `aprovado`                  | O cliente aprovou a resolução: `aprovacao.forma = "explicita"` (`chamado_aprovado`, com `autor`) ou `"tacita"` (prazo vencido sem resposta — `chamado_fechado_auto`, sem `autor`). Nunca acompanhado de `fechado`.                                                               |
| `contestado`                | O cliente contestou a resolução com motivo (`chamado_contestado`): `autor`, `mensagem.trecho` (o motivo) e `mudanca` `resolvido → em_atendimento`. O motivo também gera um `mensagem_publica` separado.                                                                          |
| `estimativa_custo_alterada` | D-043: a equipe definiu, alterou ou removeu a estimativa de custo. `mudanca` com os **códigos** da faixa (`{ "de": null, "para": "B" }`; `null` = sem estimativa).                                                                                                               |
| `custo_final_definido`      | D-043: o custo final foi **corrigido** com o chamado em `resolvido`. `mudanca` com **números** em reais (`{ "de": 150, "para": 180.5 }`; `null` = sem custo). O custo informado **no ato de resolver** não gera este tipo — vem em `chamado.custo_final` do próprio `resolvido`. |

**Janela de aprovação (D-042, specs/04 §8.1):** ao ir para `resolvido`, o cliente solicitante tem `tenant.dias_fechamento_automatico` dias (padrão 7) para aprovar ou contestar; sem resposta, o job `manutencao` fecha o chamado (aprovação tácita) e o webhook `aprovado` tácito sai **com entrega garantida**: a chave de idempotência deriva do id do `EventoChamado`, e a varredura reconcilia por 24 h os webhooks de aprovação tácita sem linha no `notificacao_log` (mesmo `x-chamados-event-id`; job na fila é deduplicado pelo `jobId`). Para integradores, "encerrado" = `aprovado` **ou** `fechado`.

**Custo (D-043, specs/04 §3.4):** todo payload traz `chamado.estimativa_custo` e `chamado.custo_final` (estado **atual** no momento da entrega). Para saber o valor que o cliente aprovou, leia `chamado.custo_final` do `aprovado` (ou do `resolvido`, corrigido por eventuais `custo_final_definido`). Faixas: `A` R$ 50–100 · `B` R$ 100–200 · `C` R$ 200–400 · `D` R$ 400–600 · `E` acima de R$ 600 (`max: null`) · `I` isento (R$ 0). Repetir o mesmo valor não gera webhook.

Nota interna, mudança de complexidade, anexos e eventos internos da IA (`ia_*`) **nunca** disparam webhook.

## 4. A requisição

`POST` com `Content-Type: application/json` e os headers:

| Header                 | Conteúdo                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| `x-chamados-signature` | `sha256=<hex>` — HMAC SHA-256 do **corpo bruto**, com o segredo. |
| `x-chamados-event`     | Categoria do evento (§3).                                        |
| `x-chamados-event-id`  | Id único do evento — use para **deduplicar** no receptor (§5).   |

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
    "tipo": "status_alterado", // categoria (§3)
    "id": "8f2c…", // mesmo valor de x-chamados-event-id
    "timestamp": "2026-07-20T14:03:11.000Z",
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123",
    "titulo": "Erro ao emitir nota",
    "status": "em_atendimento",
    "prioridade": "alta",
    "natureza": "problema",
    "sistema_alvo": "ERP Web", // nome, ou null
    "categoria": "Financeiro", // nome, ou null
    // D-043 — SEMPRE presentes (públicos):
    "estimativa_custo": { "codigo": "B", "rotulo": "B · R$ 100 a R$ 200", "min": 100, "max": 200 }, // ou null
    "custo_final": 150.5, // reais, ou null
  },
  // Autor da ação: mensagem_publica, contestado e aprovado explícito (só o nome):
  "autor": { "nome": "Maria Silva" },
  // Trecho PÚBLICO (HTML removido, máx. ~240 chars): mensagem_publica e contestado (o motivo):
  "mensagem": { "trecho": "Boa tarde! O erro acontece quando…" },
  // status_alterado / prioridade_alterada / aprovado / contestado /
  // estimativa_custo_alterada (códigos) / custo_final_definido (números):
  "mudanca": { "de": "em_triagem", "para": "em_atendimento" },
  // Só em aprovado (D-042): { "forma": "explicita" | "tacita" }; null nos demais:
  "aprovacao": null,
  "linkChamado": "https://<dominio-do-tenant>/portal/chamados/<id>",
}
```

Campos condicionais vêm `null` quando não se aplicam.

Exemplo — **aprovação tácita** (D-042; `x-chamados-event: aprovado`):

```json
{
  "evento": {
    "tipo": "aprovado",
    "id": "<id do EventoChamado>",
    "timestamp": "2026-11-24T14:05:00.000Z"
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123",
    "titulo": "Erro ao emitir nota",
    "status": "fechado",
    "prioridade": "alta",
    "natureza": "problema",
    "sistema_alvo": "ERP Web",
    "categoria": null,
    "estimativa_custo": { "codigo": "B", "rotulo": "B · R$ 100 a R$ 200", "min": 100, "max": 200 },
    "custo_final": 150.5
  },
  "autor": null,
  "mensagem": null,
  "mudanca": { "de": "resolvido", "para": "fechado" },
  "aprovacao": { "forma": "tacita" },
  "linkChamado": "https://<dominio-do-tenant>/portal/chamados/<id>"
}
```

Aprovação explícita: `aprovacao.forma = "explicita"` e `autor = { "nome": "<cliente>" }`. Contestação: `evento.tipo = "contestado"`, `aprovacao = null`, `autor` = cliente, `mensagem.trecho` = motivo, `mudanca.para = "em_atendimento"`.

Exemplo — **correção do custo final** (D-043; `x-chamados-event: custo_final_definido`):

```json
{
  "evento": {
    "tipo": "custo_final_definido",
    "id": "<id do EventoChamado>",
    "timestamp": "2026-11-18T10:12:00.000Z"
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123",
    "titulo": "Erro ao emitir nota",
    "status": "resolvido",
    "prioridade": "alta",
    "natureza": "problema",
    "sistema_alvo": "ERP Web",
    "categoria": null,
    "estimativa_custo": { "codigo": "B", "rotulo": "B · R$ 100 a R$ 200", "min": 100, "max": 200 },
    "custo_final": 180.5
  },
  "autor": null,
  "mensagem": null,
  "mudanca": { "de": 150, "para": 180.5 },
  "aprovacao": null,
  "linkChamado": "https://<dominio-do-tenant>/portal/chamados/<id>"
}
```

`estimativa_custo_alterada` tem a mesma forma, com `mudanca` de códigos (ex.: `{ "de": "A", "para": "B" }`) e `chamado.estimativa_custo` já com a faixa nova.

Valores de `status`, `prioridade` e `natureza` usam os enums canônicos do Chamados (`novo`, `em_triagem`, `aguardando_cliente`, `em_atendimento`, `resolvido`, `fechado`, `cancelado` · `baixa`…`urgente` · `problema`/`alteracao`/`duvida`).

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

| Variável                                | Default | Efeito                                            |
| --------------------------------------- | ------- | ------------------------------------------------- |
| `NOTIFICACOES_WEBHOOK_TIMEOUT_MS`       | `5000`  | Timeout por requisição de webhook.                |
| `NOTIFICACOES_WEBHOOK_MAX_FALHAS`       | `10`    | Falhas consecutivas até a desativação automática. |
| `NOTIFICACOES_WEBHOOK_PERMITIR_PRIVADO` | `false` | (Dev) permite hosts privados na URL.              |

## 9. Referências no código

- Catálogo de eventos e payload: `packages/db/src/notificacoes/tipos.ts` (`CATALOGO_NOTIFICACOES`, `PayloadWebhook`, `assinarWebhook`)
- Resolução de destinatários/disparo: `packages/db/src/notificacoes/dispatcher.ts`
- Validação anti-SSRF: `packages/db/src/notificacoes/validar-url-webhook.ts`
- Canal por tenant + circuito de falhas: `packages/db/src/notificacoes/canal-service.ts`
- Adapter de envio (HMAC, timeout, classificação): `apps/worker/src/notificacoes/webhook-adapter.ts`
- Processamento/idempotência/alerta ao admin: `apps/worker/src/notificacoes/processador.ts`
- Aprovação tácita + reconciliação do webhook (D-042): `packages/db/src/chamados/manutencao-service.ts` (`fecharChamadosResolvidosVencidos`, `reconciliarWebhooksAprovacaoTacita`)
- UI de configuração + evento de teste: `apps/web/src/app/app/config/actions.ts`
