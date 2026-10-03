import { Init1790000000000 } from './0000-init';
import { RemotoUrl1790000000001 } from './0001-remoto-url';
import { ProjetoV21790000000002 } from './0002-projeto-v2';
import { Fj032VerificacaoPeloAgente1790000000003 } from './0003-fj032-verificacao-pelo-agente';

/**
 * Migrations da Forja, em ordem (specs/forja/02 §1). Valor novo de enum =
 * migration nova que RECRIA a tabela (o SQLite não altera CHECK): com
 * `transaction = false`, ela desliga `foreign_keys` (o PRAGMA não muda dentro de
 * transação), abre a própria transação, recria, chama
 * `conferirChavesEstrangeiras` antes do COMMIT e religa `foreign_keys`.
 */
export const MIGRACOES = [
  Init1790000000000,
  RemotoUrl1790000000001,
  ProjetoV21790000000002,
  Fj032VerificacaoPeloAgente1790000000003,
];
