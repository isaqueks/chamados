import { describe, it, expect } from 'vitest';
import { emailValido, normalizarEmail } from './usuario-service';

/**
 * Validação de e-mail da edição de perfil (specs/03 §5.1, D-029).
 *
 * A postura é deliberada: barrar o que é INEQUIVOCAMENTE quebrado e deixar o
 * resto passar. Endereço só se prova válido entregando mensagem nele — uma regex
 * "RFC completa" rejeitaria endereços legítimos (o que trava o admin) sem impedir
 * os inválidos de verdade (que só aparecem no bounce).
 */
describe('emailValido', () => {
  it('aceita endereços comuns, com sinal de mais e subdomínio', () => {
    expect(emailValido('ana@empresa.com')).toBe(true);
    expect(emailValido('ana.souza@empresa.com.br')).toBe(true);
    expect(emailValido('suporte+chamados@empresa.com')).toBe(true);
    expect(emailValido('ana@mail.suporte.empresa.com')).toBe(true);
    // Apóstrofo é legítimo em local-part e inofensivo num header — não barrar
    // travaria sobrenomes como O'Brien por medo infundado.
    expect(emailValido("o'brien@empresa.com")).toBe(true);
  });

  it('normaliza antes de validar (maiúsculas e espaços nas pontas)', () => {
    expect(emailValido('  Ana@Empresa.COM  ')).toBe(true);
    expect(normalizarEmail('  Ana@Empresa.COM  ')).toBe('ana@empresa.com');
  });

  it('recusa o que é inequivocamente quebrado', () => {
    expect(emailValido('sem-arroba.dev')).toBe(false);
    expect(emailValido('@empresa.com')).toBe(false);
    expect(emailValido('ana@')).toBe(false);
    expect(emailValido('ana@empresa')).toBe(false); // domínio sem ponto
    expect(emailValido('ana@@empresa.com')).toBe(false);
    expect(emailValido('ana@.com')).toBe(false);
    expect(emailValido('ana@empresa.')).toBe(false);
    expect(emailValido('ana@empresa..com')).toBe(false);
    expect(emailValido('')).toBe(false);
  });

  it('recusa separadores que quebrariam cabeçalho de e-mail', () => {
    // Um endereço com espaço/vírgula/`<>` vira injeção de header no envio.
    expect(emailValido('ana souza@empresa.com')).toBe(false);
    expect(emailValido('ana@empresa.com, outro@empresa.com')).toBe(false);
    expect(emailValido('<ana@empresa.com>')).toBe(false);
    expect(emailValido('ana@empresa.com\nbcc: x@y.com')).toBe(false);
  });

  it('recusa comprimentos absurdos (limite de 254 do envelope SMTP)', () => {
    expect(emailValido(`${'a'.repeat(250)}@empresa.com`)).toBe(false);
    expect(emailValido('a@b.co')).toBe(true);
  });
});
