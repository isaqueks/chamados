import { describe, it, expect } from 'vitest';
import {
  montarEmailChamado,
  montarEmailAlertaWebhook,
  montarEmailTransacional,
  montarPayloadWebhook,
  estimativaParaPayload,
  type DadosEmailChamado,
} from './templates';

/**
 * Janela de aprovação do cliente (D-042): textos de e-mail e payload do webhook
 * (`aprovado` tácito × explícito, `contestado`). Sem conteúdo interno.
 */
const base: Omit<DadosEmailChamado, 'evento'> = {
  tenantNome: 'Acme',
  emitidoEm: new Date('2026-11-25T12:00:00Z'),
  numero: '42',
  titulo: 'Erro ao emitir nota',
  status: 'resolvido',
  prioridade: 'media',
  link: 'https://acme.exemplo/portal/chamados/x',
};

const chamado = {
  id: 'c-1',
  numero: '42',
  titulo: 'Erro ao emitir nota',
  status: 'fechado',
  prioridade: 'media',
  natureza: 'problema',
  sistema_alvo: null,
  categoria: null,
  estimativa_custo: null,
  custo_final: null,
};

describe('e-mail de resolvido informa o prazo e a aprovação tácita (D-042)', () => {
  it('para o cliente: prazo + "sem resposta, será considerado aprovado"', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'resolvido',
      paraCliente: true,
      prazoAprovacao: '24 de novembro de 2026 às 14:03',
    });
    expect(e.texto).toContain('Você tem até 24 de novembro de 2026 às 14:03');
    expect(e.texto).toContain('aprovar ou contestar');
    expect(e.texto).toContain('será considerado aprovado');
    expect(e.html).toContain('será considerado aprovado');
    expect(e.assunto).toContain('aprove ou conteste');
  });

  it('para a equipe: fala do cliente na 3ª pessoa', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'resolvido',
      paraCliente: false,
      prazoAprovacao: '24 de novembro de 2026 às 14:03',
    });
    expect(e.texto).toContain('O cliente tem até 24 de novembro de 2026 às 14:03');
    expect(e.texto).not.toContain('Você tem');
  });

  it('sem prazo gravado não quebra o texto', () => {
    const e = montarEmailChamado({ ...base, evento: 'resolvido', paraCliente: true });
    expect(e.texto).toContain('Você tem um prazo para aprovar ou contestar');
  });
});

describe('e-mails de aprovado/contestado (D-042)', () => {
  it('aprovação tácita para o cliente explica o encerramento por falta de resposta', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'aprovado',
      aprovacao: 'tacita',
      paraCliente: true,
    });
    expect(e.texto).toContain('terminou sem resposta');
    expect(e.texto).toContain('considerado aprovado');
  });

  it('aprovação explícita para a equipe cita o cliente', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'aprovado',
      aprovacao: 'explicita',
      paraCliente: false,
      autorNome: 'Maria Silva',
    });
    expect(e.texto).toContain('Maria Silva aprovou a solução do chamado #42');
  });

  it('contestação traz o motivo (escapado no HTML)', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'contestado',
      paraCliente: false,
      autorNome: 'Maria',
      trechoPublico: 'Continua <falhando>',
    });
    expect(e.texto).toContain('Maria contestou a solução do chamado #42');
    expect(e.texto).toContain('"Continua <falhando>"');
    expect(e.html).toContain('Continua &lt;falhando&gt;');
  });
});

