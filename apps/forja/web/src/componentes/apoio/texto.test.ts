import { describe, expect, it } from 'vitest';
import {
  formatarBytes,
  formatarDecorrido,
  formatarRelativo,
  mensagemErro,
  plural,
  shaCurto,
} from './texto';

describe('formatação das telas de apoio', () => {
  const agora = new Date('2026-10-02T12:00:00.000Z');

  it('sha curto e bytes', () => {
    expect(shaCurto('4f9a1c2b3d')).toBe('4f9a1c2');
    expect(shaCurto(null)).toBe('—');
    expect(formatarBytes(512)).toBe('512 B');
    expect(formatarBytes(1536)).toBe('1,5 KB');
    expect(formatarBytes(3 * 1024 ** 3)).toBe('3,0 GB');
    expect(formatarBytes(null)).toBe('—');
  });

  it('tempo relativo e cronômetro', () => {
    expect(formatarRelativo('2026-10-02T11:59:20.000Z', agora)).toBe('há 40 s');
    expect(formatarRelativo('2026-10-02T11:55:00.000Z', agora)).toBe('há 5 min');
    expect(formatarRelativo('2026-09-29T12:00:00.000Z', agora)).toBe('há 3 dias');
    expect(formatarRelativo('2026-10-02T13:00:00.000Z', agora)).toBe('há 0 s');
    expect(formatarDecorrido('2026-10-02T11:57:50.000Z', agora)).toBe('2:10');
    expect(formatarDecorrido('2026-10-02T10:57:50.000Z', agora)).toBe('1:02:10');
  });

  it('plural e mensagem de erro legível (501 vira aviso neutro)', () => {
    expect(plural(1, 'chamado')).toBe('1 chamado');
    expect(plural(3, 'chamado')).toBe('3 chamados');
    expect(plural(2, 'plano aprovado', 'planos aprovados')).toBe('2 planos aprovados');
    expect(mensagemErro({ codigo: 'nao_implementado', message: 'x' })).toMatch(/ainda não/);
    expect(mensagemErro({ codigo: 'conflito', message: 'patch mudou' })).toBe('patch mudou');
    expect(mensagemErro(new Error('falhou'))).toBe('falhou');
    expect(mensagemErro(42)).toBe('Erro inesperado.');
  });
});
