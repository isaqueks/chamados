import { describe, it, expect } from 'vitest';
import { carregarConfig, configCliente, ErroConfig } from './config';

/**
 * Configuração do MCP (specs/11 §7.1/§7.3). As regras da URL em si são testadas
 * em `@chamados/cliente-api` (`url-base.test.ts`); aqui, só o que é do MCP: env,
 * tradução do erro para `ErroConfig`, avisos e o mapeamento para o cliente.
 */
describe('config do MCP', () => {
  const base = {
    CHAMADOS_URL: 'https://suporte.exemplo.com',
    CHAMADOS_EMAIL: 'op@exemplo.com',
    CHAMADOS_SENHA: 'x',
  } as NodeJS.ProcessEnv;

  it('exige as três variáveis obrigatórias, com mensagem acionável', () => {
    expect(() => carregarConfig({ ...base, CHAMADOS_SENHA: undefined })).toThrow(ErroConfig);
    expect(() => carregarConfig({ ...base, CHAMADOS_EMAIL: '   ' })).toThrow(/CHAMADOS_EMAIL/);
    expect(() => carregarConfig({})).toThrow(/CHAMADOS_URL/);
  });

  it('aceita CHAMADOS_TOKEN no lugar de CHAMADOS_SENHA; um dos dois é obrigatório', () => {
    const soToken = carregarConfig({ ...base, CHAMADOS_SENHA: undefined, CHAMADOS_TOKEN: ' tk ' });
    expect(soToken.token).toBe('tk');
    expect(soToken.senha).toBeNull();

    const semNenhum = { ...base, CHAMADOS_SENHA: '  ', CHAMADOS_TOKEN: '' };
    expect(() => carregarConfig(semNenhum)).toThrow(ErroConfig);
    expect(() => carregarConfig(semNenhum)).toThrow(/CHAMADOS_SENHA ou CHAMADOS_TOKEN/);

    const ambos = carregarConfig({ ...base, CHAMADOS_TOKEN: 'tk' });
    expect(ambos).toMatchObject({ senha: 'x', token: 'tk' });
    expect(carregarConfig(base).token).toBeNull();
  });

  it('modo só-token: o cliente recebe o token inicial e NENHUMA fonte de senha', () => {
    const cc = configCliente(
      carregarConfig({
        ...base,
        CHAMADOS_SENHA: undefined,
        CHAMADOS_TOKEN: 'tk-secreto',
        CHAMADOS_MCP_SOMENTE_LEITURA: 'true',
      }),
    );
    expect(cc.tokenInicial).toBe('tk-secreto');
    expect(cc.obterSenha).toBeUndefined();
  });

  it('o token nunca aparece na mensagem de erro de configuração', () => {
    const erro = (() => {
      try {
        carregarConfig({ ...base, CHAMADOS_TOKEN: 'tk-secreto', CHAMADOS_URL: 'nao-e-url' });
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(erro).toBeInstanceOf(ErroConfig);
    expect(erro!.message).not.toContain('tk-secreto');
  });

  it('normaliza a URL para a origem (sem caminho nem barra final)', () => {
    const cfg = carregarConfig({ ...base, CHAMADOS_URL: 'https://suporte.exemplo.com/app/' });
    expect(cfg.baseUrl).toBe('https://suporte.exemplo.com');
    expect(cfg.avisos).toEqual([]);
  });

  it('URL recusada vira ErroConfig citando CHAMADOS_URL (sai com código 2)', () => {
    expect(() => carregarConfig({ ...base, CHAMADOS_URL: 'http://suporte.exemplo.com' })).toThrow(
      ErroConfig,
    );
    expect(() => carregarConfig({ ...base, CHAMADOS_URL: 'http://suporte.exemplo.com' })).toThrow(
      /CHAMADOS_URL.*HTTPS/,
    );
    expect(() => carregarConfig({ ...base, CHAMADOS_URL: 'nao-e-url' })).toThrow(ErroConfig);
    expect(carregarConfig({ ...base, CHAMADOS_URL: 'http://localhost:3000' }).baseUrl).toBe(
      'http://localhost:3000',
    );
  });

  it('127.0.0.1 continua aceito, mas gera AVISO (logado no stderr)', () => {
    const cfg = carregarConfig({ ...base, CHAMADOS_URL: 'http://127.0.0.1:3000' });
    expect(cfg.baseUrl).toBe('http://127.0.0.1:3000');
    expect(cfg.avisos).toHaveLength(1);
    expect(cfg.avisos[0]).toMatch(/localhost/);
  });

  it('tenant é opcional; somente-leitura só liga com valor explícito', () => {
    expect(carregarConfig(base).tenantSlug).toBeNull();
    expect(carregarConfig({ ...base, CHAMADOS_TENANT: 'acme' }).tenantSlug).toBe('acme');

    expect(carregarConfig(base).somenteLeitura).toBe(false);
    expect(carregarConfig({ ...base, CHAMADOS_MCP_SOMENTE_LEITURA: 'true' }).somenteLeitura).toBe(
      true,
    );
    // Qualquer outro valor NÃO liga o modo (fail-closed em relação à intenção).
    expect(carregarConfig({ ...base, CHAMADOS_MCP_SOMENTE_LEITURA: 'talvez' }).somenteLeitura).toBe(
      false,
    );
  });

  it('configCliente entrega a senha só pela função (nunca como campo)', async () => {
    const cc = configCliente(carregarConfig({ ...base, CHAMADOS_TENANT: 'acme' }));
    expect(cc).toMatchObject({
      baseUrl: 'https://suporte.exemplo.com',
      email: 'op@exemplo.com',
      tenantSlug: 'acme',
    });
    expect('senha' in cc).toBe(false);
    expect(await cc.obterSenha?.()).toBe('x');
    expect(cc.tokenInicial).toBeNull();
  });
});
