import { ConexaoChamadosSchema, type ConexaoChamados } from '../entidades/conexao-chamados';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `conexao_chamados` (specs/forja/02 §4.1, §8). Só lida com o
 * envelope JÁ cifrado do token (`token_cifrado`): cifrar/decifrar é de
 * `server/segredos` (AES-256-GCM, AAD = id da conexão), que nunca entrega o
 * token em claro para cá.
 */

export type NovaConexao = Pick<
  ConexaoChamados,
  'nome' | 'url_base' | 'ambiente' | 'email' | 'local_senha'
> & { tenant_slug?: string | null };

export type PatchConexao = Partial<
  Pick<ConexaoChamados, 'nome' | 'url_base' | 'tenant_slug' | 'ambiente' | 'email' | 'local_senha'>
>;

export interface DadosLogin {
  usuario_id: string;
  usuario_nome: string;
  papel: string;
  token_cifrado: string;
  token_expira_em: string | null;
}

export class RepositorioConexoes extends RepositorioBase {
  async criar(dados: NovaConexao): Promise<ConexaoChamados> {
    const agora = this.agora();
    const linha: ConexaoChamados = {
      id: novoId(),
      nome: dados.nome,
      url_base: dados.url_base,
      tenant_slug: dados.tenant_slug ?? null,
      ambiente: dados.ambiente,
      email: dados.email,
      usuario_id: null,
      usuario_nome: null,
      papel: null,
      token_cifrado: null,
      token_expira_em: null,
      local_senha: dados.local_senha,
      ultimo_login_em: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ConexaoChamadosSchema, linha);
    return linha;
  }

  obter(id: string): Promise<ConexaoChamados | null> {
    return this.obterPorId(ConexaoChamadosSchema, id);
  }

  exigir(id: string): Promise<ConexaoChamados> {
    return this.exigirPorId(ConexaoChamadosSchema, id);
  }

  obterPorNome(nome: string): Promise<ConexaoChamados | null> {
    return this.m.findOne(ConexaoChamadosSchema, { where: { nome } });
  }

  listar(): Promise<ConexaoChamados[]> {
    return this.m.find(ConexaoChamadosSchema, { order: { nome: 'ASC' } });
  }

  async atualizar(id: string, patch: PatchConexao): Promise<ConexaoChamados> {
    await this.atualizarPorId(ConexaoChamadosSchema, id, patch);
    return this.exigir(id);
  }

  /** Login bem-sucedido: identidade do operador + envelope do token (F-16, F-20). */
  async gravarLogin(id: string, login: DadosLogin): Promise<void> {
    await this.atualizarPorId(ConexaoChamadosSchema, id, {
      ...login,
      ultimo_login_em: this.agora(),
    });
  }

  /** `401` persistente ou logout: o envelope some, a identidade fica para exibição. */
  async limparToken(id: string): Promise<void> {
    await this.atualizarPorId(ConexaoChamadosSchema, id, {
      token_cifrado: null,
      token_expira_em: null,
    });
  }
}
