# 06 — Notificações e Gateways

Este documento especifica a camada de notificações da plataforma **Chamados**: a arquitetura de gateways plugáveis (adapter pattern), os adapters de fase 1 (e-mail SMTP e webhook genérico) e os canais futuros (WhatsApp e outros), a matriz de eventos notificáveis × destinatários, os templates com branding por tenant, as preferências por usuário, e o tratamento de fila, retries e idempotência. Cobre também o canal inbound (responder chamado por e-mail/WhatsApp) como item de fase futura.

Escopo relacionado tratado em outros documentos (não duplicar aqui):

- Configuração de canais por tenant e branding assets: `07-multitenancy-whitelabel.md`.
- Schema físico das entidades `CanalNotificacao` e `PreferenciaNotificacao`: `02-modelo-de-dados.md`.
- Eventos de domínio (`EventoChamado`) e máquina de estados que dispara as notificações: `04-chamados.md`.
- Filas BullMQ / Redis a nível de infraestrutura: `01-arquitetura.md`.

Atende diretamente ao requisito **RF-18** (gateways plugáveis: WhatsApp, e-mail etc., arquitetura plugável).

---

## 1. Princípios

1. **Adapter pattern obrigatório**: todo canal de saída implementa a mesma interface. Adicionar WhatsApp, SMS, Slack ou push nunca deve exigir alteração no núcleo de disparo de notificações.
2. **Notificação como efeito de evento de domínio, não como chamada acoplada**. O código de negócio emite um `EventoChamado`; um dispatcher assíncrono decide quem notificar, por quais canais, e enfileira os envios. Nenhum handler de request web envia e-mail de forma síncrona.
3. **Idempotência de ponta a ponta**: um mesmo evento nunca gera duas notificações para o mesmo destinatário no mesmo canal, mesmo com retries de fila ou reprocessamento.
4. **Tenant-first**: templates, remetente, branding e credenciais de gateway são sempre resolvidos pelo `tenant_id` do chamado. Nunca há vazamento de branding ou remetente entre tenants.
5. **Preferência do usuário é soberana** dentro dos limites de eventos obrigatórios (ver §7).

---

## 2. Arquitetura de gateways plugáveis

```mermaid
flowchart LR
  A[Evento de domínio\nEventoChamado] --> B[NotificationDispatcher]
  B --> C{Resolver destinatários\n+ preferências}
  C --> D[Fila BullMQ\nnotification.send]
  D --> E1[Worker: EmailSmtpAdapter]
  D --> E2[Worker: WebhookAdapter]
  D --> E3[Worker: WhatsAppAdapter ...futuro]
  E1 --> F1[(SMTP)]
  E2 --> F2[(Sistema externo do tenant)]
  E3 --> F3[(WhatsApp API)]
  E1 --> G[NotificationLog\nidempotência + status]
  E2 --> G
  E3 --> G
```

Componentes:

- **NotificationDispatcher**: recebe o evento, resolve destinatários (§6), aplica preferências (§7), monta um `NotificationJob` por (destinatário × canal) e enfileira. É a única peça que conhece a regra de "quem recebe o quê".
- **Fila `notification.send`** (BullMQ, ver `01-arquitetura.md`): desacopla o disparo do envio e provê retry/backoff.
- **Adapters**: um worker por tipo de canal, cada um implementando `NotificationGateway`. O adapter só sabe _entregar uma mensagem já renderizada_ por um transporte específico. Não conhece regra de negócio.
- **TemplateRenderer**: transforma `(evento, dados, brandingDoTenant, locale)` em payload por canal (§5).
- **NotificationLog**: registro de cada tentativa de entrega — base da idempotência e do status observável.

### 2.1 Contrato do adapter (TypeScript conceitual)

