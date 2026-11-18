import { describe, expect, it } from 'vitest';
import { Papel, VisibilidadeMensagem } from './enums';
import { respostaAtribui } from './atribuicao';

const OP_A = '00000000-0000-4000-8000-00000000000a';
const OP_B = '00000000-0000-4000-8000-00000000000b';

function caso(
  autorPapel: Papel,
  visibilidade: VisibilidadeMensagem,
  operadorAtualId: string | null,
  autorId = OP_A,
): boolean {
  return respostaAtribui({ autorPapel, autorId, visibilidade, operadorAtualId });
}

describe('respostaAtribui (D-039)', () => {
  it('resposta pública de operador num chamado sem responsável atribui', () => {
    expect(caso(Papel.operador, VisibilidadeMensagem.publica, null)).toBe(true);
  });

  it('admin também assume ao responder em público', () => {
    expect(caso(Papel.admin, VisibilidadeMensagem.publica, null)).toBe(true);
  });

  it('substitui o responsável anterior (segundo operador que responde assume)', () => {
    expect(caso(Papel.operador, VisibilidadeMensagem.publica, OP_B)).toBe(true);
    expect(caso(Papel.admin, VisibilidadeMensagem.publica, OP_B)).toBe(true);
  });

  it('autor que já é o responsável: nada acontece (sem evento duplicado)', () => {
    expect(caso(Papel.operador, VisibilidadeMensagem.publica, OP_A)).toBe(false);
    expect(caso(Papel.admin, VisibilidadeMensagem.publica, OP_A)).toBe(false);
  });

  it('nota interna nunca atribui', () => {
    expect(caso(Papel.operador, VisibilidadeMensagem.interna, null)).toBe(false);
    expect(caso(Papel.admin, VisibilidadeMensagem.interna, OP_B)).toBe(false);
  });

  it('agente_ia e cliente nunca assumem por responder', () => {
    expect(caso(Papel.agente_ia, VisibilidadeMensagem.publica, null)).toBe(false);
    expect(caso(Papel.agente_ia, VisibilidadeMensagem.publica, OP_B)).toBe(false);
    expect(caso(Papel.cliente, VisibilidadeMensagem.publica, null)).toBe(false);
    expect(caso(Papel.cliente, VisibilidadeMensagem.publica, OP_B)).toBe(false);
  });

  it('autor sem id (defensivo) não atribui', () => {
    expect(caso(Papel.operador, VisibilidadeMensagem.publica, null, '')).toBe(false);
  });
});
