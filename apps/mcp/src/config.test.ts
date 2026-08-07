import { describe, it, expect } from 'vitest';
import { carregarConfig, validarBaseUrl, ErroConfig } from './config';

/** Configuração do MCP (specs/11 §7.1/§7.3). */
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

  it('normaliza a URL para a origem (sem caminho nem barra final)', () => {
    expect(validarBaseUrl('https://suporte.exemplo.com/')).toBe('https://suporte.exemplo.com');
    expect(validarBaseUrl('https://suporte.exemplo.com/app/chamados')).toBe(
      'https://suporte.exemplo.com',
    );
  });

  it('recusa http fora de localhost — a senha vai no corpo do login', () => {
    expect(() => validarBaseUrl('http://suporte.exemplo.com')).toThrow(/HTTPS/);
    expect(validarBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(validarBaseUrl('http://acme.localhost:3000')).toBe('http://acme.localhost:3000');
    expect(validarBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('recusa URL inválida ou esquema não-HTTP', () => {
    expect(() => validarBaseUrl('nao-e-url')).toThrow(ErroConfig);
    expect(() => validarBaseUrl('ftp://suporte.exemplo.com')).toThrow(/http/);
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
});
