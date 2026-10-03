import { describe, expect, it } from 'vitest';
import type { EventoForja } from '@comum/protocolo-eventos';
import {
  arvoreDoFeed,
  contarNegacoes,
  exigeRecarregarAprovacao,
  exigeRecarregarExecucao,
  mesclarEventos,
  montarArvoreFeed,
  semAtividadeHa,
  textoDaLinha,
  tomDaLinha,
  ultimoMarco,
} from './arvore-feed';

let seq = 0;
function ev<E extends EventoForja>(
  tipo: E['tipo'],
  dados: E['dados'],
  extra: Partial<EventoForja> = {},
): EventoForja {
  seq += 1;
  return {
    seq,
    em: new Date(Date.UTC(2026, 9, 1, 10, 0, seq)).toISOString(),
    execucao_id: 'e1',
    etapa_id: 's1',
    tipo,
    nivel: 'info',
    resumo: `${tipo} ${seq}`,
    dados,
    ...extra,
  } as EventoForja;
}

const autoria = (parent: string | null) => ({ papel_agente: null, parent_tool_use_id: parent });

function ferramenta(
  id: string,
  nome: string,
  parent: string | null,
  subagente: string | null = null,
) {
  return ev('agente.ferramenta', {
    ...autoria(parent),
    tool_use_id: id,
    ferramenta: nome,
    resumo_entrada: `${nome} ${id}`,
    subagente,
  });
}

