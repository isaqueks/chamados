import { describe, it, expect } from 'vitest';
import {
  serializarMensagemParaCliente,
  serializarTimelineParaCliente,
  serializarChamadoParaCliente,
  eventoVisivelAoCliente,
  type MensagemInterna,
  type ChamadoInterno,
} from './serializers';
import {
  VisibilidadeMensagem,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  EstimativaCusto,
  TipoEvento,
} from './enums';

function msg(over: Partial<MensagemInterna>): MensagemInterna {
  return {
    id: 'm-1',
    chamado_id: 'c-1',
    autor_id: 'a-1',
    visibilidade: VisibilidadeMensagem.publica,
    corpo_json: { type: 'doc' },
    corpo_html: '<p>oi</p>',
    execucao_ia_id: 'exec-secreta',
    created_at: '2026-07-15T00:00:00Z',
    ...over,
  };
}

describe('serializarMensagemParaCliente — allowlist (specs/03 §7)', () => {
  it('descarta mensagem interna por completo (retorna null)', () => {
    expect(
      serializarMensagemParaCliente(msg({ visibilidade: VisibilidadeMensagem.interna })),
    ).toBeNull();
  });

  it('serializa mensagem pública sem vazar visibilidade nem execucao_ia_id', () => {
    const out = serializarMensagemParaCliente(msg({}));
    expect(out).not.toBeNull();
    expect(out).toEqual({
      id: 'm-1',
      autor_id: 'a-1',
      corpo_json: { type: 'doc' },
      corpo_html: '<p>oi</p>',
      created_at: '2026-07-15T00:00:00Z',
    });
    expect(out as object).not.toHaveProperty('execucao_ia_id');
    expect(out as object).not.toHaveProperty('visibilidade');
  });
});

describe('serializarTimelineParaCliente', () => {
  it('remove as notas internas da timeline', () => {
    const timeline = [
      msg({ id: 'm-pub-1', visibilidade: VisibilidadeMensagem.publica }),
      msg({ id: 'm-int', visibilidade: VisibilidadeMensagem.interna }),
      msg({ id: 'm-pub-2', visibilidade: VisibilidadeMensagem.publica }),
    ];
    const out = serializarTimelineParaCliente(timeline);
    expect(out.map((m) => m.id)).toEqual(['m-pub-1', 'm-pub-2']);
  });
});

describe('eventos de custo (D-043) são visíveis ao cliente', () => {
  it('estimativa_custo_alterada e custo_final_definido não são internos', () => {
    expect(eventoVisivelAoCliente(TipoEvento.estimativa_custo_alterada)).toBe(true);
    expect(eventoVisivelAoCliente(TipoEvento.custo_final_definido)).toBe(true);
    expect(eventoVisivelAoCliente(TipoEvento.complexidade_alterada)).toBe(false);
  });
});

describe('serializarChamadoParaCliente — exclui complexidade e atribuição', () => {
  const completo: ChamadoInterno = {
    id: 'c-1',
    numero: 1042,
    tenant_id: 't-1',
    sistema_alvo_id: 's-1',
    categoria_id: null,
    cliente_id: 'cli-1',
    operador_id: 'op-secreto',
    titulo: '2ª via boleto',
    descricao_json: { type: 'doc' },
    descricao_html: '<p>x</p>',
    status: StatusChamado.em_atendimento,
    natureza: Natureza.problema,
    prioridade: Prioridade.alta,
    complexidade: Complexidade.facil,
    ia_silenciada: true,
    resolvido_em: null,
    fechar_automaticamente_em: null,
    fechado_em: null,
    reaberto_count: 0,
    created_at: '2026-07-15T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
  };

  it('não expõe complexidade nem operador_id (bastidor interno)', () => {
    const out = serializarChamadoParaCliente(completo);
    expect(out as object).not.toHaveProperty('complexidade');
    expect(out as object).not.toHaveProperty('operador_id');
    expect(out as object).not.toHaveProperty('tenant_id');
    // D-024: o silêncio da IA é gestão interna do atendimento — o cliente não vê.
    expect(out as object).not.toHaveProperty('ia_silenciada');
  });

  it('expõe fechar_automaticamente_em (acompanhamento do prazo de auto-fechamento)', () => {
    const out = serializarChamadoParaCliente({
      ...completo,
      fechar_automaticamente_em: '2026-07-20T00:00:00Z',
    });
    expect(out.fechar_automaticamente_em).toBe('2026-07-20T00:00:00Z');
    expect(serializarChamadoParaCliente(completo).fechar_automaticamente_em).toBeNull();
  });

  it('D-037: a projeção é a MESMA allowlist para chamado alheio do tenant (chaves exatas)', () => {
    // O serializer não depende de ownership: um cliente lendo o chamado de outro
    // solicitante do tenant recebe exatamente estas chaves — nada interno.
    const alheio = serializarChamadoParaCliente({ ...completo, cliente_id: 'cli-outro' });
    expect(Object.keys(alheio).sort()).toEqual(
      [
        'id',
        'numero',
        'sistema_alvo_id',
        'categoria_id',
        'cliente_id',
        'titulo',
        'descricao_json',
        'descricao_html',
        'status',
        'natureza',
        'prioridade',
        'estimativa_custo',
        'custo_final',
        'resolvido_em',
        'fechar_automaticamente_em',
        'fechado_em',
        'reaberto_count',
        'created_at',
        'updated_at',
      ].sort(),
    );
    expect(alheio.cliente_id).toBe('cli-outro');
  });

  it('D-043: estimativa de custo e custo final são PÚBLICOS; complexidade continua interna', () => {
    const out = serializarChamadoParaCliente({
      ...completo,
      estimativa_custo: EstimativaCusto.B,
      custo_final: 150.5,
    });
    expect(out.estimativa_custo).toBe(EstimativaCusto.B);
    expect(out.custo_final).toBe(150.5);
    expect(out as object).not.toHaveProperty('complexidade');
  });

  it('D-043: sem estimativa/custo, os campos saem como null (nunca ausentes)', () => {
    const out = serializarChamadoParaCliente(completo);
    expect(out.estimativa_custo).toBeNull();
    expect(out.custo_final).toBeNull();
  });

  it('expõe status/natureza/prioridade e dados próprios (acompanhamento RF-04)', () => {
    const out = serializarChamadoParaCliente(completo);
    expect(out.status).toBe(StatusChamado.em_atendimento);
    expect(out.natureza).toBe(Natureza.problema);
    expect(out.prioridade).toBe(Prioridade.alta);
    expect(out.numero).toBe(1042);
    expect(out.titulo).toBe('2ª via boleto');
  });
});
