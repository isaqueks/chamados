import { describe, expect, it } from 'vitest';
import { abrirSegredos, type BackendSegredos, type Segredos } from '../segredos/keyring';
import {
  ConexaoChamados,
  ErroConexaoIndisponivel,
  ErroUrlConexao,
  JANELA_RATE_LIMIT_MS,
  validarUrlConexao,
  type PersistenciaConexao,
  type RegistroConexao,
  type TokenPersistido,
} from './conexao';
import { ChamadosFalso, erro, itemFalso } from './servidor-falso.test-apoio';

/**
 * Conexão (specs/forja/07 §2, §13): token cifrado persistido, relogin 1×,
 * segundo 401 = sessão recusada, 429 bloqueia 300 s, `127.0.0.1` recusado.
 */

class BackendMemoria implements BackendSegredos {
  readonly tipo = 'keyring' as const;
  dados = new Map<string, string>();
  async ler(s: string, c: string) {
    return this.dados.get(`${s}/${c}`) ?? null;
  }
  async gravar(s: string, c: string, v: string) {
    this.dados.set(`${s}/${c}`, v);
  }
  async apagar(s: string, c: string) {
    return this.dados.delete(`${s}/${c}`);
  }
}

class PersistenciaMemoria implements PersistenciaConexao {
  token: TokenPersistido | null = null;
  logins: Array<Record<string, string>> = [];
  async lerToken() {
    return this.token;
  }
  async gravarToken(_id: string, token_cifrado: string, token_expira_em: string) {
    this.token = { token_cifrado, token_expira_em };
  }
  async limparToken() {
    this.token = null;
  }
  async registrarLogin(_id: string, dados: Record<string, string>) {
    this.logins.push(dados);
  }
}

const REGISTRO: RegistroConexao = {
  id: 'conexao-1',
  url_base: 'https://suporte.acme.com',
  tenant_slug: null,
  email: 'forja@acme.com',
  local_senha: 'keyring',
  usuario_id: null,
  usuario_nome: null,
  papel: null,
};

async function montar(
  opcoes: { registro?: Partial<RegistroConexao>; agora?: () => number; senha?: string | null } = {},
) {
  const s = new ChamadosFalso();
  const segredos: Segredos = await abrirSegredos({
    dirDados: '/nao-usado',
    keyring: new BackendMemoria(),
  });
  if (opcoes.senha !== null)
    await segredos.gravarSenha(REGISTRO.id, opcoes.senha ?? s.senhaCorreta);
  const persistencia = new PersistenciaMemoria();
  const nova = () =>
    new ConexaoChamados(
      { ...REGISTRO, ...opcoes.registro },
      { segredos, persistencia, fetch: s.fetch, agora: opcoes.agora },
    );
  return { s, segredos, persistencia, conexao: nova(), nova };
}