```ts
// Tipo de canal suportado pela plataforma.
type CanalTipo = 'email' | 'whatsapp' | 'sms' | 'push' | 'webhook';

// Payload já renderizado e pronto para transporte.
interface NotificationPayload {
  canal: CanalTipo;
  destino: string; // e-mail, telefone E.164, device token, URL...
  assunto?: string; // usado por e-mail
  corpoTexto: string; // fallback text/plain
  corpoHtml?: string; // e-mail
  // Para canais estruturados (WhatsApp templates aprovados):
  templateExterno?: {
    nome: string; // nome do template aprovado no provider
    idioma: string; // ex.: pt_BR
    variaveis: Record<string, string>;
  };
  anexos?: Array<{ nome: string; contentType: string; url: string }>;
}

interface EnvioResultado {
  status: 'entregue' | 'aceito' | 'falha_temporaria' | 'falha_permanente';
  idExterno?: string; // message id do provider (para conciliação/webhook)
  erro?: string;
  custoEstimado?: number; // em centavos, quando o provider expõe
}

interface NotificationGateway {
  readonly tipo: CanalTipo;

  // Valida credenciais/configuração do canal do tenant sem enviar nada real.
  verificarConfig(config: CanalConfig): Promise<{ ok: boolean; detalhe?: string }>;

  // Envia uma notificação já renderizada.
  enviar(payload: NotificationPayload, config: CanalConfig): Promise<EnvioResultado>;

  // Opcional: normaliza callbacks de status do provider (delivery receipts).
  interpretarWebhook?(req: unknown): Promise<StatusExterno[]>;
}

// Config de canal do tenant — schema/persistência em CanalNotificacao (02-modelo-de-dados.md).
interface CanalConfig {
  tenantId: string;
  tipo: CanalTipo;
  segredos: Record<string, string>; // credenciais cifradas em repouso
  remetente?: string; // "Suporte ACME <suporte@acme.com>"
  ativo: boolean;
}
```

Regras do contrato:

- `enviar` **não** implementa retry — o retry é responsabilidade da fila. O adapter apenas classifica o resultado (`falha_temporaria` → BullMQ re-tenta; `falha_permanente` → descarta e loga).
- O adapter **nunca** monta template de negócio; recebe `NotificationPayload` já renderizado.
- Registro/seleção de adapters via um `GatewayRegistry` (map `CanalTipo → NotificationGateway`), populado no boot do worker.

---

## 3. Adapters de Fase 1

O MVP entrega **dois** canais de saída sob a mesma abstração `NotificationGateway` (D-003): e-mail SMTP (§3.1) e webhook genérico (§3.2).

### 3.1 Adapter de e-mail (SMTP)

- Transporte: SMTP genérico (Nodemailer ou equivalente). Compatível com provedores transacionais (Amazon SES, Resend, Postmark, SMTP próprio do tenant).
- `segredos`: `host`, `port`, `user`, `pass` (ou API key), `secure`.
- Remetente: `remetente` do `CanalConfig`; quando ausente, usa remetente default da plataforma com display name do tenant.
- HTML + fallback text/plain sempre presentes.
- **Deliverability**: exigir SPF/DKIM/DMARC no domínio remetente do tenant. Onboarding de domínio é assunto de `07-multitenancy-whitelabel.md`.
- **Bounce/complaint**: capturar via webhook do provedor (quando houver) → marcar `PreferenciaNotificacao` de e-mail como suspensa para o endereço; evitar reenvio a endereços em hard bounce.

> DECISÃO PENDENTE: provedor SMTP default da plataforma (SES vs Resend vs Postmark). Critérios: custo por 1k e-mails, suporte a domínios verificados por tenant via API, qualidade de webhooks de bounce.

### 3.2 Adapter de Webhook genérico

Gateway de saída de **fase 1** (D-003), ao lado do SMTP. O tenant já possui um sistema externo pronto que recebe o webhook e faz a entrega das mensagens aos destinatários finais; o Chamados apenas o notifica a cada atualização de chamado. Usa o `CanalTipo` `'webhook'` (§2.1).

**Natureza do canal.** Diferente do e-mail, o webhook é um canal **por tenant** (não por usuário): dispara **uma vez** por evento qualificável, independentemente de `PreferenciaNotificacao` individual. É configurado e ativado no nível do `CanalNotificacao` do tenant.

**Configuração por tenant** (`CanalConfig.segredos`):

- `url` — endpoint HTTPS que recebe o `POST`.
- `segredo` — chave usada para assinar o corpo (HMAC).

**Requisição.** `POST` com corpo JSON e `Content-Type: application/json`. O corpo é assinado com **HMAC SHA-256** usando o `segredo` do tenant; a assinatura vai em header (ex.: `X-Chamados-Signature: sha256=<hex>`), permitindo ao receptor validar autenticidade e integridade. Inclui também header de evento (ex.: `X-Chamados-Event`) e o `id` do evento para deduplicação no receptor.

