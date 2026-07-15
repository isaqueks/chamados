import { describe, it, expect } from 'vitest';
import { validarUrlWebhook, hostWebhookPrivado } from './validar-url-webhook';

describe('validarUrlWebhook — anti-SSRF', () => {
  const bloqueado = { permitirPrivado: false };

  it('aceita URLs http(s) públicas', () => {
    for (const u of [
      'https://exemplo.com/webhooks/chamados',
      'http://api.publica.dev:8080/hook',
      'https://sub.dominio.co.uk/x?y=1',
    ]) {
      expect(validarUrlWebhook(u, bloqueado).ok, u).toBe(true);
    }
  });

  it('rejeita esquemas não-http(s)', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://host/f', 'javascript:alert(1)']) {
      const r = validarUrlWebhook(u, bloqueado);
      expect(r.ok, u).toBe(false);
    }
  });

  it('rejeita credenciais embutidas', () => {
    const r = validarUrlWebhook('https://user:pass@exemplo.com/hook', bloqueado);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe('credenciais');
  });

  it('rejeita loopback / localhost', () => {
    for (const u of [
      'http://localhost/hook',
      'http://localhost:4000/hook',
      'http://127.0.0.1/hook',
      'http://127.0.0.5:9000/x',
      'http://[::1]/hook',
      'http://algo.localhost/hook',
      'http://servico.internal/hook',
    ]) {
      expect(validarUrlWebhook(u, bloqueado).ok, u).toBe(false);
    }
  });

  it('rejeita faixas privadas (RFC 1918), CGNAT e metadata da nuvem', () => {
    for (const u of [
      'http://10.0.0.1/hook',
      'http://10.255.255.255/hook',
      'http://172.16.0.1/hook',
      'http://172.31.255.1/hook',
      'http://192.168.1.10/hook',
      'http://169.254.169.254/latest/meta-data/', // metadata AWS/GCP
      'http://100.64.0.1/hook', // CGNAT
      'http://0.0.0.0/hook',
    ]) {
      expect(validarUrlWebhook(u, bloqueado).ok, u).toBe(false);
    }
  });

  it('rejeita IPv6 ULA/link-local e IPv4 mapeado', () => {
    for (const u of [
      'http://[fc00::1]/hook',
      'http://[fd12:3456::1]/hook',
      'http://[fe80::1]/hook',
      'http://[::ffff:127.0.0.1]/hook',
    ]) {
      expect(validarUrlWebhook(u, bloqueado).ok, u).toBe(false);
    }
  });

  it('rejeita IPs ofuscados (decimal/hex)', () => {
    expect(validarUrlWebhook('http://2130706433/hook', bloqueado).ok).toBe(false); // 127.0.0.1
    expect(validarUrlWebhook('http://0x7f000001/hook', bloqueado).ok).toBe(false);
  });

  it('permite host privado quando a flag de dev é passada', () => {
    expect(validarUrlWebhook('http://localhost:4000/hook', { permitirPrivado: true }).ok).toBe(
      true,
    );
    expect(validarUrlWebhook('http://127.0.0.1/hook', { permitirPrivado: true }).ok).toBe(true);
  });

  it('não confunde host público que apenas contém dígitos de faixa privada', () => {
    // 11.x não é privado; 172.15/172.32 estão FORA de 172.16/12.
    expect(hostWebhookPrivado('11.0.0.1')).toBe(false);
    expect(hostWebhookPrivado('172.15.0.1')).toBe(false);
    expect(hostWebhookPrivado('172.32.0.1')).toBe(false);
    expect(hostWebhookPrivado('93.184.216.34')).toBe(false); // example.com
  });

  it('rejeita URL malformada / vazia', () => {
    expect(validarUrlWebhook('', bloqueado).ok).toBe(false);
    expect(validarUrlWebhook('nao-e-url', bloqueado).ok).toBe(false);
  });
});
