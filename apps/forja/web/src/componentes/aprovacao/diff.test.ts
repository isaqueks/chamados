import { describe, expect, it } from 'vitest';
import type { DiffArquivoDto } from '@comum/dto';
import { analisarArquivo, prepararPatch } from './diff';

const base: DiffArquivoDto = {
  caminho: 'src/x.ts',
  caminho_anterior: null,
  status: 'M',
  adicoes: 1,
  remocoes: 1,
  selos: [],
  binario: false,
  patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c\n',
};

describe('diff por arquivo para o react-diff-view', () => {
  it('reconstrói o cabeçalho git quando o patch só tem hunks', () => {
    expect(
      prepararPatch(base).startsWith(
        'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@',
      ),
    ).toBe(true);
    const comCabecalho = {
      ...base,
      patch: `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${base.patch}`,
    };
    expect(prepararPatch(comCabecalho)).toBe(comCabecalho.patch);
  });

  it('analisa modificação, arquivo novo e renomeação', () => {
    expect(analisarArquivo(base)).toMatchObject({ tipo: 'modify' });
    expect(analisarArquivo(base)?.hunks).toHaveLength(1);
    const novo = analisarArquivo({ ...base, status: 'A', patch: '@@ -0,0 +1 @@\n+z\n' });
    expect(novo?.tipo).toBe('add');
    const renomeado = analisarArquivo({ ...base, status: 'R', caminho_anterior: 'src/w.ts' });
    expect(renomeado?.tipo).toBe('rename');
  });

  it('binário e patch ilegível não quebram a tela', () => {
    expect(analisarArquivo({ ...base, binario: true })).toBeNull();
    expect(analisarArquivo({ ...base, patch: '' })).toEqual({ tipo: 'modify', hunks: [] });
  });
});