**Eventos** (atualizações de chamado): criado, nova mensagem `publica`, mudança de status, mudança de prioridade, mudança de atribuição, resolvido e fechado — os mesmos eventos da §6 aplicáveis ao tenant — e, desde a **D-042**, `aprovado` e `contestado`. Tipos (`evento.tipo` / `X-Chamados-Event`): `criado`, `mensagem_publica`, `status_alterado` (inclui reabertura e cancelamento), `prioridade_alterada`, `atribuicao`, `resolvido`, `fechado` (**só** fechamento manual pela equipe), `aprovado` (o cliente aprovou a resolução — `aprovacao.forma = 'explicita'`, com `autor` — ou o prazo venceu sem resposta — `forma = 'tacita'`, sem autor) e `contestado` (o cliente contestou; `autor`, `mensagem.trecho` com o motivo público). A aprovação **nunca** emite também `fechado` (um fato, um evento). Desde a **D-043**: `estimativa_custo_alterada` (a equipe definiu/alterou/removeu a faixa — `mudanca` com os códigos, ex. `{de: null, para: "B"}`) e `custo_final_definido` (o custo final foi corrigido com o chamado `resolvido` — `mudanca` com números em BRL, ex. `{de: 150, para: 180.5}`; o custo informado **no ato de resolver** não gera este tipo: vai em `chamado.custo_final` do próprio `resolvido`). Guia de integração: `docs/webhooks.md`.

**Payload** — dados do chamado e do evento suficientes para o sistema externo compor a mensagem: `evento` (tipo + timestamp + id), `chamado` (número, título, status, prioridade, natureza, sistema-alvo/categoria), autor e trecho **público** da mensagem quando aplicável, `mudanca` (`{de, para}`) em mudança de status/prioridade, `aprovado` e `contestado`, `aprovacao` (`{forma}`, só em `aprovado` — D-042) e `linkChamado`. O objeto `chamado` carrega **sempre** `estimativa_custo` (`{codigo, rotulo, min, max}` ou `null`) e `custo_final` (número em BRL ou `null`) — D-043; são campos públicos (o cliente os vê), então podem ir ao integrador. **NUNCA** inclui conteúdo interno: notas `interna`, `complexidade`, diagnóstico/SPEC, dados de `ExecucaoIA` ou qualquer campo restrito a operador/admin/agente_ia (mesma regra da §5; ver `09-seguranca-lgpd.md`).

**Entrega, retries e idempotência.** Reaproveita a infraestrutura de fila já especificada: cada disparo é um `NotificationJob` em `notification.send`, com **backoff exponencial** (§8.2) e idempotência via `NotificationLog` (§8.3) — `idempotencyKey = hash(eventoId + tenantId + 'webhook')` evita `POST`s duplicados em reprocessamento. Desde a D-042, o `eventoId` é o **id do `EventoChamado`** que originou a notificação (o auditor fixa o id antes de gravar), então a chave é determinística por fato auditado. **Garantia de entrega da aprovação tácita (D-042):** a cada varredura de manutenção, todo `chamado_fechado_auto` (`aprovacao = tacita`) das últimas 24 h sem linha no `NotificationLog` para a chave do webhook é republicado — job ainda na fila é deduplicado pelo `jobId`, job já processado (sucesso ou falha) é pulado; canal desativado não gera job. `enviar` classifica o resultado (`falha_temporaria` → re-tenta; `falha_permanente` → DLQ), sem implementar retry próprio (§2.1).

**Robustez.** Timeout **curto** por requisição (o worker impõe o limite; resposta 2xx = aceito). Após **N falhas consecutivas** (configurável), o canal é **desativado automaticamente** e um **alerta é enviado ao admin** do tenant, evitando fila entupida e retentativas infinitas contra um endpoint morto. A reativação é manual, após o admin corrigir o destino.

---

## 4. Adapter de WhatsApp — futuro (sem prioridade)

> DECIDIDO (2026-07-15): WhatsApp sai do horizonte imediato — **futuro, sem prioridade** (D-003). A análise comparativa de providers abaixo permanece como referência para quando/se o canal for retomado. — ver specs/decisoes.md (D-003).

