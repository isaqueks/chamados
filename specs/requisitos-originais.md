# Requisitos Originais (fonte da verdade)

> Documento de rastreabilidade. Registra os requisitos como o usuário os expressou em 2026-07-15.
> As specs em `specs/*.md` devem cobrir 100% dos itens abaixo. Em caso de conflito, este documento prevalece até o usuário decidir.

## Contexto

- Sistema atual: **osTicket** — considerado obsoleto, demasiadamente complexo, antigo, com formulários grandes.
- Objetivo: sistema de chamados/suporte **prático e moderno**, integrado com IA.
- Modelo de negócio: **whitelabel multi-tenant**.

## Requisitos funcionais

### Papéis
- [RF-01] Três papéis humanos: **admin**, **operador** e **cliente** (usuário final).
- [RF-02] A **IA é também um usuário** do sistema (participa dos chamados).

### Chamados (visão do cliente)
- [RF-03] Cliente pode abrir chamados e acompanhar os chamados abertos.
- [RF-04] Cliente acompanha: status, mensagens, prioridade e histórico de chamados fechados.
- [RF-05] Descrição do chamado e mensagens em **rich text**, com **imagens e anexos**.
- [RF-06] Campo **natureza**: `problema` ou `alteracao` (cliente também pode pedir alterações no sistema).

### Chamados (visão operador/admin)
- [RF-07] Operador/admin têm acesso a mais informações que o cliente.
- [RF-08] **Notas internas** nos chamados (invisíveis ao cliente).
- [RF-09] **Grau de complexidade** (avaliação interna): `facil`, `medio`, `dificil`.

### Agente de IA
- [RF-10] Ao abrir um chamado, a IA deve tentar **entender** o problema.
- [RF-11] Se não entender, deve **solicitar mais informações** ao usuário.
- [RF-12] A IA **classifica o grau de complexidade** (Fácil, Médio, Difícil).
- [RF-13] A IA tem acesso ao **código-fonte do sistema, logs e banco de dados**.
- [RF-14] A cada chamado, a IA dá um **git pull** no código-fonte do sistema (conhecimento sempre atualizado).
- [RF-15] Se classificação = fácil **e** o problema foi bem compreendido: a **própria IA pode tentar resolver**.
- [RF-16] Se natureza = alteração: a IA publica **nota interna com a SPEC** da alteração, pronta para o dev colar na IA de desenvolvimento.
- [RF-17] Implementação fase 1: **Claude Code CLI com Opus 4.8**; mais tarde pode trocar de engine/modelo ("hermes ou algo assim") → exige **camada de abstração de provider**.

### Notificações
- [RF-18] Integração com **gateways de notificação**: WhatsApp, e-mail, etc. (arquitetura plugável).

### Multi-tenancy / Whitelabel
- [RF-19] Plataforma **whitelabel multi-tenant** (várias empresas, cada uma com sua marca).

## Requisitos não funcionais / princípios
- [RNF-01] Formulários mínimos — o oposto do osTicket.
- [RNF-02] UX moderna e rápida.
- [RNF-03] Metodologia: **spec-driven development** — primeiro os markdowns, depois o código.

## Processo de trabalho acordado
- Orquestração sempre pelo modelo principal (Fable); **subagentes sempre com Opus 4.8**.
