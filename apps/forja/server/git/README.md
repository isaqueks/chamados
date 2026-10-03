# server/git

Git do app (sempre `core.hooksPath=/dev/null`). Spec: `specs/forja/01-arquitetura.md` §9, `03-pipeline.md` §8, `04-agentes-e-contratos.md` §7, `05-seguranca.md` §9.

- `git.ts` — exec do git com credenciais redigidas (`ErroGit`, `resolverSha`, `statusPorcelain`, `ehAncestral`).
- `worktrees.ts` — worktree por execução (cópia de `arquivos_locais`), worktree destacada (integração e `_integracao/base-<exec8>` dos prints), órfãs, remoção/prune.
- `checkpoint.ts` — commit por passo (só com algo no índice; `arquivos_locais` preservados).
- `selos.ts` — selos por caminho sobre `<base>...<sha>` (glob próprio, `dot: true`); `dependencias_novas` à parte.
- `integracao.ts` — fila de merge: pré-checagem de conflito, merge na destacada, `patch-id`, CAS da ref local, push sem force (credencial só na URL HTTPS, `credential.helper` vazio), cópia suja (só rastreados).

`apoio-testes.ts` monta repositórios temporários; os testes usam git real, sem rede.
