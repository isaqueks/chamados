import { describe, expect, it } from 'vitest';
import type { ExecucaoResumoDto, LinhaFilaDto, PreCondicaoDto } from '@comum/dto';
import {
  alternarSelecao,
  alternarTodos,
  celulaForja,
  exigeConfirmacaoAguardandoCliente,
  filtrarEmMemoria,
  haQuantoTempo,
  ordenarLinhas,
  podarSelecao,
  rotuloFiltro,
  selecionavel,
} from './logica-fila';
import { focoEmCampoDeTexto, teclaDoEvento } from './atalhos-teclado';

function linha(
  over: Partial<LinhaFilaDto['chamado']> & { id: string },
  extra: Partial<LinhaFilaDto> = {},
): LinhaFilaDto {
  const { id, ...chamado } = over;
  return {
    chamado: {
      chamado_id: id,
      numero: Number(id.replace(/\D/g, '')) || 1,
      titulo: `Chamado ${id}`,
      status: 'em_atendimento',
      natureza: 'problema',
      prioridade: 'media',
      complexidade: 'medio',
      sistema_nome: 'ERP',
      atualizado_em_remoto: '2026-10-01T10:00:00.000Z',
      ...chamado,
    },
    sinais: {
      carregado: true,
      tem_spec_ia: false,
      tem_diagnostico_ia: false,
      tem_pr_ia: false,
      branch_ia: null,
      ia_silenciada: true,
      cliente_respondeu: false,
    },
    pre_condicoes: [],
    implementavel: true,
    execucao: null,
    ...extra,
  };
}

function execucao(estado: ExecucaoResumoDto['estado'], id = 'e1'): ExecucaoResumoDto {
  return {
    id,
    numero: 1,
    tentativa: 1,
    estado,
    grupo: 'trabalhando',
    estado_anterior: null,
    motivo_estado: null,
    etapa_atual: null,
    progresso: null,
    ciclo_auto: 0,
    ciclo_total: 0,
    custo_micro_usd: 0,
    altera_ui: false,
    evidencia_visual: null,
    retoma_em: null,
    atualizado_em: '2026-10-01T10:00:00.000Z',
  };
}

const faltaMapa: PreCondicaoDto = {
  codigo: 'sistema_mapeado',
  ok: false,
  motivo: 'O sistema-alvo deste chamado não está ligado a nenhum projeto.',
  acao: null,
};

describe('fila: ordenação e filtros', () => {
  it('ordena por prioridade desc e depois atualização mais recente', () => {
    const l = ordenarLinhas([
      linha({ id: 'c1', prioridade: 'baixa' }),
      linha({ id: 'c2', prioridade: 'urgente' }),
      linha({ id: 'c3', prioridade: 'alta', atualizado_em_remoto: '2026-10-01T09:00:00.000Z' }),
      linha({ id: 'c4', prioridade: 'alta', atualizado_em_remoto: '2026-10-01T11:00:00.000Z' }),
    ]);
    expect(l.map((x) => x.chamado.chamado_id)).toEqual(['c2', 'c4', 'c3', 'c1']);
  });

  it('filtra complexidade em memória, busca por número (#) ou título e só implementáveis', () => {
    const linhas = [
      linha({ id: 'c128', titulo: 'Desconto no boleto', complexidade: 'dificil' }),
      linha({ id: 'c131', titulo: 'Rótulo CNPJ', complexidade: 'facil' }),
      linha(
        { id: 'c133', complexidade: null },
        { implementavel: false, pre_condicoes: [faltaMapa] },
      ),
    ];
    expect(
      filtrarEmMemoria(linhas, { complexidade: ['facil'] }).map((x) => x.chamado.numero),
    ).toEqual([131]);
    expect(filtrarEmMemoria(linhas, { busca: '#12' }).map((x) => x.chamado.numero)).toEqual([128]);
    expect(filtrarEmMemoria(linhas, { busca: 'boleto' }).map((x) => x.chamado.numero)).toEqual([
      128,
    ]);
    expect(filtrarEmMemoria(linhas, { so_implementaveis: true })).toHaveLength(2);
  });

  it('rótulo do dropdown mostra o valor único ou a quantidade', () => {
    expect(rotuloFiltro('Status', [], (v) => v)).toBe('Status');
    expect(rotuloFiltro('Status', ['a'], (v) => v.toUpperCase())).toBe('Status: A');
    expect(rotuloFiltro('Status', ['a', 'b'], (v) => v)).toBe('Status (2)');
  });
});

