# server/projetos

Autodetecção do projeto (specs/forja/02 §4.2; FJ-030 §1): a única coisa obrigatória é a pasta do repositório.

- `autodeteccao.ts` — `autodetectarProjeto(repo_dir)`: raiz (`git rev-parse --show-toplevel`), remoto (`origin` ou o único), branch (`origin/HEAD` → `main` → `master` → atual), gerenciador pelo lockfile (`npm ci`, `pnpm i --frozen-lockfile`, `yarn --frozen-lockfile`, `bun i`), comandos pelos `scripts` do `package.json` (typecheck, lint, testes, build, e2e — sempre na raiz, workspaces inclusive), `.env` fora do git como arquivo local copiado e detectores por convenção. Lacuna vira `avisos`; só "não é repositório git" é erro (`ErroRepositorio`).
- `casarSistemas` / `sistemasDoProjeto` / `montarCasamento` — sistemas-alvo do Chamados pelo nome normalizado (sem acento/caixa/separadores; igualdade, nunca "contém"), sem tomar sistema de outro projeto.

O resultado é gravado em `projeto.detectado` (cache, refeito ao abrir a tela e ao criar cada execução) e entra em `resolverConfig` (`comum/config-projeto.ts`).
