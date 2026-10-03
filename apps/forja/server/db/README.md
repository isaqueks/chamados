# server/db — persistência local (SQLite)

Spec: `specs/forja/02-modelo-de-dados.md` (§1 convenções, §4 entidades, §5 invariantes, §7 diretório, §10 índices).

- `data-source.ts` — `abrirBanco(config)`: cria `<dados>/forja.db` (0600), PRAGMAs (WAL, `foreign_keys`, `busy_timeout=5000`, `synchronous=NORMAL`), `VACUUM INTO backups/` se houver migration pendente num banco existente (mantém 5) e migra. Falha → `ErroMigracao` com o caminho do backup.
- `banco.ts` — `BancoForja.transacao(async (r) => …)`: única porta de acesso. Transações serializadas (o driver tem uma conexão só); aninhar junta-se à corrente; erros de constraint saem como `ErroRestricao` com o código da invariante (`erros.ts`). Nunca aguarde rede/git/processo dentro.
- `entidades/` — `EntitySchema` de todas as tabelas de 02 §4; colunas JSON validadas por zod no transformer (`json.ts`).
- `migrations/` — SQL escrito à mão (`0000-init.ts`); enums vêm de `comum/estados.ts` e `@chamados/shared`. `0002-projeto-v2.ts` (FJ-030 §1): `projeto` passa a guardar só `ConfigProjeto` v2 (`branch_destino`/`sistemas` nulos = automáticos, `avancado` JSON estrito) + o cache `detectado`; projetos v1 convertidos por `converterConfigV1` (o que não é básico vai para `avancado`).
- `repositorios/` — funções finas por agregado (`r.execucoes`, `r.etapas`, `r.eventos`, `r.outbox`…).
- `persistencia-eventos.ts` — interface `PersistenciaEventos` + `PersistenciaEventosSqlite` (append-only, `seq` AUTOINCREMENT, replay `desde(seq)`).

Script: `npm run migration:run|migration:revert -w @chamados/forja` (`server/scripts/migrar.ts`).
