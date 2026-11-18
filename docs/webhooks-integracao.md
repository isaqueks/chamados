# Webhooks — guia de integração

Este documento descreve como receber e processar os webhooks enviados pela plataforma de chamados. Ele é autossuficiente: tudo o que a sua aplicação precisa para integrar está aqui.

A cada atualização relevante de um chamado, a plataforma envia um `POST` com corpo JSON **assinado** para o endpoint configurado pela sua organização. O caso de uso típico: seu sistema recebe o evento e repassa a novidade aos usuários finais pelo canal que preferir (WhatsApp, aplicativo, painel interno etc.).

---

## 1. Como funciona

- **Um endpoint por organização.** Sua organização configura **uma** URL e **um** segredo. Cada evento gera **um único** `POST` para essa URL — o webhook não é por usuário e não depende das preferências individuais de notificação por e-mail.
- **Conteúdo sempre público.** O payload contém apenas dados visíveis ao cliente do chamado. Anotações internas da equipe de atendimento nunca são enviadas.
- **Configuração.** O administrador da sua organização define a URL e o segredo no painel administrativo da plataforma (seção de configurações, "Webhook de notificações"). A URL deve ser um endereço `http(s)` **público** — endereços de rede privada/interna são recusados. O painel também oferece um botão de **evento de teste** (ver §6).

## 2. Eventos

O tipo do evento vai no campo `evento.tipo` do corpo e no header `x-chamados-event`:

| `evento.tipo`               | Disparado quando…                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `criado`                    | Um chamado é aberto.                                                                                |
| `mensagem_publica`          | Uma nova mensagem pública é publicada na conversa do chamado.                                       |
| `status_alterado`           | O status do chamado muda — inclui **reabertura** e **cancelamento** (ambos são mudanças de status). |
| `prioridade_alterada`       | A prioridade do chamado é alterada.                                                                 |
| `atribuicao`                | Um atendente é atribuído ao chamado (ou desatribuído).                                              |
| `resolvido`                 | O chamado é marcado como resolvido. Abre o prazo para o cliente **aprovar ou contestar** (§2.1).    |
| `fechado`                   | A equipe de atendimento fechou o chamado manualmente (não é aprovação do cliente).                  |
| `aprovado`                  | O cliente **aprovou** a solução — explicitamente ou por não responder dentro do prazo (§2.1).       |
| `contestado`                | O cliente **contestou** a solução, com um motivo; o chamado voltou para atendimento (§2.1).         |
| `estimativa_custo_alterada` | A equipe definiu, alterou ou removeu a **estimativa de custo** do chamado (§2.2).                   |
| `custo_final_definido`      | A equipe **corrigiu o custo final** de um chamado já resolvido (§2.2).                              |

### 2.1 Aprovação da solução pelo cliente

Quando um chamado é marcado como `resolvido`, o cliente que o abriu tem um prazo (padrão **7 dias**, configurável pela sua organização) para **aprovar** ou **contestar** a solução. Sem resposta até o fim do prazo, a solução é **considerada aprovada** e o chamado é fechado.

- **Aprovação** — sempre chega como **`aprovado`** (nunca também como `fechado`): `aprovacao.forma` é `"explicita"` (o cliente aprovou; `autor` traz o nome dele) ou `"tacita"` (o prazo terminou sem resposta; `autor` é `null`). Em ambos os casos `chamado.status` é `fechado` e `mudanca` é `{ "de": "resolvido", "para": "fechado" }`. A aprovação tácita é **sempre** notificada: se a primeira tentativa de envio não chegar à fila, a plataforma a reenvia (com o mesmo `x-chamados-event-id`) por até 24 h.
- **Contestação** — chega como **`contestado`**: `autor` traz o nome do cliente, `mensagem.trecho` traz o motivo informado e `mudanca` é `{ "de": "resolvido", "para": "em_atendimento" }`. O motivo também é publicado na conversa, então um evento `mensagem_publica` com o mesmo texto chega separadamente.
- **Fechamento pela equipe** — chega como **`fechado`**. Para saber se um chamado foi encerrado, trate `aprovado` **e** `fechado`.

### 2.2 Estimativa de custo e custo final

A equipe pode definir uma **estimativa de custo** por faixa e, ao resolver, informar o **custo final** em reais. Os dois são visíveis ao cliente e vêm **em todo payload**, dentro de `chamado`:

