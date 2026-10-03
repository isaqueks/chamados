import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  abrirGravadoresEtapa,
  caminhoEventosBrutos,
  dirEtapa,
  GravadorEventosBrutos,
} from './gravador-bruto';
import { MARCA_REDIGIDO, Redator } from './normalizador';

const dados = mkdtempSync(join(tmpdir(), 'forja-bruto-'));
afterAll(() => rmSync(dados, { recursive: true, force: true }));

describe('gravador do bruto (02 §7: etapas/<n>/eventos.jsonl)', () => {
  it('layout do caminho e recusa de id com barra', () => {
    expect(caminhoEventosBrutos('/d', 'abc-123', 4)).toBe(
      '/d/execucoes/abc-123/etapas/4/eventos.jsonl',
    );
    expect(() => dirEtapa('/d', '../x', 1)).toThrow();
    expect(() => dirEtapa('/d', 'x', -1)).toThrow();
  });

  it('numera as linhas (linha_bruta), redige e cria com 0600/0700', () => {
    const g = abrirGravadoresEtapa(dados, 'exec-1', 1, new Redator(['segredo-do-env']));
    expect(g.eventos.gravarLinha('{"type":"system"}')).toBe(1);
    expect(g.eventos.gravarLinha('{"t":"segredo-do-env"}\n')).toBe(2);
    expect(g.eventos.gravarLinha('lixo\ncom quebra')).toBe(3);
    g.stderr.gravar('aviso segredo-do-env\n');
    g.fechar();
    const caminho = caminhoEventosBrutos(dados, 'exec-1', 1);
    expect(readFileSync(caminho, 'utf8')).toBe(
      `{"type":"system"}\n{"t":"${MARCA_REDIGIDO}"}\nlixo\\ncom quebra\n`,
    );
    expect(readFileSync(join(dirEtapa(dados, 'exec-1', 1), 'stderr.log'), 'utf8')).toBe(
      `aviso ${MARCA_REDIGIDO}\n`,
    );
    expect(statSync(caminho).mode & 0o777).toBe(0o600);
    expect(statSync(dirEtapa(dados, 'exec-1', 1)).mode & 0o777).toBe(0o700);
  });

  it('reabrir continua a numeração; linha final sem \\n (crash) conta e é fechada', () => {
    const caminho = caminhoEventosBrutos(dados, 'exec-2', 3);
    const a = new GravadorEventosBrutos(caminho);
    a.gravarLinha('1');
    a.gravarLinha('2');
    a.fechar();
    appendFileSync(caminho, '{"meia":'); // crash no meio do write
    const b = new GravadorEventosBrutos(caminho);
    expect(b.totalLinhas).toBe(3);
    expect(b.gravarLinha('4')).toBe(4);
    b.fechar();
    expect(readFileSync(caminho, 'utf8').split('\n')).toEqual(['1', '2', '{"meia":', '4', '']);
    expect(() => b.gravarLinha('x')).toThrow(/fechado/);
  });
});
