import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pertenceAoCanalGlobal, type NovoEventoForja } from '../../comum/protocolo-eventos';
import { ambienteTemporario, semear, type Ambiente, type Semente } from './apoio-testes';
import { PersistenciaEventosSqlite } from './persistencia-eventos';
import { enxugarPayload, LIMITE_PAYLOAD_BYTES, origemPadrao } from './repositorios/evento';

let amb: Ambiente;
let s: Semente;
let p: PersistenciaEventosSqlite;

beforeEach(async () => {
  amb = await ambienteTemporario();
  s = await semear(amb.banco);
  p = new PersistenciaEventosSqlite(amb.banco);
});

afterEach(async () => {
  await amb.limpar();
});

function texto(execucaoId: string | null, t: string): NovoEventoForja {
  return {
    execucao_id: execucaoId,
    etapa_id: null,
    tipo: 'agente.texto',
    nivel: 'info',
    resumo: t,
    dados: {
      texto: t,
      truncado: false,
      pensamento: false,
      papel_agente: 'implementador',
      parent_tool_use_id: 'toolu_1',
    },
  };
}

const COTA: NovoEventoForja = {
  execucao_id: null,
  etapa_id: null,
  tipo: 'uso.atualizado',
  nivel: 'aviso',
  resumo: 'cota em 85%',
  dados: {
    utilizacao_5h: 0.85,
    utilizacao_7d: null,
    reinicia_5h_em: null,
    reinicia_7d_em: null,
    status: 'allowed_warning',
    usando_creditos_extras: false,
    freio_ativo: true,
  },
};

describe('PersistenciaEventosSqlite (02 §4.8, I-7)', () => {
  it('seq monotônico; o envelope gravado volta idêntico no replay', async () => {
    expect(await p.ultimoSeq()).toBe(0);
    const s1 = await p.gravar(texto(s.execucao.id, 'um'));
    const e2 = await p.registrar(COTA, { em: '2026-10-02T12:00:05.000Z' });
    const s3 = await p.gravar(texto(s.execucao.id, 'três'), { linha_bruta: 17 });
    expect([s1, e2.seq, s3]).toEqual([1, 2, 3]);
    expect(await p.ultimoSeq()).toBe(3);

    const tudo = await p.desde(0);
    expect(tudo.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(tudo[1]).toEqual(e2);
    expect(tudo[1]!.em).toBe('2026-10-02T12:00:05.000Z');
    expect(tudo[0]).toMatchObject({ tipo: 'agente.texto', nivel: 'info', resumo: 'um' });

    const [linha] = (await amb.banco.ds.query(
      `SELECT origem, papel_agente, parent_tool_use_id, linha_bruta FROM evento WHERE seq = 3`,
    )) as [Record<string, unknown>];
    expect(linha).toEqual({
      origem: 'cli',
      papel_agente: 'implementador',
      parent_tool_use_id: 'toolu_1',
      linha_bruta: 17,
    });
  });

  it('desde(seq, filtro): por execução, por tipo, por predicado e com limite', async () => {
    const outra = await semear(amb.banco, 43);
    await p.gravar(texto(s.execucao.id, 'a'));
    await p.gravar(COTA);
    await p.gravar(texto(outra.execucao.id, 'b'));
    await p.gravar(texto(s.execucao.id, 'c'));

    expect((await p.desde(0, { execucao_id: s.execucao.id })).map((e) => e.resumo)).toEqual([
      'a',
      'c',
    ]);
    expect((await p.desde(1, { execucao_id: s.execucao.id })).map((e) => e.resumo)).toEqual(['c']);
    expect((await p.desde(0, { tipos: ['uso.atualizado'] })).map((e) => e.seq)).toEqual([2]);
    expect(await p.desde(0, { tipos: [] })).toEqual([]);
    expect((await p.desde(0, { predicado: pertenceAoCanalGlobal })).map((e) => e.tipo)).toEqual([
      'uso.atualizado',
    ]);
    expect((await p.desde(0, { limite: 2 })).map((e) => e.seq)).toEqual([1, 2]);
    expect(await p.desde(4)).toEqual([]);
  });

  it('predicado pagina além de uma página de SQL', async () => {
    for (let i = 0; i < 620; i++) await p.gravar(texto(s.execucao.id, `t${i}`));
    await p.gravar(COTA);
    const globais = await p.desde(0, { predicado: pertenceAoCanalGlobal });
    expect(globais.map((e) => e.seq)).toEqual([621]);
  });

  it('payload acima de 8 KB é enxugado preservando a forma', async () => {
    const grande = texto(s.execucao.id, 'grande');
    (grande.dados as { texto: string }).texto = 'x'.repeat(50_000);
    const e = await p.registrar(grande);
    const dados = e.dados as { texto: string; truncado: boolean };
    expect(Buffer.byteLength(JSON.stringify(dados))).toBeLessThanOrEqual(LIMITE_PAYLOAD_BYTES);
    expect(dados.texto.endsWith('…')).toBe(true);
    expect(dados.truncado).toBe(false);
    expect((await p.desde(0))[0]!.dados).toEqual(dados);

    const lista = enxugarPayload({ itens: Array.from({ length: 5000 }, (_, i) => `item-${i}`) });
    expect(Buffer.byteLength(JSON.stringify(lista))).toBeLessThanOrEqual(LIMITE_PAYLOAD_BYTES);
    const pequeno = { a: 1 };
    expect(enxugarPayload(pequeno)).toBe(pequeno);
  });

  it('expurgo da retenção mantém app/humano e nunca reutiliza seq', async () => {
    await p.gravar(texto(s.execucao.id, 'cli'));
    await p.gravar(
      {
        execucao_id: s.execucao.id,
        etapa_id: null,
        tipo: 'execucao.estado',
        nivel: 'info',
        resumo: 'estado',
        dados: {
          estado: 'descartado',
          estado_anterior: 'na_fila',
          motivo_estado: null,
          numero: 42,
          projeto_id: s.projetoId,
        },
      },
      { origem: 'humano' },
    );
    const ultimo = await p.gravar(texto(s.execucao.id, 'cli 2'));
    const apagados = await amb.banco.transacao((r) => r.eventos.expurgar([s.execucao.id]));
    expect(apagados).toBe(2);
    expect((await p.desde(0)).map((e) => e.tipo)).toEqual(['execucao.estado']);
    expect(await p.gravar(texto(s.execucao.id, 'novo'))).toBe(ultimo + 1);
  });

  it('origem padrão por tipo do catálogo', () => {
    expect(origemPadrao('agente.ferramenta')).toBe('cli');
    expect(origemPadrao('verificacao.comando')).toBe('comando');
    expect(origemPadrao('chamado.sinal')).toBe('chamados');
    expect(origemPadrao('execucao.estado')).toBe('app');
    expect(origemPadrao('fila_merge.item')).toBe('app');
  });

  it('gravar dentro de uma transação que faz ROLLBACK não deixa o evento', async () => {
    await amb.banco
      .transacao(async () => {
        await p.gravar(texto(s.execucao.id, 'fantasma'));
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(await p.desde(0)).toEqual([]);
  });
});