- `chamado.estimativa_custo` — `null` (sem estimativa) ou `{ "codigo", "rotulo", "min", "max" }`. Faixas: `A` R$ 50–100 · `B` R$ 100–200 · `C` R$ 200–400 · `D` R$ 400–600 · `E` acima de R$ 600 (`max: null`) · `I` isento (R$ 0).
- `chamado.custo_final` — número em reais (ex.: `150.5`) ou `null`.

Eventos:

- **Estimativa definida/alterada/removida** → **`estimativa_custo_alterada`**, com `mudanca` contendo os **códigos** (ex.: `{ "de": null, "para": "B" }`).
- **Custo final informado ao resolver** → não há evento próprio: o **`resolvido`** já chega com `chamado.custo_final` preenchido.
- **Custo final corrigido depois** (com o chamado ainda resolvido) → **`custo_final_definido`**, com `mudanca` contendo **números** (ex.: `{ "de": 150, "para": 180.5 }`).
- Repetir o mesmo valor não gera evento. O valor que o cliente aprovou é o `chamado.custo_final` que chega no `aprovado`.

## 3. A requisição

`POST` com `Content-Type: application/json` e os seguintes headers:

| Header                 | Conteúdo                                                               |
| ---------------------- | ---------------------------------------------------------------------- |
| `x-chamados-signature` | `sha256=<hex>` — HMAC SHA-256 do corpo bruto, calculado com o segredo. |
| `x-chamados-event`     | Tipo do evento (§2).                                                   |
| `x-chamados-event-id`  | Identificador único do evento — use para deduplicar (§5).              |

### 3.1 Verificando a assinatura (obrigatório)

