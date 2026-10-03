# server/configuracoes

Configurações globais (FJ-030 §2) em `<dados>/configuracoes.json`: modelos (orquestrador/subagentes), cota, concorrência, limites (ciclos, orçamento, timeouts) e gates. O projeto só sobrescreve pelo `avancado`.

- `armazem.ts` — `ArmazemConfiguracoes`: `ler()` (cache; ausente = padrões; corrompido = `ErroConfiguracoes`, nunca padrão em silêncio), `gravar()` (parcial completado pelos padrões, escrita atômica 0600), `restaurar()`, `aoMudar()` (o núcleo reajusta os semáforos de concorrência na hora).

Rotas: `configuracoes_obter`/`configuracoes_gravar`/`configuracoes_restaurar` (`ServicosForja`).
