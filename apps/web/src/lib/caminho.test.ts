import { describe, it, expect } from 'vitest';
import { caminhoSeguro, equivalenteNaArea, urlLoginCom } from './caminho';

/**
 * Deep links entre áreas e pós-login (correção de 2026-07-22): validação
 * anti-open-redirect do `next`, mapeamento portal↔app da página de chamado e a
 * montagem do /login com destino preservado.
 */

const ID = '15737adb-7fc1-4af0-9e7a-19946ab904a2';

describe('caminhoSeguro', () => {
  it('aceita caminho interno', () => {
    expect(caminhoSeguro(`/portal/chamados/${ID}`)).toBe(`/portal/chamados/${ID}`);
    expect(caminhoSeguro('/app/config?aba=ia')).toBe('/app/config?aba=ia');
  });
  it('rejeita open redirect e lixo', () => {
    expect(caminhoSeguro('https://evil.com')).toBeNull();
    expect(caminhoSeguro('//evil.com')).toBeNull();
    expect(caminhoSeguro('/\\evil.com')).toBeNull();
    expect(caminhoSeguro('/app\x00x')).toBeNull();
    expect(caminhoSeguro('')).toBeNull();
    expect(caminhoSeguro(null)).toBeNull();
  });
  it('rejeita /login (loop de redirect com a página logada)', () => {
    expect(caminhoSeguro('/login')).toBeNull();
    expect(caminhoSeguro('/login?next=%2Fapp')).toBeNull();
    // /loginqualquercoisa é outra rota — não é o loop.
    expect(caminhoSeguro('/loginx')).toBe('/loginx');
  });
});

describe('equivalenteNaArea (portal ↔ app)', () => {
  it('mapeia a página do chamado entre as áreas', () => {
    expect(equivalenteNaArea(`/portal/chamados/${ID}`, 'app')).toBe(`/app/chamados/${ID}`);
    expect(equivalenteNaArea(`/app/chamados/${ID}`, 'portal')).toBe(`/portal/chamados/${ID}`);
  });
  it('preserva o chamado mesmo com querystring/caixa alta no id', () => {
    expect(equivalenteNaArea(`/portal/chamados/${ID}?aberto=1`, 'app')).toBe(`/app/chamados/${ID}`);
    expect(equivalenteNaArea(`/portal/chamados/${ID.toUpperCase()}`, 'app')).toBe(
      `/app/chamados/${ID}`,
    );
  });
  it('sem equivalente direto, cai na raiz da área destino', () => {
    expect(equivalenteNaArea('/portal/preferencias', 'app')).toBe('/app');
    expect(equivalenteNaArea('/app/config', 'portal')).toBe('/portal');
    expect(equivalenteNaArea('/portal/chamados/nao-e-uuid', 'app')).toBe('/app');
    expect(equivalenteNaArea(null, 'app')).toBe('/app');
  });
});

describe('urlLoginCom', () => {
  it('preserva destino válido codificado', () => {
    expect(urlLoginCom(`/portal/chamados/${ID}`)).toBe(
      `/login?next=${encodeURIComponent(`/portal/chamados/${ID}`)}`,
    );
  });
  it('descarta raiz, inválidos e /login', () => {
    expect(urlLoginCom('/')).toBe('/login');
    expect(urlLoginCom('https://evil.com')).toBe('/login');
    expect(urlLoginCom('/login?next=%2Fapp')).toBe('/login');
    expect(urlLoginCom(null)).toBe('/login');
  });
});