describe('árvore do feed Fable → Opus (parent_tool_use_id)', () => {
  it('aninha os eventos do subagente sob o despacho Agent e anexa o resultado à ferramenta', () => {
    seq = 0;
    const eventos = [
      ev('etapa.iniciada', {
        tipo_etapa: 'implementar',
        n: 2,
        ciclo: 1,
        papel: 'condutor',
        session_id: '3f2a',
        retomada: false,
        modelo: 'claude-fable-5-1',
      }),
      ferramenta('tu_agent', 'Agent', null, 'implementador'),
      ev('subagente.iniciado', {
        tool_use_id: 'tu_agent',
        subagente: 'implementador',
        descricao: 'passo 1',
      }),
      ferramenta('tu_edit', 'Edit', 'tu_agent'),
      ferramenta('tu_bash', 'Bash', 'tu_agent'),
      ev('agente.resultado_ferramenta', {
        ...autoria('tu_agent'),
        tool_use_id: 'tu_bash',
        erro: false,
        resumo: 'exit 0',
      }),
      ev('subagente.concluido', {
        tool_use_id: 'tu_agent',
        subagente: 'implementador',
        status: 'completed',
        resumo: 'feito',
        modelo: 'claude-opus-5-5',
      }),
      ev('git.checkpoint', { sha: 'a1b2c3d4e5', passo: 'P1', mensagem: 'passo 1', arquivos: 2 }),
    ];
    const arvore = montarArvoreFeed(eventos);
    expect(arvore).toHaveLength(3);
    const despacho = arvore[1]!;
    expect(despacho.subagente).toMatchObject({
      nome: 'implementador',
      descricao: 'passo 1',
      modelo: 'claude-opus-5-5',
      status: 'completed',
    });
    expect(despacho.filhos.map((f) => f.evento?.tipo)).toEqual([
      'agente.ferramenta',
      'agente.ferramenta',
    ]);
    expect(despacho.filhos[1]!.resultado?.dados.resumo).toBe('exit 0');
  });

  it('aninha em vários níveis (subagente que despacha subagente)', () => {
    seq = 0;
    const arvore = montarArvoreFeed([
      ferramenta('a1', 'Agent', null, 'implementador'),
      ferramenta('a2', 'Agent', 'a1', 'revisor_correcao'),
      ferramenta('r1', 'Read', 'a2'),
    ]);
    expect(arvore).toHaveLength(1);
    expect(arvore[0]!.filhos[0]!.subagente?.nome).toBe('revisor_correcao');
    expect(arvore[0]!.filhos[0]!.filhos[0]!.evento?.tipo).toBe('agente.ferramenta');
  });

  it('pai fora da janela carregada vira grupo órfão e é adotado quando o despacho chega', () => {
    seq = 0;
    const filho = ferramenta('t1', 'Edit', 'a_antigo');
    const arvore = montarArvoreFeed([filho]);
    expect(arvore).toHaveLength(1);
    expect(arvore[0]!.orfao).toBe(true);
    expect(arvore[0]!.filhos).toHaveLength(1);

    const despacho = ev('agente.ferramenta', {
      ...autoria(null),
      tool_use_id: 'a_antigo',
      ferramenta: 'Agent',
      resumo_entrada: 'x',
      subagente: 'implementador',
    });
    const adotada = montarArvoreFeed([filho, despacho]);
    expect(adotada).toHaveLength(1);
    expect(adotada[0]!.orfao).toBe(false);
    expect(adotada[0]!.subagente?.nome).toBe('implementador');
    expect(adotada[0]!.filhos).toHaveLength(1);
  });

  it('modo Marcos poda texto e leituras, mas mantém negações e a estrutura', () => {
    seq = 0;
    const eventos = [
      ferramenta('a1', 'Agent', null, 'implementador'),
      ev('agente.texto', {
        ...autoria('a1'),
        texto: 'pensando',
        truncado: false,
        pensamento: false,
      }),
      ferramenta('r1', 'Read', 'a1'),
      ev('permissao.negada', { ...autoria('a1'), ferramenta: 'Bash', resumo_entrada: 'git push' }),
      ev('agente.texto', { ...autoria(null), texto: 'oi', truncado: false, pensamento: false }),
    ];
    const marcos = arvoreDoFeed(eventos, 'marcos');
    expect(marcos).toHaveLength(1);
    expect(marcos[0]!.filhos.map((f) => f.evento?.tipo)).toEqual(['permissao.negada']);
    const tudo = arvoreDoFeed(eventos, 'tudo');
    expect(tudo).toHaveLength(2);
    expect(tudo[0]!.filhos).toHaveLength(3);
  });

  it('negações: contagem por etapa, texto e tom rose', () => {
    seq = 0;
    const n1 = ev('permissao.negada', {
      ...autoria(null),
      ferramenta: 'Bash',
      resumo_entrada: 'git push',
    });
    const n2 = ev(
      'permissao.negada',
      { ...autoria(null), ferramenta: 'Read', resumo_entrada: '~/.ssh' },
      { etapa_id: 's2' },
    );
    expect(contarNegacoes([n1, n2])).toBe(2);
    expect(contarNegacoes([n1, n2], 's2')).toBe(1);
    expect(textoDaLinha(n1)).toBe('NEGADO Bash(git push) · regra deny da Forja');
    expect(tomDaLinha(n1)).toBe('negacao');
    const fora = ev('agente.fora_do_papel', { ...autoria(null), ferramenta: 'Edit', alvo: 'a.ts' });
    expect(tomDaLinha(fora)).toBe('fora_do_papel');
  });

  it('mescla sem duplicar, acha o último marco e mede o silêncio apontado pelo servidor', () => {
    seq = 0;
    const a = ev('agente.texto', {
      ...autoria(null),
      texto: 'a',
      truncado: false,
      pensamento: false,
    });
    const b = ferramenta('t', 'Edit', null);
    const c = ev('agente.texto', {
      ...autoria(null),
      texto: 'c',
      truncado: false,
      pensamento: false,
    });
    const m = mesclarEventos([a, b], [b, c]);
    expect(m.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ultimoMarco(m)?.seq).toBe(2);
    // O limiar é do servidor (aviso_inatividade do projeto): a UI só mede a duração.
    const agora = new Date(Date.parse(c.em) + 16 * 60_000);
    expect(semAtividadeHa(c.em, agora)).toBe(16 * 60_000);
    expect(semAtividadeHa(null, agora)).toBeNull();
    expect(semAtividadeHa('não é data', agora)).toBeNull();
    expect(exigeRecarregarExecucao(a)).toBe(false);
    expect(exigeRecarregarAprovacao(a)).toBe(false);
    expect(
      exigeRecarregarAprovacao(
        ev('chamado.sinal', { numero: 1, sinal: 'mensagem_nova', detalhe: '' }),
      ),
    ).toBe(true);
    expect(
      exigeRecarregarAprovacao(
        ev('git.checkpoint', { sha: 'abc', passo: null, mensagem: 'm', arquivos: 1 }),
      ),
    ).toBe(true);
  });
});

describe('formatação da Execução', () => {
  it('duração, modelo, autor e ciclos', async () => {
    const f = await import('./formato-execucao');
    expect(f.formatarDuracao(45_000)).toBe('45 s');
    expect(f.formatarDuracao(18 * 60_000)).toBe('18 min');
    expect(f.formatarDuracao(65 * 60_000)).toBe('1 h 05 min');
    expect(f.formatarDuracao(null)).toBeNull();
    expect(f.nomeModelo('claude-opus-5-5')).toBe('Opus');
    expect(f.nomeModelo('claude-fable-5-1')).toBe('Fable');
    expect(f.nomeModelo('outro')).toBe('outro');
    expect(f.autorPrincipal('condutor')).toBe('Fable');
    expect(f.autorPrincipal('implementador')).toBe('implementador');
    expect(f.textoCiclos(0, 0, { max_auto: 2, max_total: 5 })).toBeNull();
    expect(f.textoCiclos(1, 2, { max_auto: 2, max_total: 5 })).toBe('ciclo 1/2 auto · total 2/5');
    expect(f.duracaoEntre('2026-10-01T10:00:00.000Z', '2026-10-01T10:18:00.000Z')).toBe(
      18 * 60_000,
    );
  });
});
