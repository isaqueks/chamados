import { describe, expect, it } from 'vitest';
import { detectarSegredos, REDIGIDO, redigirSegredos } from './detector-segredos';

/**
 * Detector de segredos antes do outbox (specs/forja/05 §8.2): acerto bloqueia.
 * Os valores abaixo são FALSOS, montados por concatenação para nenhum scanner
 * de repositório confundi-los com credenciais reais.
 */

const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const ANT = 'sk-ant-' + 'api03-abcdefghijklmnop_qrstuvwxyz';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9' +
  '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
  '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('detectarSegredos', () => {
  it.each([
    ['chave_privada_pem', `-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----`],
    ['token_github', `use ${GHP} no CI`],
    ['token_github', `github_pat_${'1'.repeat(22)}_abc`],
    ['chave_anthropic', `ANTHROPIC_API_KEY=${ANT}`],
    ['chave_aws', `id ${AWS}`],
    ['jwt', `cookie ${JWT}`],
    ['string_conexao_com_senha', 'DATABASE_URL=postgres://app:S3gr3d0!@db.acme:5432/erp'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'],
    ['atribuicao_de_segredo', 'senha = "hunter2024"'],
    ['atribuicao_de_segredo', 'password: Pa55word!'],
  ])('%s', (tipo, texto) => {
    const r = detectarSegredos(texto);
    expect(r.ok).toBe(false);
    expect(r.achados.map((a) => a.tipo)).toContain(tipo);
  });

  it('valores conhecidos (token, .env) são achados com exatidão', () => {
    const r = detectarSegredos('o token é tok-sessao-123456 ok', {
      valoresConhecidos: ['tok-sessao-123456', 'curto'],
    });
    expect(r.achados).toEqual([
      { tipo: 'valor_conhecido', inicio: 10, fim: 27, amostra: 'tok-…(17)' },
    ]);
  });

  it('o achado nunca carrega o valor', () => {
    const r = detectarSegredos(`x ${GHP}`);
    expect(JSON.stringify(r)).not.toContain(GHP);
  });

  it('não acusa texto comum, sha de commit, placeholders e prosa', () => {
    for (const texto of [
      'Implementação local (Forja) — aprovada e integrada\nCommit: 3f9a1c0d2b4e5f60718293a4b5c6d7e8f9012345',
      'Branch: forja/chamado-12-relatorio-de-frete',
      'DATABASE_URL=postgres://app:${DB_SENHA}@db:5432/erp',
      'A senha: expirada após 90 dias, o usuário troca no portal.',
      'password = <sua-senha>',
      'https://github.com/acme/erp/pull/7',
    ]) {
      expect(detectarSegredos(texto)).toEqual({ ok: true, achados: [] });
    }
  });
});

describe('redigirSegredos', () => {
  it('substitui cada segredo por «redigido»', () => {
    const t = redigirSegredos(`a ${GHP} b postgres://u:senhaforte@h/db c`);
    expect(t).not.toContain(GHP);
    expect(t).not.toContain('senhaforte');
    expect(t.split(REDIGIDO)).toHaveLength(3);
  });
});
