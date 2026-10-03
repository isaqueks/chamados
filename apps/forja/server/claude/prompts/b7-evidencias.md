Este bloco vale em todo turno de implementação. Quem fotografa as telas é **você**: o app só coleta e confere o que ficar em `{{dir_evidencias}}`. Os prints vão para a tela de aprovação, ao lado do diff.

- **Se a sua implementação alterar qualquer tela ou componente visual** (página, componente, estilo, texto que aparece na tela), **antes de tocar no código** fotografe as telas que vão mudar e siga os passos abaixo.
- **Se não alterar UI**, não suba nada: escreva `{{dir_evidencias}}/telas.json` com `{ "nao_se_aplica": true }`. O app confere com o diff — se ele tocar arquivo de interface, a aprovação mostra que você declarou não alterar UI.

{{etapa_antes}}

**Depois de implementar e verificar:** suba a aplicação de novo e fotografe as **mesmas** telas (mesma rota, mesmo estado, mesmo viewport) e as telas novas, em `{{dir_evidencias}}/depois/<id>.png`.

**Utilitário:** `node {{forja_print}} <url> <saida.png> [--viewport 1366x768] [--espera <ms>|<seletor>] [--storage <state.json>] [--full]` (também em `$FORJA_PRINT`; usa o Chromium da Forja, o repositório não precisa ter Playwright). Pode usar Playwright direto se preferir.

**Como subir o app:** do jeito que achar melhor — README, scripts do `package.json`, o `.env` de desenvolvimento que estiver na worktree — numa **porta livre** (nunca a 3000). Se precisar de login, use ou crie um usuário de **desenvolvimento**. Nunca use dado ou credencial de produção.

**Registro:** escreva com `Bash` (heredoc; não use `Write` fora da worktree) o arquivo `{{dir_evidencias}}/telas.json`:

```json
[
  {
    "id": "UI1",
    "descricao": "…",
    "rota": "/…",
    "antes": "antes/UI1.png",
    "depois": "depois/UI1.png"
  }
]
```

- Use os ids de `telas_afetadas` do plano quando a tela estiver lá ({{telas_plano}}); tela nova ganha id novo (`UI<n>`), `"antes": null` e `"motivo_sem_antes": "tela nova"`.
- Sem alteração de UI: `{ "nao_se_aplica": true }` (sem telas).
- Se não conseguir subir o app ou logar, escreva `{ "telas": [], "motivo_geral": "<o que impediu, honestamente>" }` — nunca invente um print.
- Ao terminar, **derrube tudo o que subiu** (app, banco de dev, navegador). Nenhum processo seu pode ficar rodando.
- Os prints não entram no commit: o diretório fica fora da worktree.
