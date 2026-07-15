import { describe, it, expect } from 'vitest';
import { dominioProprioValido, normalizarDominio, repoUrlValida } from './dominio';

describe('normalizarDominio', () => {
  it('minúsculo, sem espaços e sem ponto final', () => {
    expect(normalizarDominio('  Suporte.Empresa.COM.  ')).toBe('suporte.empresa.com');
  });
});

describe('dominioProprioValido', () => {
  it('aceita domínios reais', () => {
    expect(dominioProprioValido('suporte.empresa.com')).toBe(true);
    expect(dominioProprioValido('ajuda.acme.com.br')).toBe(true);
    expect(dominioProprioValido('help.sub.dominio.io')).toBe(true);
  });
  it('recusa sem ponto / TLD inválido', () => {
    expect(dominioProprioValido('empresa')).toBe(false);
    expect(dominioProprioValido('empresa.c')).toBe(false);
    expect(dominioProprioValido('empresa.123')).toBe(false);
  });
  it('recusa esquema, porta, caminho e espaços', () => {
    expect(dominioProprioValido('https://empresa.com')).toBe(false);
    expect(dominioProprioValido('empresa.com:3000')).toBe(false);
    expect(dominioProprioValido('empresa.com/suporte')).toBe(false);
    expect(dominioProprioValido('a b.com')).toBe(false);
  });
  it('recusa hífen nas pontas dos rótulos', () => {
    expect(dominioProprioValido('-empresa.com')).toBe(false);
    expect(dominioProprioValido('empresa-.com')).toBe(false);
  });
  it('recusa reservados/plataforma', () => {
    expect(dominioProprioValido('localhost')).toBe(false);
    expect(dominioProprioValido('acme.chamados.app')).toBe(false);
    expect(dominioProprioValido('x.localhost')).toBe(false);
  });
});

describe('repoUrlValida', () => {
  it('aceita https e ssh', () => {
    expect(repoUrlValida('https://github.com/acme/erp.git')).toBe(true);
    expect(repoUrlValida('git@github.com:acme/erp.git')).toBe(true);
    expect(repoUrlValida('ssh://git@host.com/acme/erp.git')).toBe(true);
  });
  it('recusa lixo', () => {
    expect(repoUrlValida('')).toBe(false);
    expect(repoUrlValida('só um texto')).toBe(false);
    expect(repoUrlValida('ftp:/x')).toBe(false);
  });
});
