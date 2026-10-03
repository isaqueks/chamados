import { EntitySchema } from 'typeorm';
import { pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `mapeamento_sistema` (specs/forja/02 §4.3): liga um sistema-alvo do Chamados
 * a UM projeto. Enquanto D-036 L2 não expõe `sistema_alvo_id` na lista, o
 * casamento é pelo nome (frágil a renomeação — a UI avisa chamado sem projeto).
 * `conexao_id` é redundante com o projeto de propósito: é o que permite o
 * UNIQUE por conexão.
 */
export interface MapeamentoSistema extends ComTempo {
  id: string;
  projeto_id: string;
  conexao_id: string;
  sistema_alvo_id: string | null;
  sistema_nome: string;
}

export const MapeamentoSistemaSchema = new EntitySchema<MapeamentoSistema>({
  name: 'MapeamentoSistema',
  tableName: 'mapeamento_sistema',
  columns: {
    id: pk(),
    projeto_id: texto(),
    conexao_id: texto(),
    sistema_alvo_id: texto(true),
    sistema_nome: texto(),
    ...tempo(),
  },
  indices: [
    {
      name: 'ux_mapeamento_sistema_alvo',
      columns: ['conexao_id', 'sistema_alvo_id'],
      unique: true,
      where: '"sistema_alvo_id" IS NOT NULL',
    },
    { name: 'ux_mapeamento_sistema_nome', columns: ['conexao_id', 'sistema_nome'], unique: true },
    { name: 'ix_mapeamento_sistema_projeto', columns: ['projeto_id'] },
  ],
});
