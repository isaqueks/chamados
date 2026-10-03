import { describe, expect, it } from 'vitest';
import {
  CLASSE_ESTADO_EXECUCAO,
  EstadoExecucao,
  GRUPO_ESTADO_EXECUCAO,
  MotivoFimEtapa,
  contaEmAguardandoVoce,
  estadoAtivo,
  estadoLateral,
  valores,
} from './estados';
import { pertenceAoCanalDaExecucao, pertenceAoCanalGlobal, ehMarco } from './protocolo-eventos';
import type { EventoForja } from './protocolo-eventos';

describe('estados da execução (02 §2.1)', () => {
  it('são exatamente 29 e todos têm classe e grupo visual', () => {
    const todos = valores(EstadoExecucao);
    expect(todos).toHaveLength(29);
    for (const e of todos) {
      expect(CLASSE_ESTADO_EXECUCAO[e]).toBeDefined();
      expect(GRUPO_ESTADO_EXECUCAO[e]).toBeDefined();
    }
  });

  it('terminais = concluido, descartado, cancelado', () => {
    const terminais = valores(EstadoExecucao).filter((e) => !estadoAtivo(e));
    expect(terminais.sort()).toEqual(['cancelado', 'concluido', 'descartado']);
  });

  it('laterais = pausado_usuario, pausado_cota, assumido_manual, interrompido, falhou', () => {
    const laterais = valores(EstadoExecucao).filter(estadoLateral);
    expect(laterais.sort()).toEqual(
      ['assumido_manual', 'falhou', 'interrompido', 'pausado_cota', 'pausado_usuario'].sort(),
    );
  });

  it('"aguardando você" conta gates e atenção, nunca aguardando_deploy (06 §1.2)', () => {
    expect(contaEmAguardandoVoce('aguardando_aprovacao')).toBe(true);
    expect(contaEmAguardandoVoce('precisa_humano')).toBe(true);
    expect(contaEmAguardandoVoce('mergeado_pendente_chamado')).toBe(true);
    expect(contaEmAguardandoVoce('aguardando_deploy')).toBe(false);
    expect(contaEmAguardandoVoce('implementando')).toBe(false);
    expect(contaEmAguardandoVoce('aguardando_cliente_resposta')).toBe(false);
    expect(contaEmAguardandoVoce('aguardando_cliente_resposta', true)).toBe(true);
  });

  it('motivo_fim_etapa = classificação do runner + motivos das etapas do app', () => {
    expect(valores(MotivoFimEtapa)).toContain('comando_vermelho');
    expect(valores(MotivoFimEtapa)).toContain('perfil_divergente');
    expect(valores(MotivoFimEtapa)).toHaveLength(14);
  });
});

describe('canais de eventos (01 §8.1)', () => {
  const base = { seq: 1, em: '2026-10-02T00:00:00.000Z', etapa_id: null, nivel: 'info' as const };
  const estado: EventoForja = {
    ...base,
    execucao_id: 'x',
    tipo: 'execucao.estado',
    resumo: 'estado',
    dados: {
      estado: 'implementando',
      estado_anterior: 'plano_pronto',
      motivo_estado: null,
      numero: 1,
      projeto_id: 'p',
    },
  };
  const leitura: EventoForja = {
    ...base,
    execucao_id: 'x',
    tipo: 'agente.ferramenta',
    resumo: 'leu',
    dados: {
      papel_agente: 'implementador',
      parent_tool_use_id: 't1',
      tool_use_id: 't2',
      ferramenta: 'Read',
      resumo_entrada: 'a.ts',
      subagente: null,
    },
  };

  it('estado vai ao global; ferramenta não', () => {
    expect(pertenceAoCanalGlobal(estado)).toBe(true);
    expect(pertenceAoCanalGlobal(leitura)).toBe(false);
  });

  it('canal da execução filtra por execucao_id', () => {
    expect(pertenceAoCanalDaExecucao(leitura, 'x')).toBe(true);
    expect(pertenceAoCanalDaExecucao(leitura, 'y')).toBe(false);
  });

  it('leitura não é marco; edição é', () => {
    expect(ehMarco(leitura)).toBe(false);
    expect(ehMarco({ ...leitura, dados: { ...leitura.dados, ferramenta: 'Edit' } })).toBe(true);
    expect(ehMarco(estado)).toBe(true);
  });
});
