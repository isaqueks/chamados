# server/eventos

Barramento de eventos da UI (specs/forja/01 §8; 02 §4.8; FJ-027).

- `barramento.ts` — `BarramentoEventos`: anel em memória, assinantes síncronos, clientes SSE com buffer próprio (`conectarCliente`; cliente lento recebe `sistema.recarregar`). Em produção o evento é gravado no SQLite e só depois do commit chega aqui por `difundir(eventoPersistido)`.
- `normalizador.ts` — stream da CLI → `EventoForja`, com `Redator` e payload enxuto (≤ 8 KB).
- `gravador-bruto.ts` — `etapas/<n>/eventos.jsonl` e `stderr.log`.
- `persistencia.ts` · `anel.ts` — contrato da persistência append-only (o `seq` vem do banco) e os buffers em anel (`AnelLimitado`, `FilaCliente` por cliente).
