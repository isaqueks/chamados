import { describe, it, expect } from 'vitest';
import { detectarGithub, tokenDaCredencial, abrirPrGithub, type FetchImpl } from './github-pr';

/**
 * Testa o cliente da API do GitHub com a FRONTEIRA HTTP mockada (`fetchImpl`) —
 * SEM rede (specs/05 §6). Cobre detecção de host, extração de token e o mapeamento
 * de resposta (201 → html_url; erro → falha sem vazar token).
 */

describe('detectarGithub', () => {
  it('detecta https com e sem .git', () => {
    expect(detectarGithub('https://github.com/acme/loja')).toEqual({ owner: 'acme', repo: 'loja' });
    expect(detectarGithub('https://github.com/acme/loja.git')).toEqual({
      owner: 'acme',
      repo: 'loja',
    });
  });

  it('detecta scp-like git@github.com:owner/repo.git', () => {
    expect(detectarGithub('git@github.com:acme/loja.git')).toEqual({ owner: 'acme', repo: 'loja' });
  });

  it('detecta com credencial embutida na URL', () => {
    expect(detectarGithub('https://user:token@github.com/acme/loja.git')).toEqual({
      owner: 'acme',
      repo: 'loja',
    });
  });

  it('retorna null para hosts não-GitHub e caminhos locais', () => {
    expect(detectarGithub('https://gitlab.com/acme/loja.git')).toBeNull();
    expect(detectarGithub('/tmp/repo-fixture')).toBeNull();
    expect(detectarGithub('https://github.com/acme')).toBeNull();
  });
});

describe('tokenDaCredencial', () => {
  it('extrai o token de "user:token" e de "token"', () => {
    expect(tokenDaCredencial('x-access-token:ghp_abc')).toBe('ghp_abc');
    expect(tokenDaCredencial('ghp_abc')).toBe('ghp_abc');
    expect(tokenDaCredencial(null)).toBeNull();
    expect(tokenDaCredencial('')).toBeNull();
  });
});

describe('abrirPrGithub', () => {
  it('POSTa no endpoint certo com Authorization e devolve html_url', async () => {
    let capturado: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fetchImpl: FetchImpl = async (url, init) => {
      capturado = { url, headers: init.headers, body: init.body };
      return {
        status: 201,
        text: async () => JSON.stringify({ html_url: 'https://github.com/acme/loja/pull/7' }),
      };
    };

    const prUrl = await abrirPrGithub({
      repo: { owner: 'acme', repo: 'loja' },
      token: 'ghp_secreto',
      branch: 'ia/chamado-42-erro',
      base: 'main',
      titulo: 'Chamados #42: erro',
      corpo: 'corpo do PR',
      fetchImpl,
    });

    expect(prUrl).toBe('https://github.com/acme/loja/pull/7');
    expect(capturado!.url).toBe('https://api.github.com/repos/acme/loja/pulls');
    expect(capturado!.headers.Authorization).toBe('Bearer ghp_secreto');
    const body = JSON.parse(capturado!.body) as Record<string, string>;
    expect(body).toEqual({
      title: 'Chamados #42: erro',
      head: 'ia/chamado-42-erro',
      base: 'main',
      body: 'corpo do PR',
    });
  });

  it('erro HTTP vira falha sem vazar o token', async () => {
    const fetchImpl: FetchImpl = async () => ({
      status: 422,
      text: async () => '{"message":"Validation Failed"}',
    });
    await expect(
      abrirPrGithub({
        repo: { owner: 'acme', repo: 'loja' },
        token: 'ghp_secreto',
        branch: 'b',
        base: 'main',
        titulo: 't',
        corpo: 'c',
        fetchImpl,
      }),
    ).rejects.toThrow(/github_pr_falhou:http_422/);

    // A mensagem de erro nunca contém o token.
    await abrirPrGithub({
      repo: { owner: 'acme', repo: 'loja' },
      token: 'ghp_secreto',
      branch: 'b',
      base: 'main',
      titulo: 't',
      corpo: 'c',
      fetchImpl,
    }).catch((e: Error) => expect(e.message).not.toContain('ghp_secreto'));
  });

  it('falha de rede vira github_pr_falhou:rede', async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error('ECONNREFUSED 10.0.0.1');
    };
    await expect(
      abrirPrGithub({
        repo: { owner: 'acme', repo: 'loja' },
        token: 't',
        branch: 'b',
        base: 'main',
        titulo: 't',
        corpo: 'c',
        fetchImpl,
      }),
    ).rejects.toThrow('github_pr_falhou:rede');
  });
});