describe('payload do webhook (D-042)', () => {
  const comum = {
    eventoId: 'ev-1',
    eventoTs: '2026-11-24T12:00:00.000Z',
    chamado,
    link: 'https://acme.exemplo/portal/chamados/c-1',
    de: 'resolvido',
    para: 'fechado',
  };

  it('aprovado tácito: forma tacita, sem autor, com mudança', () => {
    const p = montarPayloadWebhook({
      ...comum,
      webhookTipo: 'aprovado',
      incluiMensagem: false,
      incluiAutor: true,
      incluiMudanca: true,
      aprovacao: 'tacita',
      autorNome: null,
    });
    expect(p.evento.tipo).toBe('aprovado');
    expect(p.aprovacao).toEqual({ forma: 'tacita' });
    expect(p.autor).toBeNull();
    expect(p.mudanca).toEqual({ de: 'resolvido', para: 'fechado' });
    expect(p.mensagem).toBeNull();
  });

  it('aprovado explícito: forma explicita + autor', () => {
    const p = montarPayloadWebhook({
      ...comum,
      webhookTipo: 'aprovado',
      incluiMensagem: false,
      incluiAutor: true,
      incluiMudanca: true,
      aprovacao: 'explicita',
      autorNome: 'Maria Silva',
    });
    expect(p.aprovacao).toEqual({ forma: 'explicita' });
    expect(p.autor).toEqual({ nome: 'Maria Silva' });
  });

  it('contestado: autor + trecho do motivo + mudança; sem `aprovacao`', () => {
    const p = montarPayloadWebhook({
      ...comum,
      para: 'em_atendimento',
      webhookTipo: 'contestado',
      incluiMensagem: true,
      incluiAutor: true,
      incluiMudanca: true,
      autorNome: 'Maria',
      trechoPublico: 'Continua falhando',
      aprovacao: null,
    });
    expect(p.autor).toEqual({ nome: 'Maria' });
    expect(p.mensagem).toEqual({ trecho: 'Continua falhando' });
    expect(p.mudanca).toEqual({ de: 'resolvido', para: 'em_atendimento' });
    expect(p.aprovacao).toBeNull();
  });

  it('`aprovacao` nunca aparece fora do tipo aprovado', () => {
    const p = montarPayloadWebhook({
      ...comum,
      webhookTipo: 'fechado',
      incluiMensagem: false,
      incluiMudanca: false,
      aprovacao: 'tacita',
    });
    expect(p.aprovacao).toBeNull();
  });

  it('payload só carrega as chaves públicas documentadas', () => {
    const p = montarPayloadWebhook({
      ...comum,
      webhookTipo: 'aprovado',
      incluiMensagem: false,
      incluiAutor: true,
      incluiMudanca: true,
      aprovacao: 'tacita',
    });
    expect(Object.keys(p).sort()).toEqual(
      ['aprovacao', 'autor', 'chamado', 'evento', 'linkChamado', 'mensagem', 'mudanca'].sort(),
    );
    expect(Object.keys(p.chamado).sort()).toEqual(
      [
        'categoria',
        // D-043: estimativa e custo final são públicos e SEMPRE presentes.
        'custo_final',
        'estimativa_custo',
        'id',
        'natureza',
        'numero',
        'prioridade',
        'sistema_alvo',
        'status',
        'titulo',
      ].sort(),
    );
  });
});

/** Estimativa de custo e custo final (D-043): e-mail e webhook. */
describe('custo no e-mail (D-043)', () => {
  it('resolvido mostra o custo final junto do pedido de aprovação', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'resolvido',
      paraCliente: true,
      prazoAprovacao: '24 de novembro de 2026 às 14:03',
      custoFinal: 1234.5,
    });
    expect(e.texto).toContain('Custo final: R$ 1.234,50');
    // HTML: o custo final vira a linha de destaque (estilo "Total" — D-047).
    expect(e.html).toContain('Custo final');
    expect(e.html).toContain('R$ 1.234,50');
    expect(e.html).toContain('Prazo para aprovar');
    expect(e.texto).toContain('aprovar ou contestar');
  });

  it('resolvido sem custo não menciona custo final', () => {
    const e = montarEmailChamado({ ...base, evento: 'resolvido', paraCliente: true });
    expect(e.texto).not.toContain('Custo final');
  });

  it('estimativa definida e removida', () => {
    const def = montarEmailChamado({
      ...base,
      evento: 'estimativa_custo',
      para: 'B',
      estimativaCusto: 'B',
    });
    expect(def.assunto).toContain('B · R$ 100 a R$ 200');
    expect(def.texto).toContain('Estimativa de custo: B · R$ 100 a R$ 200');
    const rem = montarEmailChamado({ ...base, evento: 'estimativa_custo', para: null });
    expect(rem.assunto).toContain('removida');
  });

  it('custo final corrigido', () => {
    const e = montarEmailChamado({ ...base, evento: 'custo_final', custoFinal: 150 });
    expect(e.assunto).toBe('Chamado #42: custo final R$ 150,00');
  });
});

