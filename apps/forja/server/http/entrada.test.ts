import { describe, expect, it } from 'vitest';
import { montarQuery } from '../../comum/dto';
import { ErroConexaoIndisponivel } from '../chamados/conexao';
import { ErroSessaoOcupada as ErroSessaoOcupadaRunner } from '../claude/lock-sessoes';
import { ErroNaoEncontrado, ErroRestricao } from '../db/erros';
import { ErroForja } from '../dominio/nucleo';
import { ErroSessaoOcupada } from '../processos/lock-sessao';
import { normalizarCorpo, normalizarQuery } from './entrada';
import { traduzirErro } from './erros-api';

describe('normalizarQuery (comum/dto montarQuery → DTO tipado)', () => {
  it('faz o caminho de volta de montarQuery', () => {
    const qs = montarQuery({
      status: ['novo'],
      prioridade: ['alta', 'urgente'],
      so_implementaveis: true,
      limite: 50,
      busca: 'relatório',
    });
    const consulta = Object.fromEntries(
      [...new URLSearchParams(qs.slice(1)).entries()].reduce((m, [k, v]) => {
        const atual = m.get(k);
        m.set(k, atual === undefined ? v : Array.isArray(atual) ? [...atual, v] : [atual, v]);
        return m;
      }, new Map<string, string | string[]>()),
    );
    expect(normalizarQuery(consulta)).toEqual({
      ok: true,
      entrada: {
        status: ['novo'],
        prioridade: ['alta', 'urgente'],
        so_implementaveis: true,
        limite: 50,
        busca: 'relatório',
      },
    });
  });

  it('aceita CSV nas listas e ignora t/ultimo_seq', () => {
    expect(normalizarQuery({ status: 'novo,em_triagem', t: 'x', ultimo_seq: '3' })).toEqual({
      ok: true,
      entrada: { status: ['novo', 'em_triagem'] },
    });
  });

  it('número e booleano inválidos → erro (nunca NaN silencioso)', () => {
    expect(normalizarQuery({ limite: '-1' }).ok).toBe(false);
    expect(normalizarQuery({ pagina: '1e3' }).ok).toBe(false);
    expect(normalizarQuery({ so_implementaveis: 'sim' }).ok).toBe(false);
  });

  it('corpo: objeto passa, ausente vira {}, lista/escalar é recusado', () => {
    expect(normalizarCorpo(undefined)).toEqual({ ok: true, entrada: {} });
    expect(normalizarCorpo({ a: 1 })).toEqual({ ok: true, entrada: { a: 1 } });
    expect(normalizarCorpo([1]).ok).toBe(false);
    expect(normalizarCorpo('x').ok).toBe(false);
  });
});

describe('traduzirErro (ErroApiDto com código estável)', () => {
  it('ErroForja mantém código e status', () => {
    expect(traduzirErro(new ErroForja('pre_condicao_falhou', 'sem worktree', 409))).toEqual({
      status: 409,
      corpo: { erro: 'pre_condicao_falhou', mensagem: 'sem worktree' },
    });
  });

  it('erros dos pacotes da R2 viram 404/409/400/503', () => {
    expect(traduzirErro(new ErroNaoEncontrado('projeto', 'p1')).status).toBe(404);
    expect(traduzirErro(new ErroRestricao('I-1', 'x', 'dup')).status).toBe(409);
    expect(traduzirErro(new ErroRestricao('chave_estrangeira', 'x', 'fk')).status).toBe(400);
    expect(
      traduzirErro(new ErroSessaoOcupada('s', { tipo: 'terminal', sessao_terminal_id: 't' }))
        .status,
    ).toBe(409);
    expect(traduzirErro(new ErroSessaoOcupadaRunner('s', 'runner:x')).status).toBe(409);
    expect(traduzirErro(new ErroConexaoIndisponivel('sem_senha', 'sem senha')).corpo.erro).toBe(
      'chamados_indisponivel',
    );
  });

  it('ErroTerminal reconhecido pelo formato (sem importar node-pty)', () => {
    class ErroTerminal extends Error {
      constructor(readonly codigo: string) {
        super('limite');
      }
    }
    expect(traduzirErro(new ErroTerminal('limite_ptys')).status).toBe(409);
    expect(traduzirErro(new ErroTerminal('sessao_inexistente')).status).toBe(404);
  });

  it('desconhecido → 500 genérico, detalhe só no log', () => {
    const logs: unknown[] = [];
    const r = traduzirErro(new Error('SQLITE_BUSY em /home/x/forja.db'), (_m, e) => logs.push(e));
    expect(r.status).toBe(500);
    expect(r.corpo.mensagem).not.toContain('SQLITE');
    expect(logs).toHaveLength(1);
  });
});