describe('validarUrlConexao', () => {
  it('recusa 127.0.0.1 com explicação; aceita localhost; exige HTTPS fora do local', () => {
    expect(() => validarUrlConexao('http://127.0.0.1:3000')).toThrow(ErroUrlConexao);
    try {
      validarUrlConexao('http://127.0.0.1:3000');
    } catch (e) {
      expect((e as ErroUrlConexao).codigo).toBe('url_loopback_ip');
      expect((e as Error).message).toContain('localhost');
    }
    expect(validarUrlConexao('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(() => validarUrlConexao('http://suporte.acme.com')).toThrow(/HTTPS/);
  });
});

describe('sessão e token cifrado', () => {
  it('login preguiçoso grava o token CIFRADO e a identidade; reinício reaproveita sem login', async () => {
    const { s, persistencia, conexao, nova } = await montar();
    await conexao.listarSistemasAlvo();
    expect(s.logins).toBe(1);
    expect(persistencia.token?.token_cifrado).toMatch(/^v1:/);
    expect(persistencia.token?.token_cifrado).not.toContain('tok-1');
    expect(persistencia.logins[0]).toMatchObject({
      usuario_id: 'u-forja',
      usuario_nome: 'Equipe de Suporte',
      papel: 'operador',
    });
    expect(conexao.estadoSessao()).toBe('ok');
    expect(conexao.identidade()).toEqual({ usuarioId: 'u-forja', nome: 'Equipe de Suporte' });

    const depois = nova();
    await depois.listarSistemasAlvo();
    expect(s.logins).toBe(1);
  });

  it('token adulterado é descartado e vira um login novo', async () => {
    const { s, persistencia, conexao, nova } = await montar();
    await conexao.listarSistemasAlvo();
    persistencia.token = { token_cifrado: 'v1:lixo:lixo:lixo', token_expira_em: null };
    await nova().listarSistemasAlvo();
    expect(s.logins).toBe(2);
  });

  it('401 provoca exatamente 1 relogin; o segundo 401 marca "sessão recusada" e para tudo', async () => {
    const { s, conexao } = await montar();
    await conexao.listarSistemasAlvo();
    s.tokensValidos.clear();
    await conexao.listarSistemasAlvo();
    expect(s.logins).toBe(2);

    s.interceptores.push((r) =>
      r.caminho.endsWith('/sessao') ? null : erro(401, 'nao_autenticado'),
    );
    await expect(conexao.listarSistemasAlvo()).rejects.toMatchObject({ status: 401 });
    expect(s.logins).toBe(3);
    expect(conexao.estadoSessao()).toBe('sessao_recusada');
    expect(conexao.podeUsar()).toBe(false);
    const antes = s.requisicoes.length;
    await expect(conexao.obterChamado('x')).rejects.toBeInstanceOf(ErroConexaoIndisponivel);
    expect(s.requisicoes.length).toBe(antes);
    expect(conexao.erro()?.codigo).toBe('outro');
  });

  it('credencial inválida não tenta de novo sozinha; relogar com a senha certa recupera', async () => {
    const { s, conexao, segredos } = await montar({ senha: 'errada' });
    await expect(conexao.listarSistemasAlvo()).rejects.toMatchObject({
      codigo: 'credenciais_invalidas',
    });
    expect(conexao.estadoSessao()).toBe('credencial_invalida');
    await expect(conexao.listarSistemasAlvo()).rejects.toBeInstanceOf(ErroConexaoIndisponivel);
    expect(s.logins).toBe(1);
    const r = await conexao.relogar(s.senhaCorreta);
    expect(r).toMatchObject({ ok: true, estado: 'ok', papel_aceito: true });
    expect(await segredos.lerSenha(REGISTRO.id)).toBe(s.senhaCorreta);
  });

  it('429 bloqueia novos logins por 300 s', async () => {
    let agora = 1_000_000;
    const { s, conexao } = await montar({ agora: () => agora });
    s.interceptores.push((r) =>
      r.caminho.endsWith('/sessao') && agora < 1_000_000 + JANELA_RATE_LIMIT_MS
        ? erro(429, 'muitas_tentativas')
        : null,
    );
    await expect(conexao.listarSistemasAlvo()).rejects.toMatchObject({ status: 429 });
    expect(conexao.estadoSessao()).toBe('limite_login');
    expect(conexao.limiteLoginAte()).toBe(1_000_000 + JANELA_RATE_LIMIT_MS);
    agora += 299_000;
    await expect(conexao.listarSistemasAlvo()).rejects.toBeInstanceOf(ErroConexaoIndisponivel);
    expect((await conexao.testar()).erro?.codigo).toBe('limite_login');
    const tentativasLogin = () =>
      s.requisicoes.filter((r) => r.caminho === '/api/v1/sessao').length;
    expect(tentativasLogin()).toBe(1);
    agora += 2_000;
    await conexao.listarSistemasAlvo();
    expect(conexao.estadoSessao()).toBe('ok');
    expect(tentativasLogin()).toBe(2);
  });

  it('senha não guardada: sem_senha até o humano digitar (fica só na memória)', async () => {
    const { s, conexao, segredos } = await montar({
      registro: { local_senha: 'nao_guardada' },
      senha: null,
    });
    await expect(conexao.listarSistemasAlvo()).rejects.toThrow(/Senha do Chamados/);
    expect(conexao.estadoSessao()).toBe('sem_senha');
    expect((await conexao.relogar(s.senhaCorreta)).ok).toBe(true);
    expect(await segredos.lerSenha(REGISTRO.id)).toBeNull();
  });
});

describe('testar / papel / D-036', () => {
  it('detecta a D-036 pelo campo ia_silenciada no item da lista', async () => {
    const { s, conexao } = await montar();
    s.lista = [itemFalso({ numero: 1, ia_silenciada: true })];
    expect(await conexao.testar()).toMatchObject({
      ok: true,
      d036: true,
      usuario: { id: 'u-forja', papel: 'operador' },
    });
    s.lista = [itemFalso({ numero: 1 })];
    s.d036 = false;
    expect((await conexao.testar()).d036).toBe(false);
  });

  it('cliente é recusado; admin passa com aviso', async () => {
    const a = await montar();
    a.s.usuario = { ...a.s.usuario, papel: 'cliente' };
    const r = await a.conexao.testar();
    expect(r).toMatchObject({
      ok: false,
      papel_aceito: false,
      estado: 'papel_recusado',
      erro: { codigo: 'papel_recusado' },
    });
    await expect(a.conexao.listarSistemasAlvo()).rejects.toBeInstanceOf(ErroConexaoIndisponivel);

    const b = await montar();
    b.s.usuario = { ...b.s.usuario, papel: 'admin' };
    const rb = await b.conexao.testar();
    expect(rb.ok).toBe(true);
    expect(rb.aviso).toMatch(/admin/);
  });

  it('desconectar faz DELETE e apaga o token local', async () => {
    const { s, conexao, persistencia } = await montar();
    await conexao.listarSistemasAlvo();
    await conexao.desconectar();
    expect(s.requisicoes.at(-1)).toMatchObject({ metodo: 'DELETE', caminho: '/api/v1/sessao' });
    expect(persistencia.token).toBeNull();
    expect(conexao.estadoSessao()).toBe('sem_login');
  });
});
