import { describe, expect, it } from 'vitest';
import { ROTAS_API, montarCaminho, montarQuery, type NomeRota } from './dto';

describe('ROTAS_API (contrato servidor ⇄ SPA)', () => {
  const rotas = Object.entries(ROTAS_API) as [NomeRota, (typeof ROTAS_API)[NomeRota]][];

  it('todo caminho é sob /api e não há método+caminho repetido', () => {
    const vistos = new Set<string>();
    for (const [nome, def] of rotas) {
      expect(def.caminho.startsWith('/api/'), nome).toBe(true);
      const chave = `${def.metodo} ${def.caminho}`;
      expect(vistos.has(chave), `duplicada: ${chave}`).toBe(false);
      vistos.add(chave);
    }
  });

  it('SSE e WebSocket são sempre GET; binários também', () => {
    for (const [nome, def] of rotas) {
      if (def.transporte !== 'json') expect(def.metodo, nome).toBe('GET');
    }
  });

  it('os canais de 01 §8.1 existem com os caminhos da spec', () => {
    expect(ROTAS_API.eventos_global.caminho).toBe('/api/eventos');
    expect(ROTAS_API.execucao_eventos.caminho).toBe('/api/execucoes/:id/eventos');
    expect(ROTAS_API.terminal_ws.caminho).toBe('/api/terminal/:sessao');
    expect(ROTAS_API.saude.caminho).toBe('/api/saude');
  });

  it('parâmetros só com letras minúsculas e _ (casam com montarCaminho)', () => {
    for (const [, def] of rotas) {
      for (const trecho of def.caminho.split('/')) {
        if (trecho.startsWith(':')) expect(trecho).toMatch(/^:[a-z_]+$/);
      }
    }
  });
});

describe('montarCaminho', () => {
  it('substitui e codifica os parâmetros', () => {
    expect(
      montarCaminho(ROTAS_API.execucao_transcript.caminho, { id: 'a b', etapa_id: 'e/1' }),
    ).toBe('/api/execucoes/a%20b/etapas/e%2F1/transcript');
  });

  it('lança quando falta parâmetro', () => {
    expect(() => montarCaminho('/api/execucoes/:id', {})).toThrow(/id/);
  });

  it('caminho sem parâmetro fica igual', () => {
    expect(montarCaminho('/api/fila')).toBe('/api/fila');
  });
});

describe('montarQuery', () => {
  it('repete a chave para arrays e omite undefined/null', () => {
    expect(
      montarQuery({ status: ['em_atendimento', 'aguardando_cliente'], busca: undefined, x: null }),
    ).toBe('?status=em_atendimento&status=aguardando_cliente');
  });

  it('converte booleanos e números; vazio vira string vazia', () => {
    expect(montarQuery({ so_implementaveis: true, limite: 50 })).toBe(
      '?so_implementaveis=true&limite=50',
    );
    expect(montarQuery({})).toBe('');
    expect(montarQuery(undefined)).toBe('');
  });
});
