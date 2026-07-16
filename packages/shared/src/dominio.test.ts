import { describe, it, expect } from 'vitest';
import {
  dominioProprioValido,
  normalizarDominio,
  repoUrlValida,
  repoLocalValido,
  validarRepoSistema,
} from './dominio';

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

describe('repoLocalValido', () => {
  it('aceita caminho absoluto do Windows (barra e contrabarra)', () => {
    expect(repoLocalValido('C:\\repos\\meu-sistema')).toBe(true);
    expect(repoLocalValido('C:/repos/meu-sistema')).toBe(true);
    expect(repoLocalValido('D:\\a\\b\\c')).toBe(true);
  });
  it('aceita caminho absoluto POSIX', () => {
    expect(repoLocalValido('/srv/repos/erp')).toBe(true);
    expect(repoLocalValido('/var/lib/chamados/repo')).toBe(true);
  });
  it('aceita file://', () => {
    expect(repoLocalValido('file:///C:/repos/erp')).toBe(true);
    expect(repoLocalValido('file:///srv/repos/erp')).toBe(true);
  });
  it('recusa relativos, vazios e drive-relativo', () => {
    expect(repoLocalValido('')).toBe(false);
    expect(repoLocalValido('   ')).toBe(false);
    expect(repoLocalValido('repos/erp')).toBe(false);
    expect(repoLocalValido('./erp')).toBe(false);
    expect(repoLocalValido('../erp')).toBe(false);
    expect(repoLocalValido('C:repos')).toBe(false); // drive-relativo (sem barra)
    expect(repoLocalValido('file://')).toBe(false); // sem caminho após o esquema
  });
  it('recusa remotos (não são caminhos locais)', () => {
    expect(repoLocalValido('https://github.com/acme/erp.git')).toBe(false);
    expect(repoLocalValido('git@github.com:acme/erp.git')).toBe(false);
  });
  it('recusa acima de 2048 chars', () => {
    expect(repoLocalValido('/' + 'a'.repeat(2048))).toBe(false);
  });
});

describe('validarRepoSistema', () => {
  it('remoto é sempre aceito (independe da flag)', () => {
    expect(validarRepoSistema('https://github.com/acme/erp.git', { permitirLocal: false })).toEqual(
      {
        ok: true,
        local: false,
      },
    );
    expect(validarRepoSistema('git@github.com:acme/erp.git', { permitirLocal: true })).toEqual({
      ok: true,
      local: false,
    });
  });
  it('local aceito só com a flag ligada', () => {
    expect(validarRepoSistema('C:\\repos\\erp', { permitirLocal: true })).toEqual({
      ok: true,
      local: true,
    });
    expect(validarRepoSistema('C:\\repos\\erp', { permitirLocal: false })).toEqual({
      ok: false,
      local: true,
      motivo: 'local_desabilitado',
    });
  });
  it('caminho relativo/lixo é inválido', () => {
    expect(validarRepoSistema('repos/erp', { permitirLocal: true })).toEqual({
      ok: false,
      local: false,
      motivo: 'invalido',
    });
    expect(validarRepoSistema('', { permitirLocal: true })).toEqual({
      ok: false,
      local: false,
      motivo: 'invalido',
    });
  });
});
