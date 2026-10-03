# server/chamados

Integração com o Chamados pela `/api/v1` (via `@chamados/cliente-api`). Spec: `specs/forja/07-integracao-chamados.md` e `04-agentes-e-contratos.md` §8.

- `conexao.ts` — `ConexaoChamados`: login, token cifrado, relogin 1×, estado da sessão, detecção da D-036 (`modoD036`); `validarUrlConexao` (recusa `127.0.0.1`).
- `fila.ts` — `consultarFila` (2× por natureza; `?complexidade=` só com D-036, filtro em memória sempre), `resolverProjeto`, `avaliarG0` (sem pré-condição de IA do servidor, FJ-031).
- `polling.ts` · `sinais.ts` · `notas-ia.ts` — `PollingChamados` dos chamados em voo, `compararDetalhe` → sinais (`cliente_respondeu`, status mudou; IA reativada/PR só informativos, FJ-031), notas da IA do servidor como dado não confiável.
- `cadeia-status.ts` — `calcularCadeia` pela `maquina-estados` de `@chamados/shared` (nunca `em_triagem → resolvido` nem `cancelado`; reabrir → `exige_reabrir`).
- `validador-linguagem.ts` — `validarRespostaPublica` (técnico, promessa, léxico extra com flexões, disponibilidade, `tamanho[]` não liberável) e `avaliarPublicacao`.
- `detector-segredos.ts` — `detectarSegredos`/`redigirSegredos` antes de qualquer nota ou mensagem (05 §8.2).
- `notas.ts` — notas de início/conclusão/descarte com o marcador `[forja:<execucao_id>:<momento>]` e mensagens-modelo; `hashCorpo`.
- `normalizacao.ts` — corpo normalizado para a anti-duplicata da pública (S7.7: ênfase `_x_` × `*x*` ainda não canonizada; o plano B dos 200 caracteres segura).
- `outbox-passos.ts` — `executarPasso`: um passo do outbox (07 §9; `silenciar_ia`/`reativar_ia` ficam por compatibilidade, nunca enfileirados — FJ-031) com a checagem "já feito?" (marcador + papel na interna; autor + janela + corpo na pública) e `traduzirErro`.

`servidor-falso.test-apoio.ts` é um `fetch` falso com a máquina de estados e os códigos de erro reais; nenhum teste chama a rede.
