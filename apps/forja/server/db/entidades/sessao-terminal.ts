import { EntitySchema } from 'typeorm';
import type { TipoSessaoTerminal } from '../../../comum/estados';
import { inteiro, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `sessao_terminal` (specs/forja/02 §4.15): um PTY aberto pela UI (F-13).
 * `livre` = `claude` interativo do usuário no repo/worktree; `assumida` =
 * `claude --resume <session_id>` de uma sessão do pipeline, com lock.
 *
 * I-2: uma sessão nunca roda no `-p` e no PTY ao mesmo tempo — único parcial
 * em `session_id_claude` para assumidas abertas; o cruzamento com
 * `etapa.session_id` executando é checado pelo repositório na mesma transação.
 */
export interface SessaoTerminal extends ComTempo {
  id: string;
  tipo: TipoSessaoTerminal;
  cwd: string;
  execucao_id: string | null;
  etapa_id: string | null;
  session_id_claude: string | null;
  pid: number | null;
  pgid: number | null;
  aberta_em: string;
  encerrada_em: string | null;
  sha_ao_devolver: string | null;
}

export const SessaoTerminalSchema = new EntitySchema<SessaoTerminal>({
  name: 'SessaoTerminal',
  tableName: 'sessao_terminal',
  columns: {
    id: pk(),
    tipo: texto(),
    cwd: texto(),
    execucao_id: texto(true),
    etapa_id: texto(true),
    session_id_claude: texto(true),
    pid: inteiro(true),
    pgid: inteiro(true),
    aberta_em: texto(),
    encerrada_em: texto(true),
    sha_ao_devolver: texto(true),
    ...tempo(),
  },
  indices: [
    {
      name: 'ux_sessao_terminal_assumida_aberta',
      columns: ['session_id_claude'],
      unique: true,
      where: `"encerrada_em" IS NULL AND "tipo" = 'assumida' AND "session_id_claude" IS NOT NULL`,
    },
  ],
  checks: [
    {
      name: 'ck_sessao_terminal_assumida',
      expression: `"tipo" <> 'assumida' OR ("execucao_id" IS NOT NULL AND "etapa_id" IS NOT NULL AND "session_id_claude" IS NOT NULL)`,
    },
  ],
});
