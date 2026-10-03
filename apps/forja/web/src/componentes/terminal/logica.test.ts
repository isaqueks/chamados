import { describe, expect, it } from 'vitest';
import type { SessaoTerminalDto } from '@comum/dto';
import {
  descreverSaida,
  direcaoAtalho,
  indiceVizinho,
  ordenarSessoes,
  rgbParaHex,
  temaTerminal,
} from './logica';

function sessao(id: string, viva: boolean, aberta_em: string): SessaoTerminalDto {
  return {
    id,
    tipo: 'livre',
    titulo: id,
    cwd: '/repo',
    execucao_id: null,
    numero: null,
    etapa_tipo: null,
    session_id_claude: null,
    viva,
    aberta_em,
    encerrada_em: null,
  };
}

const tecla = (
  key: string,
  p: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {},
) => ({
  key,
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...p,
});

describe('terminal (06 §4.7, 01 §8.1)', () => {
  it('abas vivas primeiro, pela abertura', () => {
    const s = ordenarSessoes([
      sessao('c', false, '2026-10-02T09:00:00Z'),
      sessao('b', true, '2026-10-02T11:00:00Z'),
      sessao('a', true, '2026-10-02T10:00:00Z'),
    ]);
    expect(s.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('Ctrl+Shift+←/→ troca de aba com volta', () => {
    expect(direcaoAtalho(tecla('ArrowLeft'))).toBe(-1);
    expect(direcaoAtalho(tecla('ArrowRight'))).toBe(1);
    expect(direcaoAtalho(tecla('ArrowRight', { shiftKey: false }))).toBeNull();
    expect(direcaoAtalho(tecla('ArrowRight', { altKey: true }))).toBeNull();
    expect(direcaoAtalho(tecla('a'))).toBeNull();
    expect(indiceVizinho(0, 3, -1)).toBe(2);
    expect(indiceVizinho(2, 3, 1)).toBe(0);
    expect(indiceVizinho(-1, 3, 1)).toBe(1);
    expect(indiceVizinho(0, 0, 1)).toBe(-1);
  });

  it('texto da saída do processo', () => {
    expect(descreverSaida({ codigo: 0, sinal: null })).toBe('saiu com código 0');
    expect(descreverSaida({ codigo: null, sinal: 'SIGHUP' })).toBe('encerrado por SIGHUP');
  });

  it('tema derivado dos tokens, com fallback', () => {
    expect(rgbParaHex(255, 0, 16.4)).toBe('#ff0010');
    const cores: Record<string, string> = {
      '--card': '#101010',
      '--card-foreground': '#eeeeee',
      '--primary': '#3399aa',
    };
    expect(temaTerminal((t) => cores[t] ?? null)).toEqual({
      background: '#101010',
      foreground: '#eeeeee',
      cursor: '#3399aa',
      cursorAccent: '#101010',
      selectionBackground: '#3399aa55',
    });
    expect(temaTerminal(() => null).background).toBe('#ffffff');
  });
});
