import { describe, it, expect } from 'vitest';
import { validarBaseUrl, ErroUrlBase } from './url-base';

/** URL base (specs/11 §7.3; specs/forja/07 §2.3). */
describe('validarBaseUrl', () => {
  it('normaliza para a origem (sem caminho nem barra final), sem avisos', () => {
    expect(validarBaseUrl('https://suporte.exemplo.com/')).toEqual({
      origem: 'https://suporte.exemplo.com',
      avisos: [],
    });
    expect(validarBaseUrl('https://suporte.exemplo.com/app/chamados').origem).toBe(
      'https://suporte.exemplo.com',
    );
  });

  it('recusa http fora de localhost — a senha vai no corpo do login', () => {
    expect(() => validarBaseUrl('http://suporte.exemplo.com')).toThrow(/HTTPS/);
    expect(validarBaseUrl('http://localhost:3000')).toEqual({
      origem: 'http://localhost:3000',
      avisos: [],
    });
    expect(validarBaseUrl('http://acme.localhost:3000').avisos).toEqual([]);
  });

  it('aceita 127.0.0.1, mas AVISA (o proxy resolveria o tenant "127" — D7)', () => {
    const r = validarBaseUrl('http://127.0.0.1:3000');
    expect(r.origem).toBe('http://127.0.0.1:3000');
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]!.codigo).toBe('ip_loopback');
    expect(r.avisos[0]!.mensagem).toMatch(/localhost/);
  });

  it('recusa URL inválida ou esquema não-HTTP', () => {
    expect(() => validarBaseUrl('nao-e-url')).toThrow(ErroUrlBase);
    expect(() => validarBaseUrl('ftp://suporte.exemplo.com')).toThrow(/http/);
  });
});
