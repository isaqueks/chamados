# server/processos

Supervisor de filhos (grupo próprio, escada SIGINT→SIGTERM→SIGKILL, timeouts, registro de pid/pgid),
leitura de `/proc` (`estaVivo`, varredura de cwd), ambiente por allowlist, lock por `session_id` e o
algoritmo de reconciliação do boot (devolve ações; quem aplica é o boot, via orquestrador).
Spec: `specs/forja/01-arquitetura.md` §3.2, §6.7, §6.8; `03-pipeline.md` §9.5, §11.