WhatsApp exige **template pré-aprovado** para mensagens iniciadas pela empresa fora da janela de 24h de atendimento. Isso molda o design: notificações proativas usam `templateExterno` (§2.1), não texto livre.

### 4.1 Comparação de providers

| Critério                  | Meta WhatsApp Cloud API (oficial)                              | Evolution API (não oficial)                                     | Twilio (BSP oficial)                                                 |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Oficialidade**          | Oficial, direto da Meta                                        | **Não oficial** — automação sobre WhatsApp Web/multi-device     | Oficial, Meta Business Solution Provider                             |
| **Custo**                 | Preço por conversa da Meta; sem markup de BSP; hosting próprio | Sem custo de licença (open source); custo só de infra/VPS       | Preço da Meta **+ markup por mensagem** da Twilio                    |
| **Risco de bloqueio**     | Baixo (dentro dos ToS)                                         | **Alto** — viola ToS; número pode ser banido a qualquer momento | Baixo (dentro dos ToS)                                               |
| **Templates aprovados**   | Sim, fluxo oficial de aprovação                                | Não se aplica (texto livre, mas sob risco)                      | Sim, via console Twilio                                              |
| **Webhooks de status**    | Nativos (sent/delivered/read)                                  | Depende da lib/eventos internos                                 | Nativos, normalizados                                                |
| **Esforço de integração** | Médio (registrar app, número, verificação)                     | Baixo para PoC, alto para produção estável                      | Baixo (SDK maduro)                                                   |
| **Escala multi-tenant**   | Um WABA por tenant, ou números sob um WABA                     | Um número/instância por tenant (frágil)                         | Subcontas Twilio por tenant                                          |
| **Recomendação**          | **Padrão para produção**                                       | Só dev/PoC interno, nunca produção                              | Alternativa se o tenant já usa Twilio ou quer terceirizar compliance |

Leitura: **Meta Cloud API** como implementação de referência do `WhatsAppAdapter`; **Twilio** como segundo adapter opcional (mesma interface `NotificationGateway`, `segredos` diferentes); **Evolution API** desaconselhada para produção pelo risco de banimento do número — aceitável apenas em ambiente de desenvolvimento.

> DECISÃO PENDENTE: provider WhatsApp de produção (Meta Cloud API direto vs Twilio). Trade-off central: custo por mensagem (Meta menor) vs esforço de compliance/onboarding de WABA por tenant (Twilio abstrai). Decidir junto de `07-multitenancy-whitelabel.md` (provisionamento de número por tenant).

### 4.2 Considerações do adapter

- Notificação proativa (chamado criado, mudança de status) → sempre `templateExterno` aprovado, com variáveis (número do chamado, título, status).
- Resposta dentro da janela de 24h (após inbound do cliente) → texto livre permitido; relevante para o canal inbound (§9).
- Mapear telefone do `Usuario` em E.164; validar consentimento (opt-in) antes de enviar — LGPD, ver `09-seguranca-lgpd.md`.

---

## 5. Templates e identidade visual

Cada evento notificável tem um **template por canal**.

- **Estrutura**: `template = f(eventoTipo, canal, locale)`. Implementado em TypeScript puro (`apps/worker/src/notificacoes/templates.ts` + `email-layout.ts`), HTML de e-mail com tabelas e estilos inline (sem Handlebars/MJML).
- **Layout único do e-mail (D-047)** — o visual da "Cobrança de Serviços" da consultoria, **igual para todos os tenants**:
  - **Logo** "Isaque Kanitz Schluter — Consultoria em Tecnologia da Informação" no topo, embutido como **imagem inline por Content-ID** (`cid:logo@chamados`, `apps/worker/assets/email/logo.png`, 600 px exibidos a 300 px) — não por URL (clientes escondem imagens remotas por padrão) nem `data:` URI (o Gmail bloqueia). O `NotificationPayload` carrega `imagensInline`; o adapter SMTP as envia como anexos `inline` (multipart/related).
  - **Cabeçalho:** título do documento por evento (ex.: "Chamado recebido", "Nova mensagem", "Chamado resolvido", "Convite de acesso") à esquerda; metadados à direita (**Chamado** `#número` e **Data** de emissão em dd/mm/aaaa, horário de Brasília); régua azul-marinho de 2 px.
  - **Corpo em seções** separadas por linhas cinza finas: a frase do evento; a mensagem pública ou o motivo da contestação (citação com barra marinho); o título do chamado com tópicos (status, prioridade, estimativa e custo final quando houver).
  - **Linha de destaque** (o "Total" do PDF: rótulo à esquerda, valor grande marinho à direita) por evento: custo final + prazo para aprovar (`resolvido`), faixa da estimativa (`estimativa_custo`), custo final (`custo_final`), novo status/prioridade (mudanças), status atual (demais); ausente em `mensagem_publica`/`contestado`.
  - **Botão** marinho: "Aprovar ou contestar" (`resolvido`, cliente), "Responder no portal" (`mensagem_publica`, cliente), "Ver chamado" (demais); transacionais imprimem também a URL para copiar.
  - **Rodapé do emitente:** "Isaque Schluter Consultoria em TI · CNPJ 51.943.042/0001-05" à esquerda; "Isaque Schluter · e-mail · telefone" à direita (também no texto/plain). Nota fora da folha: "Você recebeu este e-mail porque acompanha chamados em {nome do tenant}…".
  - Paleta: marinho `#0b4189`, títulos `#18212b`, texto `#3a4550`, divisórias `#d7dce2`, fundo `#eef0f3`; fonte Arial/Helvetica. No celular (≤ 600 px) as colunas do cabeçalho e do rodapé empilham.