describe('custo no payload do webhook (D-043)', () => {
  it('estimativaParaPayload: código + rótulo + faixa; desconhecido/ausente → null', () => {
    expect(estimativaParaPayload('C')).toEqual({
      codigo: 'C',
      rotulo: 'C · R$ 200 a R$ 400',
      min: 200,
      max: 400,
    });
    expect(estimativaParaPayload('E')).toMatchObject({ max: null });
    expect(estimativaParaPayload('I')).toMatchObject({ rotulo: 'Isento (R$ 0)', min: 0, max: 0 });
    expect(estimativaParaPayload(null)).toBeNull();
    expect(estimativaParaPayload('Z')).toBeNull();
  });

  it('estimativa_custo_alterada leva mudanca com os códigos e o chamado com o campo', () => {
    const p = montarPayloadWebhook({
      webhookTipo: 'estimativa_custo_alterada',
      eventoId: 'ev-1',
      eventoTs: '2026-11-17T12:00:00.000Z',
      chamado: { ...chamado, estimativa_custo: estimativaParaPayload('B') },
      de: 'A',
      para: 'B',
      link: 'https://x',
      incluiMensagem: false,
      incluiMudanca: true,
    });
    expect(p.evento.tipo).toBe('estimativa_custo_alterada');
    expect(p.mudanca).toEqual({ de: 'A', para: 'B' });
    expect(p.chamado.estimativa_custo?.codigo).toBe('B');
    expect(p.chamado.custo_final).toBeNull();
    expect(p.autor).toBeNull();
  });

  it('custo_final_definido leva mudanca NUMÉRICA (BRL)', () => {
    const p = montarPayloadWebhook({
      webhookTipo: 'custo_final_definido',
      eventoId: 'ev-2',
      eventoTs: '2026-11-17T12:00:00.000Z',
      chamado: { ...chamado, status: 'resolvido', custo_final: 180 },
      de: 150,
      para: 180,
      link: 'https://x',
      incluiMensagem: false,
      incluiMudanca: true,
    });
    expect(p.mudanca).toEqual({ de: 150, para: 180 });
    expect(p.chamado.custo_final).toBe(180);
  });

  it('resolvido carrega o custo final no objeto chamado (sem mudanca de custo)', () => {
    const p = montarPayloadWebhook({
      webhookTipo: 'resolvido',
      eventoId: 'ev-3',
      eventoTs: '2026-11-17T12:00:00.000Z',
      chamado: { ...chamado, status: 'resolvido', custo_final: 99.9 },
      link: 'https://x',
      incluiMensagem: false,
      incluiMudanca: false,
    });
    expect(p.chamado.custo_final).toBe(99.9);
    expect(p.mudanca).toBeNull();
  });
});

/** Layout único dos e-mails (D-047): logo inline, cabeçalho, rodapé do emitente. */
describe('layout dos e-mails (D-047)', () => {
  it('chamado: logo por cid anexado inline, título, metadados e rodapé', () => {
    const e = montarEmailChamado({ ...base, evento: 'chamado_criado', status: 'novo' });
    expect(e.html).toContain('src="cid:logo@chamados"');
    expect(e.imagensInline).toHaveLength(1);
    expect(e.imagensInline[0]).toMatchObject({ cid: 'logo@chamados', contentType: 'image/png' });
    expect(e.imagensInline[0]!.conteudo.subarray(1, 4).toString()).toBe('PNG');
    expect(e.html).toContain('Chamado recebido');
    expect(e.html).toContain('#42');
    expect(e.html).toContain('25/11/2026');
    expect(e.html).toContain('CNPJ 51.943.042/0001-05');
    expect(e.html).toContain('acompanha chamados em Acme');
    expect(e.texto).toContain('CNPJ 51.943.042/0001-05');
    // Sem cor do tenant: a régua e o botão usam o marinho fixo.
    expect(e.html).toContain('#0b4189');
    expect(e.html).not.toContain('#2563eb');
  });

  it('escapa título, nome do tenant e trecho no HTML', () => {
    const e = montarEmailChamado({
      ...base,
      tenantNome: 'A<b>',
      titulo: '<script>x</script>',
      evento: 'mensagem_publica',
      autorNome: 'Eve <img>',
      trechoPublico: '<a href="javascript:1">oi</a>',
    });
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('<img>');
    expect(e.html).not.toContain('href="javascript');
    expect(e.html).toContain('&lt;script&gt;');
    expect(e.html).toContain('A&lt;b&gt;');
  });

  it('mensagem pública para o cliente: seção da mensagem e botão de responder', () => {
    const e = montarEmailChamado({
      ...base,
      evento: 'mensagem_publica',
      paraCliente: true,
      trechoPublico: 'Pode testar?',
    });
    expect(e.html).toContain('Mensagem');
    expect(e.html).toContain('Pode testar?');
    expect(e.html).toContain('Responder no portal');
  });

  it('estimativa: destaque com a faixa; isento sem código', () => {
    const b = montarEmailChamado({
      ...base,
      evento: 'estimativa_custo',
      para: 'B',
      estimativaCusto: 'B',
    });
    expect(b.html).toContain('R$ 100 a R$ 200');
    const i = montarEmailChamado({
      ...base,
      evento: 'estimativa_custo',
      para: 'I',
      estimativaCusto: 'I',
    });
    expect(i.html).toContain('Isento (R$ 0)');
  });

  it('transacional e alerta usam o mesmo layout, com logo inline', () => {
    const c = montarEmailTransacional({
      tenantNome: 'Acme',
      tipo: 'convite',
      url: 'https://x/c?t=1&a=2',
    });
    expect(c.html).toContain('Convite de acesso');
    expect(c.html).toContain('https://x/c?t=1&amp;a=2');
    expect(c.imagensInline).toHaveLength(1);
    const a = montarEmailAlertaWebhook({
      tenantNome: 'Acme',
      motivo: 'HTTP <503>',
      linkConfig: 'https://x',
    });
    expect(a.html).toContain('Webhook desativado');
    expect(a.html).toContain('HTTP &lt;503&gt;');
    expect(a.imagensInline).toHaveLength(1);
  });
});
