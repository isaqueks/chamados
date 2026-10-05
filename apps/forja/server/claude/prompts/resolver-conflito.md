A branch de destino `{{destino}}` avançou depois da aprovação e a integração deste chamado conflitou. A Forja já começou o merge nesta worktree (`git merge --no-commit {{sha_destino}}`): os arquivos abaixo estão com marcadores de conflito.

Arquivos em conflito:

{{arquivos}}

O que fazer (resolver conflito é trabalho seu, não do humano — ele só reaprova no fim):

1. **Entenda as duas intenções.** A sua: o plano aprovado (nos insumos) e o que você implementou. A do destino: para cada arquivo, `git log {{faixa_destino}} -- <arquivo>` e `git diff {{faixa_destino}} -- <arquivo>`.
2. **Resolva preservando as duas.** Delegue ao `implementador` (um por arquivo ou grupo de arquivos relacionados) com as duas intenções descritas. Nunca descarte o lado do destino inteiro só para o seu código passar, nem o contrário. Remova todos os marcadores (`<<<<<<<`, `=======`, `>>>>>>>`).
3. **Confira.** Rode os checks que o projeto tiver (typecheck, lint, testes, build) e corrija o que a integração quebrou.
4. **Telas.** Se a resolução mexeu em interface, refaça só os prints `depois` (bloco "Evidências visuais").
5. **Não commite.** Nada de `git commit`, `git merge --abort`, `git reset`, `git checkout -- <arquivo>` ou troca de branch: a Forja confere os marcadores e commita o merge quando você terminar.

Saída `resumo_impl.v1` com `ciclo` = {{ciclo}}: em `passos`, os passos do plano que a resolução tocou (`arquivos_alterados` = os arquivos que você resolveu); em `resumo_tecnico`, como resolveu cada arquivo (o que veio do destino, o que ficou do chamado). Escolhas de resolução vão em `bloqueios` como "Adotado: …" (não param a execução); só escreva `sem suposição: <motivo>` se não houver resolução razoável sem um humano.