- **Branding do tenant no e-mail:** só o remetente (`email_remetente_*`, `07` §3.1) e o nome na nota de rodapé. `cor_primaria` e os logos do tenant **não** entram (D-047) — mesma linha dos PDFs da IA (D-027).
- **Variáveis de contexto** por evento: `chamado.numero`, `chamado.titulo`, `chamado.status`, `chamado.prioridade`, `mensagem.autor`, `mensagem.trecho`, `linkChamado` (deep link para o portal do cliente ou painel do operador).
- **Localização**: default `pt_BR`; estrutura preparada para outros locales (chave por `locale`).
- **Camadas de override**: não há override por tenant (D-047); o template base é único.
- **Sanitização**: qualquer conteúdo vindo de mensagem de usuário (rich text) é **escapado/limpo** antes de entrar no HTML do e-mail (anti-XSS; ver `09-seguranca-lgpd.md`). Notas com `visibilidade=interna` **nunca** entram em notificação destinada a `cliente`.
- **Notas internas em notificações**: para destinatários `operador`/`admin`/`agente_ia`, mensagens `interna` podem ser resumidas; para `cliente`, apenas conteúdo `publica`.

Renderização produz `NotificationPayload` (assunto + HTML + texto para e-mail; `templateExterno` para WhatsApp).

---

## 6. Eventos notificáveis × destinatários

Eventos de domínio que disparam notificação. O autor da ação **não** é notificado da própria ação (regra do dispatcher). Papéis conforme brief: `admin`, `operador`, `cliente`, `agente_ia`.

