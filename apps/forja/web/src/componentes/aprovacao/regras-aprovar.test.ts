import { describe, expect, it } from 'vitest';
import type { AvisoAprovacaoDto, DiffArquivoDto } from '@comum/dto';
import { avisosDoBotao, ordenarArquivosDiff, patchCurto, proximoIndice } from './regras-aprovar';
import {
  explicarViolacoes,
  marcarTrechos,
  urlsNoTexto,
  validarLocalmente,
} from './validacao-resposta';

describe('botão Aprovar e mergear sem exigências (FJ-034, 06 §4.3)', () => {
  const avisos: AvisoAprovacaoDto[] = [
    { tipo: 'mensagem_nova_cliente', mensagem: 'O cliente escreveu.' },
    { tipo: 'sem_prints', mensagem: 'Prints incompletos.' },
    { tipo: 'patch', mensagem: 'patch 4f9a1c (versão 2)' },
  ];

  it('os avisos do servidor viram linhas; o patch curto é só informativo', () => {
    const linhas = avisosDoBotao({ avisos }, { violada: false, publicarMesmoAssim: false });
    expect(linhas.map((l) => [l.tipo, l.informativo])).toEqual([
      ['mensagem_nova_cliente', false],
      ['sem_prints', false],
      ['patch', true],
    ]);
  });

  it('resposta editada com violação vira aviso no topo, até marcar "publicar mesmo assim"', () => {
    expect(avisosDoBotao({ avisos }, { violada: true, publicarMesmoAssim: false })[0]?.tipo).toBe(
      'resposta_violada',
    );
    expect(
      avisosDoBotao({ avisos }, { violada: true, publicarMesmoAssim: true }).some(
        (l) => l.tipo === 'resposta_violada',
      ),
    ).toBe(false);
  });

  it('sem avisos do servidor e resposta válida: nenhuma linha (nada a cumprir)', () => {
    expect(avisosDoBotao({ avisos: [] }, { violada: false, publicarMesmoAssim: false })).toEqual(
      [],
    );
  });
});

describe('diff e patch-id', () => {
  const arq = (caminho: string, selos: DiffArquivoDto['selos']): DiffArquivoDto => ({
    caminho,
    caminho_anterior: null,
    status: 'M',
    adicoes: 1,
    remocoes: 0,
    selos,
    binario: false,
    patch: '',
  });

  it('arquivos com selo primeiro (sensível → banco → regra → interface)', () => {
    const ordem = ordenarArquivosDiff([
      arq('z.ts', []),
      arq('ui.tsx', ['frontend']),
      arq('regra.ts', ['regra_negocio']),
      arq('.env.exemplo', ['sensivel']),
      arq('a.ts', []),
      arq('mig.ts', ['banco', 'regra_negocio']),
    ]).map((a) => a.caminho);
    expect(ordem).toEqual(['.env.exemplo', 'mig.ts', 'regra.ts', 'ui.tsx', 'a.ts', 'z.ts']);
  });

  it('navegação n/p não dá a volta', () => {
    expect(proximoIndice(0, 3, -1)).toBe(0);
    expect(proximoIndice(2, 3, 1)).toBe(2);
    expect(proximoIndice(1, 3, 1)).toBe(2);
    expect(proximoIndice(0, 0, 1)).toBe(0);
  });

  it('patch-id curto (informativo) tem 6 caracteres', () => {
    expect(patchCurto('4f9a1c77ee')).toBe('4f9a1c');
    expect(patchCurto(null)).toBe('—');
  });
});

describe('validação da resposta ao cliente', () => {
  it('prévia local usa os detectores compartilhados', () => {
    expect(validarLocalmente('Olá! A correção será publicada em breve.').ok).toBe(true);
    const v = validarLocalmente('Corrigimos o arquivo src/servicos/boleto.ts.');
    expect(v.ok).toBe(false);
    expect(v.tecnico.length).toBeGreaterThan(0);
    expect(v.promessa.length).toBeGreaterThan(0);
    expect(explicarViolacoes(v).map((x) => x.categoria)).toContain('promessa');
  });

  it('sublinha trechos literais sem diferenciar maiúsculas e ignora rótulos genéricos', () => {
    expect(marcarTrechos('Já está Disponível hoje', ['disponível', 'sql'])).toEqual([
      { texto: 'Já está ', marcado: false },
      { texto: 'Disponível', marcado: true },
      { texto: ' hoje', marcado: false },
    ]);
    expect(marcarTrechos('abc', [])).toEqual([{ texto: 'abc', marcado: false }]);
    expect(marcarTrechos('', ['x'])).toEqual([]);
  });

  it('extrai URLs para destaque (05 §6.4)', () => {
    expect(urlsNoTexto('veja https://exemplo.com/a e http://x.io.')).toEqual([
      'https://exemplo.com/a',
      'http://x.io',
    ]);
  });
});
