import { describe, it, expect } from 'vitest';
import { origemLocal, normalizarRepoLocal, urlComCredencial } from './repo';

/**
 * Repositório LOCAL no worker (D-011): detecção de origem local, normalização de
 * `file://` (com atenção ao Windows) e a garantia de que credencial NUNCA é
 * injetada numa origem local. Puro/sem rede — não clona de fato.
 */

describe('origemLocal (D-011)', () => {
  it('reconhece caminho absoluto e file:// como local', () => {
    expect(origemLocal('C:\\repos\\erp')).toBe(true);
    expect(origemLocal('C:/repos/erp')).toBe(true);
    expect(origemLocal('/srv/repos/erp')).toBe(true);
    expect(origemLocal('file:///C:/repos/erp')).toBe(true);
  });
  it('NÃO trata remoto (http/ssh) como local', () => {
    expect(origemLocal('https://github.com/acme/erp.git')).toBe(false);
    expect(origemLocal('git@github.com:acme/erp.git')).toBe(false);
  });
});

describe('normalizarRepoLocal (file:// no Windows)', () => {
  it('troca contrabarras por barras em file://', () => {
    expect(normalizarRepoLocal('file://C:\\repos\\erp')).toBe('file:///C:/repos/erp');
  });
  it('garante a 3ª barra antes da unidade (file://C: → file:///C:)', () => {
    expect(normalizarRepoLocal('file://C:/repos/erp')).toBe('file:///C:/repos/erp');
  });
  it('preserva file:/// já canônico', () => {
    expect(normalizarRepoLocal('file:///C:/repos/erp')).toBe('file:///C:/repos/erp');
    expect(normalizarRepoLocal('file:///srv/repos/erp')).toBe('file:///srv/repos/erp');
  });
  it('deixa caminho simples (não file://) intacto', () => {
    expect(normalizarRepoLocal('C:\\repos\\erp')).toBe('C:\\repos\\erp');
    expect(normalizarRepoLocal('/srv/repos/erp')).toBe('/srv/repos/erp');
  });
});

describe('urlComCredencial — origem local nunca recebe credencial', () => {
  it('não injeta credencial em caminho local nem file://', () => {
    expect(urlComCredencial('C:\\repos\\erp', 'user:token')).toBe('C:\\repos\\erp');
    expect(urlComCredencial('/srv/repos/erp', 'user:token')).toBe('/srv/repos/erp');
    expect(urlComCredencial('file:///srv/repos/erp', 'user:token')).toBe('file:///srv/repos/erp');
  });
  it('injeta credencial só em http(s)', () => {
    expect(urlComCredencial('https://github.com/acme/erp.git', 'user:token')).toBe(
      'https://user:token@github.com/acme/erp.git',
    );
  });
});