| Evento                      | Gatilho                                                                                                                                                             | cliente (dono)                                                                                           | operador atribuído        | admin    | Obrigatório?                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- | -------- | ----------------------------- |
| Chamado criado              | cliente abre chamado (status `novo`)                                                                                                                                | Confirmação de abertura                                                                                  | Sim (novo na fila)        | Config   | Cliente: sim                  |
| IA pediu informações        | IA publica msg `publica` → `aguardando_cliente`                                                                                                                     | Sim                                                                                                      | Opcional                  | Não      | Cliente: sim                  |
| Nova mensagem pública       | mensagem `publica` de operador/IA                                                                                                                                   | Sim (se autor ≠ cliente)                                                                                 | Sim (se autor ≠ operador) | Não      | Preferência                   |
| Nova nota interna           | mensagem `interna`                                                                                                                                                  | **Nunca**                                                                                                | Sim                       | Opcional | Preferência                   |
| Mudança de status           | transição na máquina de estados                                                                                                                                     | Sim                                                                                                      | Sim                       | Não      | Preferência                   |
| Mudança de prioridade       | prioridade alterada                                                                                                                                                 | Sim                                                                                                      | Sim                       | Não      | Preferência                   |
| Atribuição de chamado       | operador atribuído/alterado                                                                                                                                         | Não                                                                                                      | Sim (novo responsável)    | Não      | Operador: sim                 |
| Resolvido                   | status → `resolvido`                                                                                                                                                | Sim — informa o **prazo para aprovar ou contestar** e que sem resposta será considerado aprovado (D-042) | Sim                       | Não      | Cliente: sim                  |
| Aprovado (D-042)            | cliente aprova (`chamado_aprovado`) **ou** prazo vence sem resposta (`chamado_fechado_auto` = aprovação tácita)                                                     | Sim na tácita (na explícita é o autor)                                                                   | Sim                       | Não      | Preferência                   |
| Estimativa de custo (D-043) | operador/admin define/altera/remove a faixa (`estimativa_custo_alterada`)                                                                                           | Sim (opt-in)                                                                                             | Sim (opt-in)              | Não      | Preferência (nasce desligado) |
| Custo final (D-043)         | custo final corrigido com o chamado `resolvido` (`custo_final_definido` **fora** do ato de resolver; no ato, o e-mail de Resolvido já mostra o valor)               | Sim                                                                                                      | Sim (se autor ≠ operador) | Não      | Preferência                   |
| Contestado (D-042)          | cliente contesta com motivo (`resolvido` → `em_atendimento`)                                                                                                        | Não (é o autor)                                                                                          | Sim                       | Não      | Operador: sim                 |
| Fechado                     | equipe fecha manualmente (`chamado_fechado`)                                                                                                                        | Sim                                                                                                      | Opcional                  | Não      | Preferência                   |
| Reabertura                  | operador reabre `resolvido`; cliente/operador reabre `fechado` ou `cancelado` → `em_atendimento` (D-038). A reabertura de `resolvido` pelo cliente é **Contestado** | Confirmação                                                                                              | Sim                       | Não      | Operador: sim                 |
| Cancelado                   | status → `cancelado`                                                                                                                                                | Sim                                                                                                      | Sim                       | Não      | Preferência                   |
| PR aberto pela IA           | IA cria branch/PR (nota interna)                                                                                                                                    | **Nunca**                                                                                                | Sim                       | Config   | Operador: sim                 |
| SPEC gerada pela IA         | IA publica SPEC de `alteracao` (nota interna)                                                                                                                       | **Nunca**                                                                                                | Sim                       | Config   | Operador: sim                 |

Notas:

- "Config" = configurável por tenant se admins recebem cópia (padrão: não, para reduzir ruído).
- D-043: o e-mail de **Resolvido** mostra o custo final quando informado; todo e-mail de chamado traz a linha "Estimativa de custo · Custo final" quando houver (dados públicos).
- Eventos com origem `agente_ia` seguem as mesmas regras: a IA age como operador automatizado; suas mensagens `publica` notificam o cliente, suas notas `interna` **nunca** notificam o cliente.
- Detalhes de quais transições existem e quem pode dispará-las: `04-chamados.md`.

---

## 7. Preferências por usuário

Persistidas em `PreferenciaNotificacao` (schema em `02-modelo-de-dados.md`). O dispatcher consulta antes de enfileirar.

- Granularidade: **(usuário × tipoEvento × canal) → habilitado**. Sem linha de preferência, vale o **default do catálogo** (`defaultDoEvento`, ajuste anti-flood 2026-07-17): eventos **ruidosos** — `mudanca_status`, `mudanca_prioridade` e, desde a D-043, `estimativa_custo` (alteração de campo) — nascem **DESLIGADOS** (opt-in na página de preferências); os demais nascem ligados. Motivo (caso real): uma triagem normal transita `novo → em_triagem → em_atendimento` e ajusta prioridade em minutos — com tudo ligado, cada chamado gerava 5+ e-mails de burocracia; os desfechos que importam (resolvido/fechado/reaberto/cancelado) têm eventos próprios e continuam notificando.
- **Eventos obrigatórios** não podem ser desabilitados (coluna "Obrigatório?" na §6) — ex.: confirmação de abertura, resolução, atribuição ao operador. Garante que o usuário não perca eventos de estado crítico.
- **Canal preferido**: usuário escolhe canais ativos (e-mail sempre disponível na fase 1; WhatsApp quando o tenant o habilitar). Se nenhum canal ativo restar para um evento obrigatório, e-mail é forçado como fallback.
- **Quiet hours / digest** (fase futura): agrupar notificações não urgentes em resumo. Não faz parte do MVP.
- **Opt-in de WhatsApp**: exige consentimento explícito registrado (LGPD, `09-seguranca-lgpd.md`) além da preferência.

