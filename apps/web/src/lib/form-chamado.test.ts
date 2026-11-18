import { describe, it, expect } from 'vitest';
import { Natureza, Prioridade } from '@chamados/shared';
import {
  lerFormNovoChamado,
  parseDocEditor,
  normalizarBusca,
  clienteCasaBusca,
  type OpcaoSolicitante,
} from './form-chamado';

/** "Novo chamado" do painel (D-040): leitura do formulário e filtro do solicitante. */

const CLIENTE = '15737adb-7fc1-4af0-9e7a-19946ab904a2';
const SISTEMA = '0b8f3a52-3c55-4a8e-9a49-5c1f7f0a9d11';
const DOC = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tela em branco.' }] }],
});

function form(campos: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
}

const BASE = { solicitante_id: CLIENTE, titulo: '  Erro no boleto  ', descricao: DOC };

describe('lerFormNovoChamado', () => {
  it('aceita o mínimo e aplica os defaults (Automático → problema; prioridade e alvo ao serviço)', () => {
    const r = lerFormNovoChamado(form({ ...BASE, natureza: '', prioridade: '' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entrada).toEqual({
      titulo: 'Erro no boleto',
      descricao: JSON.parse(DOC),
      natureza: Natureza.problema,
      prioridade: undefined,
      sistema_alvo_id: undefined,
      cliente_id: CLIENTE,
    });
  });

  it('campos ausentes valem como vazios', () => {
    const r = lerFormNovoChamado(form(BASE));
    expect(r.ok && r.entrada.natureza).toBe(Natureza.problema);
  });

  it('respeita a natureza, a prioridade e o sistema escolhidos pela equipe', () => {
    const r = lerFormNovoChamado(
      form({
        ...BASE,
        natureza: Natureza.duvida,
        prioridade: Prioridade.urgente,
        sistema_alvo_id: SISTEMA.toUpperCase(),
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entrada.natureza).toBe(Natureza.duvida);
    expect(r.entrada.prioridade).toBe(Prioridade.urgente);
    expect(r.entrada.sistema_alvo_id).toBe(SISTEMA.toUpperCase());
  });

  it('normaliza o id do solicitante para minúsculas', () => {
    const r = lerFormNovoChamado(form({ ...BASE, solicitante_id: CLIENTE.toUpperCase() }));
    expect(r.ok && r.entrada.cliente_id).toBe(CLIENTE);
  });

  it('exige solicitante e recusa id que não é UUID (não chega ao banco)', () => {
    expect(lerFormNovoChamado(form({ ...BASE, solicitante_id: '' }))).toEqual({
      ok: false,
      erro: 'Selecione o cliente solicitante.',
    });
    expect(lerFormNovoChamado(form({ ...BASE, solicitante_id: "1' OR '1'='1" }))).toEqual({
      ok: false,
      erro: 'Solicitante inválido.',
    });
  });

  it('recusa enum inválido e sistema-alvo malformado', () => {
    expect(lerFormNovoChamado(form({ ...BASE, natureza: 'bug' }))).toEqual({
      ok: false,
      erro: 'Natureza inválida.',
    });
    expect(lerFormNovoChamado(form({ ...BASE, prioridade: 'altissima' }))).toEqual({
      ok: false,
      erro: 'Prioridade inválida.',
    });
    expect(lerFormNovoChamado(form({ ...BASE, sistema_alvo_id: 'portal' }))).toEqual({
      ok: false,
      erro: 'Sistema-alvo inválido.',
    });
  });

  it('exige descrição vinda do editor (JSON de doc)', () => {
    for (const descricao of ['', 'texto solto', '{"type":"paragraph"}', '[]']) {
      expect(lerFormNovoChamado(form({ ...BASE, descricao }))).toEqual({
        ok: false,
        erro: 'Descreva o chamado.',
      });
    }
  });

  it('ignora arquivos no lugar de campos de texto', () => {
    const fd = form(BASE);
    fd.set('solicitante_id', new Blob(['x']), 'x.txt');
    expect(lerFormNovoChamado(fd)).toEqual({ ok: false, erro: 'Selecione o cliente solicitante.' });
  });
});

describe('estimativa de custo na abertura (D-043)', () => {
  it('vazia = sem estimativa (chave ausente)', () => {
    const r = lerFormNovoChamado(form({ ...BASE, estimativa_custo: '' }));
    expect(r.ok && 'estimativa_custo' in r.entrada).toBe(false);
  });

  it('código válido segue para o serviço', () => {
    const r = lerFormNovoChamado(form({ ...BASE, estimativa_custo: 'D' }));
    expect(r.ok && r.entrada.estimativa_custo).toBe('D');
  });

  it('código fora do domínio é recusado cedo', () => {
    const r = lerFormNovoChamado(form({ ...BASE, estimativa_custo: 'Z' }));
    expect(r).toEqual({ ok: false, erro: 'Estimativa de custo inválida.' });
  });
});

describe('parseDocEditor', () => {
  it('só aceita objeto com type = doc', () => {
    expect(parseDocEditor('{"type":"doc"}')).toEqual({ type: 'doc' });
    expect(parseDocEditor('null')).toBeNull();
    expect(parseDocEditor('{')).toBeNull();
  });
});

describe('seletor de solicitante', () => {
  const maria: OpcaoSolicitante = {
    value: CLIENTE,
    label: 'Maria da Conceição Silva',
    email: 'maria@acme.com.br',
  };

  it('normalizarBusca tira acento, caixa e espaço extra', () => {
    expect(normalizarBusca('  CONCEIÇÃO   Silva ')).toBe('conceicao silva');
  });

  it('casa por nome ou e-mail, sem acento e em qualquer ordem', () => {
    expect(clienteCasaBusca(maria, '')).toBe(true);
    expect(clienteCasaBusca(maria, '   ')).toBe(true);
    expect(clienteCasaBusca(maria, 'conceicao')).toBe(true);
    expect(clienteCasaBusca(maria, 'silva maria')).toBe(true);
    expect(clienteCasaBusca(maria, 'ACME.com')).toBe(true);
    expect(clienteCasaBusca(maria, 'maria joão')).toBe(false);
    expect(clienteCasaBusca(maria, 'pedro')).toBe(false);
  });
});
