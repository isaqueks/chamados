import { describe, expect, it } from 'vitest';
import type { ConexaoDto } from '@comum/dto';
import {
  ambienteDaUrl,
  avisoPapel,
  ehLocalhost,
  formularioConexaoNovo,
  formularioSimplesDe,
  montarConexaoSimples,
  nomeDaConexao,
  problemaUrlBase,
  validarConexao,
} from './conexao';

describe('conexão com o Chamados (06 §4.9)', () => {
  it('URL base: só a origem, http(s), nunca 127.0.0.1; produção exige https', () => {
    expect(problemaUrlBase('http://localhost:3000', 'dev')).toBeNull();
    expect(problemaUrlBase('http://localhost:3000/', 'dev')).toBeNull();
    expect(problemaUrlBase('http://127.0.0.1:3000', 'dev')).toMatch(/localhost/);
    expect(problemaUrlBase('http://[::1]:3000', 'dev')).toMatch(/localhost/);
    expect(problemaUrlBase('https://x.com/api/v1', 'producao')).toMatch(/só a origem/);
    expect(problemaUrlBase('ftp://x.com', 'dev')).toMatch(/http/);
    expect(problemaUrlBase('http://chamados.acme.com', 'producao')).toMatch(/https/);
    expect(problemaUrlBase('nada', 'dev')).toMatch(/inválida/);
    expect(problemaUrlBase('', 'dev')).toBe('obrigatório');
  });

  it('senha obrigatória só ao criar; ao editar, vazio = manter (não vai no DTO)', () => {
    const f = { ...formularioConexaoNovo(), email: 'forja@acme.com' };
    const criando = validarConexao(f, true);
    expect(criando.ok).toBe(false);
    if (!criando.ok) expect(criando.erros.senha).toMatch(/primeiro login/);

    const editando = validarConexao(f, false);
    expect(editando.ok).toBe(true);
    if (editando.ok) expect('senha' in editando.dto).toBe(false);
  });

  it('normaliza a URL, o slug vazio vira null e e-mail inválido é recusado', () => {
    const r = validarConexao(
      {
        ...formularioConexaoNovo(),
        url_base: 'http://localhost:3000/',
        tenant_slug: '  ',
        email: 'a@b.co',
        senha: 's',
      },
      true,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dto.url_base).toBe('http://localhost:3000');
      expect(r.dto.tenant_slug).toBeNull();
      expect(r.dto.senha).toBe('s');
    }
    const ruim = validarConexao({ ...formularioConexaoNovo(), email: 'x', senha: 's' }, true);
    expect(ruim.ok ? null : ruim.erros.email).toBe('e-mail inválido');
  });

  it('papel: admin com aviso de operador dedicado; cliente recusado', () => {
    expect(avisoPapel('admin')).toMatch(/operador dedicado/);
    expect(avisoPapel('cliente')).toMatch(/recusado/);
    expect(avisoPapel('operador')).toBeNull();
  });
});

describe('conexão simplificada (FJ-030 §5)', () => {
  it('tenant só em localhost; https fora de localhost = produção', () => {
    expect(ehLocalhost('http://localhost:3000')).toBe(true);
    expect(ehLocalhost('http://acme.localhost:3000')).toBe(true);
    expect(ehLocalhost('https://chamados.acme.com.br')).toBe(false);
    expect(ehLocalhost('lixo')).toBe(false);
    expect(ambienteDaUrl('https://chamados.acme.com.br')).toBe('producao');
    expect(ambienteDaUrl('http://localhost:3000')).toBe('dev');
    expect(ambienteDaUrl('https://localhost:3000')).toBe('dev');
  });

  it('nome derivado do host', () => {
    expect(nomeDaConexao('https://chamados.acme.com.br')).toBe('chamados-acme-com-br');
    expect(nomeDaConexao('http://localhost:3000')).toBe('dev-local');
  });

  it('monta o DTO: deriva nome/ambiente, descarta tenant fora de localhost, preserva o existente', () => {
    const r = montarConexaoSimples(
      {
        url_base: 'https://chamados.acme.com.br/',
        email: 'forja@acme.com',
        senha: 's',
        tenant_slug: 'acme',
      },
      null,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dto).toMatchObject({
        nome: 'chamados-acme-com-br',
        url_base: 'https://chamados.acme.com.br',
        tenant_slug: null,
        ambiente: 'producao',
        local_senha: 'keyring',
        senha: 's',
      });
    }
    const local = montarConexaoSimples(
      { url_base: 'http://localhost:3000', email: 'a@b.co', senha: 's', tenant_slug: ' demo ' },
      null,
    );
    expect(local.ok && local.dto.tenant_slug).toBe('demo');

    const existente: ConexaoDto = {
      id: 'c1',
      nome: 'prod-acme',
      url_base: 'https://x.com',
      tenant_slug: null,
      ambiente: 'producao',
      email: 'a@b.co',
      usuario: null,
      local_senha: 'arquivo',
      token_valido_ate: null,
      ultimo_login_em: null,
      estado: 'ok',
      erro: null,
      avisos: [],
    };
    const ed = montarConexaoSimples({ ...formularioSimplesDe(existente) }, existente);
    expect(ed.ok).toBe(true);
    if (ed.ok) {
      expect(ed.dto.nome).toBe('prod-acme');
      expect(ed.dto.local_senha).toBe('arquivo');
      expect('senha' in ed.dto).toBe(false);
    }
    const semSenha = montarConexaoSimples(formularioSimplesDe(null), null);
    expect(semSenha.ok).toBe(false);
  });
});