> DECISÃO PENDENTE: existência de digest/quiet-hours no MVP. Recomendação: fora do MVP; entregar preferências booleanas por evento/canal primeiro.

---

## 8. Fila, retries e idempotência

### 8.1 Fluxo de fila

- Um `NotificationJob` por (evento × destinatário × canal), enfileirado em `notification.send`.
- Worker consome, resolve `CanalConfig` do tenant, renderiza template, chama `gateway.enviar`, grava resultado em `NotificationLog`.

### 8.2 Retries e backoff

- BullMQ com **backoff exponencial**: ex. tentativas `[30s, 2min, 10min, 1h, 6h]`, máximo 5.
- Só re-tenta em `falha_temporaria` (timeout, 5xx, rate limit do provider). `falha_permanente` (endereço inválido, template rejeitado, opt-out) vai direto para DLQ e loga, sem retry.
- Rate limit por tenant/canal para respeitar limites do provider (ex.: SES sending rate, tiers de WhatsApp).

### 8.3 Idempotência

- Cada `NotificationJob` carrega uma **chave de idempotência** determinística:
  `idempotencyKey = hash(eventoId + destinatarioId + canal)`.
- `NotificationLog` tem índice único sobre `idempotencyKey`. Antes de enviar, o worker faz _insert-if-not-exists_:
  - se já existe registro `entregue`/`aceito` → **skip** (evita duplicata em reprocessamento de fila);
  - se existe registro `falha_temporaria` → prossegue com nova tentativa, atualizando o mesmo registro.
- `jobId` do BullMQ = `idempotencyKey` para deduplicar enfileiramentos concorrentes do mesmo evento.
- Garantia: reprocessar um `EventoChamado` (replay, redeploy, at-least-once da fila) nunca duplica a entrega ao mesmo destinatário no mesmo canal.

### 8.4 Observabilidade

- `NotificationLog` registra: evento, destinatário, canal, status, `idExterno`, custo estimado, tentativas, timestamps.
- Webhooks de status do provider (delivered/read/bounce) atualizam o log via `interpretarWebhook` do adapter.
- Métricas: taxa de entrega, latência de envio, taxa de bounce por tenant/canal (alimenta métricas do `00-visao-geral.md`).

---

## 9. Canal inbound (fase futura)

Responder um chamado **respondendo o e-mail** ou **mandando mensagem no WhatsApp**, sem abrir o portal.

- **E-mail inbound**: endereço de resposta com token embutido — `chamado+<chamadoId>.<token>@inbound.tenant.com` (VERP-like) ou header `In-Reply-To`. Provedor de inbound parsing (SES receiving, Postmark inbound, Mailgun routes) faz POST do e-mail para um webhook; um parser cria uma `Mensagem` `publica` no chamado, com autor resolvido pelo token/remetente.
- **WhatsApp inbound**: mensagem do cliente dentro da janela de 24h → webhook → `Mensagem` no chamado. Abre janela para respostas em texto livre (§4.2).
- **Segurança**: validar assinatura do webhook do provider; validar que o remetente/token corresponde ao dono do chamado; **strip** de conteúdo citado ("quoted reply") e assinaturas; sanitização e limites de anexo iguais aos do portal (`04-chamados.md`, `09-seguranca-lgpd.md`).
- **Idempotência inbound**: `messageId` do provider como chave única para não duplicar a mensagem em reentregas do webhook.
- Reaproveita a arquitetura de adapters, invertida: um `InboundGateway` por canal normaliza o payload externo em um comando `CriarMensagem`.

> DECISÃO PENDENTE: incluir e-mail inbound já na fase 2 (junto do WhatsApp) ou deixar para fase 3. Recomendação: e-mail inbound na fase 2 (alto valor, baixo custo com provedor de inbound parsing); WhatsApp inbound acoplado ao adapter WhatsApp.

---

## 10. Resumo de decisões pendentes

- Provedor SMTP default da plataforma (SES vs Resend vs Postmark).
- Provider WhatsApp de produção (Meta Cloud API direto vs Twilio) — apenas quando o canal for retomado (futuro, sem prioridade; D-003).
- Digest/quiet-hours dentro ou fora do MVP.
- E-mail inbound na fase 2 vs fase 3.
