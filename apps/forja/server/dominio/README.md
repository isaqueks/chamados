# server/dominio

Domínio **puro** do pipeline (sem I/O): o orquestrador lê SQLite/git, chama estas funções e aplica a
decisão (estado + `evento` na mesma transação). Spec: `specs/forja/03-pipeline.md` (§2.4 transições,
§4 gates, §6 ciclos, §7 lote e freio); `04-agentes-e-contratos.md` §6–§8.

| Módulo                | O que decide                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maquina-execucao.ts` | tabela `TRANSICOES`, `transicaoValida`, `aplicarTransicao` (laterais/`estado_anterior`), `proximoEstado`                                                            |
| `gates.ts`            | G0 em `preparando` (delega a `chamados/fila.ts`), G1/Gdec, exigências e conferência do G2/G2', Gdeploy                                                              |
| `ciclos.ts`           | contadores e limites, pingue-pongue (trigramas ≥ 0,8), decisão pós-veredito (sem `max_correcoes_verificacao` nem pingue-pongue de comandos, FJ-032)                 |
| `lote.ts`             | plano limpo, mesa de planos, ordem de início, semáforos (`podeIniciar`/`ocupar`/`liberar`; sem `verificacoes`, FJ-032), token `schema`, fila de merge, fase do lote |
| `freio-cota.ts`       | freio pelos limiares 5 h/7 d e overage, liberação no `resetsAt`, `pausado_cota`, termômetro                                                                         |
| `regras-contratos.ts` | regras em código de `plano.v1`, `resumo_impl.v1`, `veredito.v1` (04 §6)                                                                                             |
| `regras-relatorio.ts` | `relatorio.v1`: seções obrigatórias, selos × relatório (FJ-026), regerar/recusar/alertar, `tipo` da resposta                                                        |

Fluxo típico: `validarPlano` → `avaliarG1` → `proximoEstado(atual, { tipo: 'plano_avaliado', decisao })`.

## Orquestrador (com I/O)

| Módulo                    | O que faz                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nucleo.ts`               | deps injetadas (`DepsOrquestrador`), `transicionar` (estado + efeitos + `evento` numa transação; difunde depois do commit), vagas, `ErroForja`                                                                                                                                                                |
| `aplicacao-resultados.ts` | PURO: classificação do runner → fato da máquina, contadores derivados das etapas, artefatos ⚙ registrados, `acoesDisponiveis` (ExecucaoDto)                                                                                                                                                                   |
| `etapas.ts`               | preparar (G0, worktree, `arquivos_locais`; sem `setup` nem linha de base, FJ-032), planejar, T1, verificar = **coleta** (commit, `sha_verificado`, selos, evidências, comandos do T1 lidos do stream), T2 (nível relatado × stream), T3, conversar, T1 de conflito (`resolverConflito`, FJ-036); `rodarTurno` |
| `fila-merge.ts`           | 03 §8: integração destacada, patch-id, reverificação pelo revisor (turno T2 só se o destino andou ∧ interseção de arquivos, FJ-032), push/CAS, cópia suja; conflito → `decidirConflito` (agente resolve até 2×, `banco` → humano, FJ-036); reconciliação do boot (§9.5)                                       |
| `outbox.ts`               | 03 §9: rodadas (início, pergunta, replanejar, encerramento, descarte), despacho em ordem, backoff, `enviando` no boot, Gdeploy                                                                                                                                                                                |
| `retencao.ts`             | 02 §9: plano puro do que expira + aplicação                                                                                                                                                                                                                                                                   |
| `orquestrador.ts`         | despachante serializado (vagas/freio/ordem), boot (reconciliação + vagas), comandos humanos, lote/mesa, polling → sinais                                                                                                                                                                                      |
| `servicos.ts`             | fachada: uma função por rota JSON de `ROTAS_API` (`FachadaJson`), + `imagemEvidencia`/`logArtefato`; `erroParaApi`                                                                                                                                                                                            |

Testes de jornada (`orquestrador*.test.ts`, `fila-merge-outbox.test.ts`): SQLite real, git real com `origin` bare, Chamados falso e
`RunnerRoteirizado` (`apoio-orquestrador.test-apoio.ts`) — nenhum teste chama o `claude` real nem a rede.