Recalcule o HMAC sobre o corpo **exatamente como recebido** (bytes crus, antes de qualquer parse/reserialização do JSON) e compare com o header em tempo constante. Exemplo em Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function assinaturaValida(corpoBruto, headerAssinatura, segredo) {
  const esperada = `sha256=${createHmac('sha256', segredo).update(corpoBruto).digest('hex')}`;
  const a = Buffer.from(esperada);
  const b = Buffer.from(headerAssinatura ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Equivalente em Python:

```python
import hashlib, hmac

def assinatura_valida(corpo_bruto: bytes, header_assinatura: str, segredo: str) -> bool:
    esperada = "sha256=" + hmac.new(segredo.encode(), corpo_bruto, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperada, header_assinatura or "")
```

Rejeite com `401`/`403` requisições sem assinatura ou com assinatura inválida.

### 3.2 Payload

```jsonc
{
  "evento": {
    "tipo": "status_alterado", // tipo do evento (§2)
    "id": "8f2c…", // mesmo valor do header x-chamados-event-id
    "timestamp": "2026-07-20T14:03:11.000Z", // ISO-8601, UTC
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123", // número legível do chamado
    "titulo": "Erro ao emitir nota",
    "status": "em_atendimento",
    "prioridade": "alta",
    "natureza": "problema",
    "sistema_alvo": "ERP Web", // sistema relacionado, ou null
    "categoria": "Financeiro", // categoria, ou null
    // Sempre presentes (§2.2):
    "estimativa_custo": { "codigo": "B", "rotulo": "B · R$ 100 a R$ 200", "min": 100, "max": 200 }, // ou null
    "custo_final": 150.5, // em reais, ou null
  },
  // Quem praticou a ação: em mensagem_publica, contestado e aprovado (explícito):
  "autor": { "nome": "Maria Silva" },
  // Em mensagem_publica e contestado (o motivo) — texto puro, ~240 caracteres no máximo:
  "mensagem": { "trecho": "Boa tarde! O erro acontece quando…" },
  // Em status_alterado, prioridade_alterada, aprovado, contestado,
  // estimativa_custo_alterada (códigos) e custo_final_definido (valores em reais):
  "mudanca": { "de": "em_triagem", "para": "em_atendimento" },
  // Apenas em aprovado: "explicita" (o cliente aprovou) ou "tacita" (prazo sem resposta):
  "aprovacao": null,
  // Link direto para o chamado na plataforma:
  "linkChamado": "https://<dominio>/portal/chamados/<id>",
}
```

Campos condicionais vêm `null` quando não se aplicam ao evento.

Exemplo de **aprovação tácita** (prazo terminou sem resposta do cliente):

```json
{
  "evento": { "tipo": "aprovado", "id": "3b1e…", "timestamp": "2026-11-24T14:05:00.000Z" },
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
  "linkChamado": "https://<dominio>/portal/chamados/<id>"
}
```

Na **aprovação explícita**, `aprovacao` é `{ "forma": "explicita" }` e `autor` é `{ "nome": "<cliente>" }`. Na **contestação** (`contestado`), `aprovacao` é `null`, `autor` traz o cliente, `mensagem.trecho` o motivo e `mudanca.para` é `em_atendimento`.

Exemplo de **estimativa de custo alterada**:

```json
{
  "evento": {
    "tipo": "estimativa_custo_alterada",
    "id": "9a0d…",
    "timestamp": "2026-11-17T15:20:00.000Z"
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123",
    "titulo": "Erro ao emitir nota",
    "status": "em_atendimento",
    "prioridade": "alta",
    "natureza": "alteracao",
    "sistema_alvo": "ERP Web",
    "categoria": null,
    "estimativa_custo": { "codigo": "C", "rotulo": "C · R$ 200 a R$ 400", "min": 200, "max": 400 },
    "custo_final": null
  },
  "autor": null,
  "mensagem": null,
  "mudanca": { "de": "B", "para": "C" },
  "aprovacao": null,
  "linkChamado": "https://<dominio>/portal/chamados/<id>"
}
```

### 3.3 Valores possíveis

| Campo                     | Valores                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `status`                  | `novo` · `em_triagem` · `aguardando_cliente` · `em_atendimento` · `resolvido` · `fechado` · `cancelado` |
| `prioridade`              | `baixa` · `media` · `alta` · `urgente`                                                                  |
| `natureza`                | `problema` · `alteracao` · `duvida`                                                                     |
| `aprovacao.forma`         | `explicita` · `tacita`                                                                                  |
| `estimativa_custo.codigo` | `A` · `B` · `C` · `D` · `E` · `I`                                                                       |

Novos valores podem ser adicionados no futuro — trate valores desconhecidos de forma tolerante (não falhe o processamento).

## 4. O que o seu endpoint deve fazer

- **Responder rápido com 2xx** (`200` ou `204`). Qualquer status 2xx conta como entregue. O timeout da requisição é **curto** (poucos segundos): confirme o recebimento imediatamente e processe de forma assíncrona.
- **Não responder com redirect.** Redirecionamentos (3xx) **não são seguidos** e contam como falha.
- **Usar HTTPS** com certificado válido.

## 5. Entregas repetidas, retentativas e ordem

- **Retentativas:** se o seu endpoint responder 5xx, `408`, `429`, ou a requisição falhar por timeout/erro de rede, a plataforma re-tenta com intervalos crescentes (backoff exponencial, até 5 tentativas). Qualquer outro 4xx é tratado como erro de configuração e **não** é re-tentado.
- **Deduplicação:** o mesmo evento pode chegar mais de uma vez (por exemplo, se a sua resposta 2xx se perdeu na rede). Guarde os `x-chamados-event-id` já processados e ignore repetições.
- **Ordem não garantida:** retentativas e paralelismo podem entregar eventos fora de ordem. Use `evento.timestamp` e o estado atual em `chamado.status` em vez de assumir sequência.

## 6. Evento de teste

O botão "Enviar evento de teste" do painel dispara um `POST` real, assinado com o segredo configurado, com o header `x-chamados-event: teste` e o corpo:

```json
{
  "evento": { "tipo": "teste", "id": "<uuid>", "timestamp": "<ISO-8601>" },
  "teste": true,
  "mensagem": "Evento de teste enviado pelo painel do Chamados."
}
```

Se o seu endpoint trata apenas os tipos da §2, basta responder 2xx ao teste (o campo `teste: true` permite identificá-lo).

## 7. Desativação automática por falhas

Falhas de entrega consecutivas (sem nenhum sucesso entre elas) desativam o webhook automaticamente após atingir o limite configurado na plataforma (padrão: **10**). Quando isso acontece, os administradores da sua organização recebem um alerta por e-mail; após corrigir o endpoint, um administrador reativa o canal no painel. Qualquer entrega bem-sucedida zera o contador.

## 8. Boas práticas de segurança

- **Sempre** valide a assinatura (§3.1) antes de processar — é a única garantia de que a requisição veio da plataforma e não foi alterada.
- Guarde o segredo com o mesmo cuidado de uma senha: fora do código-fonte e fora de logs.
- Trate o payload como dado não confiável: valide/escape antes de exibir o conteúdo (ex.: `mensagem.trecho`) em qualquer interface.
- Se suspeitar de vazamento do segredo, gere um novo e atualize-o no painel — as próximas entregas passam a ser assinadas com ele imediatamente.