describe('fila: coluna Forja e seleção do lote', () => {
  it('decide a célula por execução, status e pré-condições', () => {
    expect(celulaForja(linha({ id: 'c1' })).tipo).toBe('implementar');
    expect(celulaForja(linha({ id: 'c1' }, { execucao: execucao('implementando') }))).toEqual({
      tipo: 'em_voo',
      href: '/execucoes/e1',
    });
    expect(
      celulaForja(linha({ id: 'c1' }, { execucao: execucao('aguardando_aprovacao') })),
    ).toEqual({
      tipo: 'aprovar',
      href: '/execucoes/e1/aprovacao',
    });
    // Execução encerrada não conta como ativa: volta a oferecer Implementar.
    expect(celulaForja(linha({ id: 'c1' }, { execucao: execucao('descartado') })).tipo).toBe(
      'implementar',
    );
    expect(
      celulaForja(linha({ id: 'c1', status: 'em_triagem' }, { implementavel: false })).tipo,
    ).toBe('triagem');
    expect(celulaForja(linha({ id: 'c1', status: 'fechado' }, { implementavel: false })).tipo).toBe(
      'terminal',
    );
    expect(
      celulaForja(linha({ id: 'c1' }, { implementavel: false, pre_condicoes: [faltaMapa] })),
    ).toEqual({
      tipo: 'indisponivel',
      motivos: ['O sistema-alvo deste chamado não está ligado a nenhum projeto.'],
    });
  });

  it('aguardando_cliente exige confirmação', () => {
    const l = linha(
      { id: 'c1', status: 'aguardando_cliente' },
      {
        pre_condicoes: [
          { codigo: 'status', ok: true, motivo: null, acao: null, exige_confirmacao: true },
        ],
      },
    );
    expect(exigeConfirmacaoAguardandoCliente(l)).toBe(true);
    expect(exigeConfirmacaoAguardandoCliente(linha({ id: 'c2' }))).toBe(false);
  });

  it('só implementáveis sem execução ativa são selecionáveis; poda e alterna', () => {
    const a = linha({ id: 'a' });
    const b = linha({ id: 'b' }, { execucao: execucao('planejando') });
    const c = linha({ id: 'c' }, { implementavel: false, pre_condicoes: [faltaMapa] });
    expect([a, b, c].map(selecionavel)).toEqual([true, false, false]);
    expect([...podarSelecao(new Set(['a', 'b', 'x']), [a, b, c])]).toEqual(['a']);
    expect([...alternarSelecao(new Set(['a']), 'a')]).toEqual([]);
    expect([...alternarTodos(new Set(), [a, b, c])]).toEqual(['a']);
    expect([...alternarTodos(new Set(['a']), [a, b, c])]).toEqual([]);
  });

  it('formata "sincronizado há…"', () => {
    const agora = new Date('2026-10-01T10:00:40.000Z');
    expect(haQuantoTempo('2026-10-01T10:00:00.000Z', agora)).toBe('há 40 s');
    expect(haQuantoTempo('2026-10-01T09:57:00.000Z', agora)).toBe('há 3 min');
    expect(haQuantoTempo(null, agora)).toBeNull();
  });
});

describe('atalhos de teclado (06 §9)', () => {
  const base = { ctrlKey: false, altKey: false, metaKey: false, alvo: null, dialogoAberto: false };

  it('desliga em campo de texto, com modificador ou com diálogo aberto', () => {
    expect(teclaDoEvento({ ...base, key: 'J' })).toBe('j');
    expect(teclaDoEvento({ ...base, key: 'Enter' })).toBe('Enter');
    expect(teclaDoEvento({ ...base, key: 'a', alvo: { tagName: 'TEXTAREA' } })).toBeNull();
    expect(
      teclaDoEvento({ ...base, key: 'a', alvo: { tagName: 'INPUT', tipo: 'text' } }),
    ).toBeNull();
    expect(teclaDoEvento({ ...base, key: 'x', alvo: { tagName: 'INPUT', tipo: 'checkbox' } })).toBe(
      'x',
    );
    expect(teclaDoEvento({ ...base, key: 'a', ctrlKey: true })).toBeNull();
    expect(teclaDoEvento({ ...base, key: 'a', dialogoAberto: true })).toBeNull();
    expect(teclaDoEvento({ ...base, key: 'ArrowDown' })).toBeNull();
  });

  it('contenteditable conta como campo de texto', () => {
    expect(focoEmCampoDeTexto({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(focoEmCampoDeTexto({ tagName: 'BUTTON' })).toBe(false);
  });
});
