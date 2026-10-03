import { describe, expect, it } from 'vitest';
import { interpretarErro, urlRota } from './api';
import { eventoNovo, montarUrlSse, proximoAtraso } from './sse';
import { mensagemRedimensionar, urlTerminalWs } from './terminal';

describe('api (cliente tipado por ROTAS_API)', () => {
  it('monta URL com parâmetros e query só em GET', () => {
    expect(urlRota('execucao_obter', { id: 'abc' })).toBe('/api/execucoes/abc');
    expect(urlRota('fila_listar', undefined, { status: ['em_atendimento'], busca: 'x' })).toBe(
      '/api/fila?status=em_atendimento&busca=x',
    );
    expect(urlRota('execucao_conversar', { id: 'e1' }, { texto: 'oi' })).toBe(
      '/api/execucoes/e1/conversa',
    );
  });

  it('interpreta ErroApiDto e status sem corpo', () => {
    const e = interpretarErro(501, { erro: 'nao_implementado', mensagem: 'ainda não' });
    expect(e.codigo).toBe('nao_implementado');
    expect(e.naoImplementado).toBe(true);
    expect(e.message).toBe('ainda não');
    expect(interpretarErro(401, null).codigo).toBe('nao_autenticado');
    expect(interpretarErro(502, 'x').codigo).toBe('erro_interno');
    expect(interpretarErro(400, {}).codigo).toBe('entrada_invalida');
  });
});

describe('sse (reconexão com Last-Event-ID)', () => {
  it('backoff exponencial com teto de 30 s', () => {
    expect([0, 1, 2, 3].map(proximoAtraso)).toEqual([1000, 2000, 4000, 8000]);
    expect(proximoAtraso(10)).toBe(30_000);
  });

  it('passa o último seq na URL da reconexão', () => {
    expect(montarUrlSse('/api/eventos', null)).toBe('/api/eventos');
    expect(montarUrlSse('/api/eventos', 42)).toBe('/api/eventos?ultimo_seq=42');
    expect(montarUrlSse('/api/x?a=1', 0)).toBe('/api/x?a=1&ultimo_seq=0');
  });

  it('descarta duplicatas', () => {
    expect(eventoNovo(5, null)).toBe(true);
    expect(eventoNovo(5, 4)).toBe(true);
    expect(eventoNovo(5, 5)).toBe(false);
    expect(eventoNovo(3, 5)).toBe(false);
  });
});

describe('terminal (protocolo do WebSocket)', () => {
  it('monta ws:// na mesma origem', () => {
    expect(urlTerminalWs('s1', { protocol: 'http:', host: '127.0.0.1:4317' })).toBe(
      'ws://127.0.0.1:4317/api/terminal/s1',
    );
  });

  it('redimensionar sai como JSON de controle com inteiros ≥ 1', () => {
    expect(JSON.parse(mensagemRedimensionar(80.7, 0))).toEqual({
      tipo: 'redimensionar',
      colunas: 80,
      linhas: 1,
    });
  });
});
