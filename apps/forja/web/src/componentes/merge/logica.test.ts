import { describe, expect, it } from 'vitest';
import type { FilaMergeDto, ItemFilaMergeDto } from '@comum/dto';
import { montarFila, montarVisaoFilaMerge, novaOrdem, selecaoValida } from './logica';

function item(id: string, ordem: number, estado: ItemFilaMergeDto['estado']): ItemFilaMergeDto {
  return {
    id,
    ordem,
    execucao_id: `e-${id}`,
    numero: ordem * 10,
    titulo: id,
    patch_id: 'abcdef123',
    estado,
    motivo: null,
    passos: [],
    sha_destino_antes: null,
    copia_local_atras: false,
  };
}

function dto(p: Partial<FilaMergeDto> = {}): FilaMergeDto {
  return {
    filas: [],
    pendencias_chamados: [],
    a_publicar: [],
    concluidos_recentes: [],
    token_schema: null,
    sentinelas: [],
    ...p,
  };
}

const filaAcme = {
  projeto_id: 'p1',
  projeto_nome: 'ERP Acme',
  branch_destino: 'main',
  remoto: 'origin',
  modo_entrega: 'merge_e_push' as const,
  aviso_copia_local: null,
  itens: [
    item('c', 3, 'aguardando'),
    item('a', 1, 'verificando'),
    item('b', 2, 'aguardando'),
    item('x', 4, 'conflito'),
  ],
};

describe('agrupamento da fila de merge (06 §4.6)', () => {
  it('item em processamento no topo; aguardando por ordem; conflito/devolvido à parte', () => {
    const f = montarFila(filaAcme);
    expect(f.emProcessamento?.id).toBe('a');
    expect(f.aguardando.map((i) => i.id)).toEqual(['b', 'c']);
    expect(f.fora.map((i) => i.id)).toEqual(['x']);
    expect(f.total).toBe(4);
    expect(f.chave).toBe('p1:main');
  });

  it('filtra filas, sentinelas e token pelo projeto atual; alertas antes de tudo', () => {
    const v = montarVisaoFilaMerge(
      dto({
        filas: [filaAcme, { ...filaAcme, projeto_id: 'p2', projeto_nome: 'Outro', itens: [] }],
        sentinelas: [
          { projeto_id: 'p1', execucao_id: 'e1', numero: 1, divergencias: ['~/.gitconfig'] },
          { projeto_id: 'p2', execucao_id: 'e2', numero: 2, divergencias: ['~/.bashrc'] },
        ],
        token_schema: { projeto_id: 'p1', execucao_id: 'e9', numero: 9, preso: true },
      }),
      'p1',
    );
    expect(v.filas.map((f) => f.fila.projeto_id)).toEqual(['p1']);
    expect(v.alertas.map((a) => `${a.tipo}:${a.numero}`)).toEqual([
      'sentinela:1',
      'token_schema:9',
    ]);
    expect(v.vazia).toBe(false);
  });

  it('token de schema só vira faixa quando está preso', () => {
    const v = montarVisaoFilaMerge(
      dto({ token_schema: { projeto_id: 'p1', execucao_id: 'e9', numero: 9, preso: false } }),
      null,
    );
    expect(v.alertas).toEqual([]);
    expect(v.vazia).toBe(true);
  });

  it('pendências por próxima tentativa (sem horário por último); concluídos mais recentes primeiro', () => {
    const v = montarVisaoFilaMerge(
      dto({
        pendencias_chamados: [
          {
            execucao_id: 'a',
            numero: 3,
            sha_merge: null,
            passo: 'mensagem_publica',
            erro: 'rede',
            ultimo_http: null,
            proxima_em: null,
          },
          {
            execucao_id: 'b',
            numero: 2,
            sha_merge: null,
            passo: 'nota_interna',
            erro: 'rede',
            ultimo_http: 502,
            proxima_em: '2026-10-02T10:20:00.000Z',
          },
          {
            execucao_id: 'c',
            numero: 1,
            sha_merge: null,
            passo: 'status_resolvido',
            erro: 'rede',
            ultimo_http: null,
            proxima_em: '2026-10-02T10:14:00.000Z',
          },
        ],
        concluidos_recentes: [
          {
            execucao_id: 'x',
            numero: 1,
            titulo: '',
            status_final: 'resolvido',
            concluido_em: '2026-10-02T09:00:00.000Z',
            url_no_chamados: '',
          },
          {
            execucao_id: 'y',
            numero: 2,
            titulo: '',
            status_final: 'resolvido',
            concluido_em: '2026-10-02T12:00:00.000Z',
            url_no_chamados: '',
          },
        ],
      }),
      null,
    );
    expect(v.pendencias.map((p) => p.execucao_id)).toEqual(['c', 'b', 'a']);
    expect(v.concluidos.map((c) => c.execucao_id)).toEqual(['y', 'x']);
  });

  it('reordenar troca com o vizinho e nunca move além das bordas', () => {
    const { aguardando } = montarFila(filaAcme);
    expect(novaOrdem(aguardando, 'c', 'subir')).toBe(2);
    expect(novaOrdem(aguardando, 'b', 'descer')).toBe(3);
    expect(novaOrdem(aguardando, 'b', 'subir')).toBeNull();
    expect(novaOrdem(aguardando, 'a', 'descer')).toBeNull();
  });

  it('seleção de "a publicar" descarta o que saiu da lista', () => {
    const s = selecaoValida(new Set(['e1', 'e2']), [
      { execucao_id: 'e2', numero: 2, titulo: '', sha_merge: 'abc' },
    ]);
    expect([...s]).toEqual(['e2']);
  });
});
