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

| `evento.tipo`         | Disparado quando…                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `criado`              | Um chamado é aberto.                                                                             |
| `mensagem_publica`    | Uma nova mensagem pública é publicada na conversa do chamado.                                    |
| `status_alterado`     | O status do chamado muda — inclui **reabertura** e **cancelamento** (ambos são mudanças de status). |
| `prioridade_alterada` | A prioridade do chamado é alterada.                                                              |
| `atribuicao`          | Um atendente é atribuído ao chamado (ou desatribuído).                                           |
| `resolvido`           | O chamado é marcado como resolvido.                                                              |
| `fechado`             | O chamado é fechado.                                                                             |

## 3. A requisição

`POST` com `Content-Type: application/json` e os seguintes headers:

| Header                 | Conteúdo                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `x-chamados-signature` | `sha256=<hex>` — HMAC SHA-256 do corpo bruto, calculado com o segredo.   |
| `x-chamados-event`     | Tipo do evento (§2).                                                     |
| `x-chamados-event-id`  | Identificador único do evento — use para deduplicar (§5).                |

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
    "tipo": "status_alterado",        // tipo do evento (§2)
    "id": "8f2c…",                    // mesmo valor do header x-chamados-event-id
    "timestamp": "2026-07-20T14:03:11.000Z"  // ISO-8601, UTC
  },
  "chamado": {
    "id": "uuid",
    "numero": "2026-000123",          // número legível do chamado
    "titulo": "Erro ao emitir nota",
    "status": "em_atendimento",
    "prioridade": "alta",
    "natureza": "problema",
    "sistema_alvo": "ERP Web",        // sistema relacionado, ou null
    "categoria": "Financeiro"         // categoria, ou null
  },
  // Presentes apenas em mensagem_publica (texto puro, limitado a ~240 caracteres):
  "autor": { "nome": "Maria Silva" },
  "mensagem": { "trecho": "Boa tarde! O erro acontece quando…" },
  // Presente apenas em status_alterado / prioridade_alterada:
  "mudanca": { "de": "em_triagem", "para": "em_atendimento" },
  // Link direto para o chamado na plataforma:
  "linkChamado": "https://<dominio>/portal/chamados/<id>"
}
```

Campos condicionais vêm `null` quando não se aplicam ao evento.

### 3.3 Valores possíveis

| Campo        | Valores                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `status`     | `novo` · `em_triagem` · `aguardando_cliente` · `em_atendimento` · `resolvido` · `fechado` · `cancelado` |
| `prioridade` | `baixa` · `media` · `alta` · `urgente`                                                        |
| `natureza`   | `problema` · `alteracao` · `duvida`                                                           |

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
