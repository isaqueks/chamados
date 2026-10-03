import { describe, expect, it } from 'vitest';
import { carregarConfig, ErroConfig, lerModo, lerPorta, resolverDirDados } from './config';

describe('config da Forja (01 §12, 02 §7)', () => {
  it('padrões: produção, 127.0.0.1:4317', () => {
    const c = carregarConfig({ HOME: '/home/x' });
    expect(c.modo).toBe('producao');
    expect(c.host).toBe('127.0.0.1');
    expect(c.porta).toBe(4317);
    expect(c.dirWebDist.endsWith('/web/dist')).toBe(true);
  });

  it('FORJA_MODO=dev; valor inválido é recusado', () => {
    expect(lerModo({ FORJA_MODO: 'dev' })).toBe('dev');
    expect(() => lerModo({ FORJA_MODO: 'prod' })).toThrow(ErroConfig);
  });

  it('porta: só inteiro entre 1024 e 65535', () => {
    expect(lerPorta({ FORJA_PORTA: '5000' })).toBe(5000);
    expect(() => lerPorta({ FORJA_PORTA: '80' })).toThrow(ErroConfig);
    expect(() => lerPorta({ FORJA_PORTA: 'abc' })).toThrow(ErroConfig);
  });

  it('dados: XDG ou ~/.local/share, com forja-dev no modo dev', () => {
    expect(resolverDirDados({}, 'producao', '/home/x')).toBe('/home/x/.local/share/forja');
    expect(resolverDirDados({}, 'dev', '/home/x')).toBe('/home/x/.local/share/forja-dev');
    expect(resolverDirDados({ XDG_DATA_HOME: '/dados' }, 'producao', '/home/x')).toBe(
      '/dados/forja',
    );
    // XDG relativo é ignorado (a spec XDG exige absoluto).
    expect(resolverDirDados({ XDG_DATA_HOME: 'rel' }, 'producao', '/home/x')).toBe(
      '/home/x/.local/share/forja',
    );
  });

  it('FORJA_DADOS_DIR sobrescreve, mas precisa ser absoluto', () => {
    expect(resolverDirDados({ FORJA_DADOS_DIR: '/tmp/f/../g' }, 'dev')).toBe('/tmp/g');
    expect(() => resolverDirDados({ FORJA_DADOS_DIR: 'rel' }, 'dev')).toThrow(ErroConfig);
  });
});
