import { EntitySchema } from 'typeorm';
import type { AmbienteConexao, LocalSenha } from '../../../comum/estados';
import { pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `conexao_chamados` (specs/forja/02 §4.1): endereço + credencial de uma
 * instância do Chamados, com identidade de um operador dedicado (F-20).
 *
 * O token de sessão só existe cifrado (`token_cifrado`, envelope AES-256-GCM
 * com AAD = id, 02 §8) e a senha nunca está aqui — `local_senha` diz onde ela
 * mora (keyring, arquivo 0600 ou em lugar nenhum). `papel` diferente de
 * `operador`/`admin` é recusado por CHECK: a Forja publica como operador.
 */
export interface ConexaoChamados extends ComTempo {
  id: string;
  nome: string;
  url_base: string;
  tenant_slug: string | null;
  ambiente: AmbienteConexao;
  email: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  papel: string | null;
  token_cifrado: string | null;
  token_expira_em: string | null;
  local_senha: LocalSenha;
  ultimo_login_em: string | null;
}

export const ConexaoChamadosSchema = new EntitySchema<ConexaoChamados>({
  name: 'ConexaoChamados',
  tableName: 'conexao_chamados',
  columns: {
    id: pk(),
    nome: texto(),
    url_base: texto(),
    tenant_slug: texto(true),
    ambiente: texto(),
    email: texto(),
    usuario_id: texto(true),
    usuario_nome: texto(true),
    papel: texto(true),
    token_cifrado: texto(true),
    token_expira_em: texto(true),
    local_senha: texto(),
    ultimo_login_em: texto(true),
    ...tempo(),
  },
  uniques: [{ name: 'uq_conexao_chamados_nome', columns: ['nome'] }],
});
