# server/segredos

`abrirSegredos({dirDados, keyring?, arquivo?, semKeyring?})`: keyring do SO (`@napi-rs/keyring`) com fallback `credenciais.json` 0600 (motivo registrado; `FORJA_SEM_KEYRING=1` força) e cifra AES-256-GCM do token com AAD = id da conexão.
Spec: `specs/forja/02-modelo-de-dados.md` §8 e `05-seguranca.md` §8–§9. [NV] o keyring ainda não foi exercitado numa máquina real.
