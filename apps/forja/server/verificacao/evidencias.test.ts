import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caminhoContido, coletarEvidencias, dimensoesPng, motivoGeralDoMotivo } from './evidencias';

/**
 * Coleta das evidências que o AGENTE produziu (FJ-030 §3): nenhum navegador
 * abre aqui — os PNGs são cabeçalhos válidos escritos à mão e o `mtime` é
 * ajustado para simular "antes do primeiro checkpoint".
 */

function pngFalso(largura: number, altura: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(largura, 16);
  b.writeUInt32BE(altura, 20);
  return b;
}

let dirExec: string;
const CHECKPOINT = new Date('2026-10-03T12:00:00Z');
const ANTES_DO_CP = new Date('2026-10-03T11:50:00Z');
const DEPOIS_DO_CP = new Date('2026-10-03T12:30:00Z');

function png(rel: string, quando: Date, conteudo: Buffer = pngFalso(1366, 900)): void {
  const abs = join(dirExec, 'evidencias', rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, conteudo);
  utimesSync(abs, quando, quando);
}

function telas(valor: unknown): void {
  mkdirSync(join(dirExec, 'evidencias'), { recursive: true });
  writeFileSync(join(dirExec, 'evidencias', 'telas.json'), JSON.stringify(valor));
}

beforeEach(() => {
  dirExec = mkdtempSync(join(tmpdir(), 'forja-evid-'));
});
afterEach(() => rmSync(dirExec, { recursive: true, force: true }));

describe('coletarEvidencias (FJ-030 §3)', () => {
  it('par antes/depois válido → completa, com sha256 e dimensões', async () => {
    png('antes/UI1.png', ANTES_DO_CP);
    png('depois/UI1.png', DEPOIS_DO_CP, pngFalso(1366, 1200));
    telas([
      {
        id: 'UI1',
        descricao: 'Cadastro',
        rota: '/clientes/novo',
        antes: 'antes/UI1.png',
        depois: 'depois/UI1.png',
      },
    ]);
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.evidencia_visual).toBe('completa');
    expect(r.motivo).toBeNull();
    const t = r.telas[0]!;
    expect(t.antes).toMatchObject({
      caminho: 'evidencias/antes/UI1.png',
      largura: 1366,
      altura: 900,
    });
    expect(t.depois?.altura).toBe(1200);
    expect(t.antes?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.resultado_antes).toBe('ok');
    expect(t.antes_suspeito).toBe(false);
  });

  it('tela nova: sem antes com motivo conta como par', async () => {
    png('depois/UI2.png', DEPOIS_DO_CP);
    telas([{ id: 'UI2', antes: null, depois: 'depois/UI2.png', motivo_sem_antes: 'tela nova' }]);
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.evidencia_visual).toBe('completa');
    expect(r.telas[0]?.resultado_antes).toBe('tela_nova');
  });

  it('antes com mtime depois do primeiro checkpoint → antes_suspeito e parcial', async () => {
    png('antes/UI1.png', DEPOIS_DO_CP);
    png('depois/UI1.png', DEPOIS_DO_CP);
    telas([{ id: 'UI1', antes: 'antes/UI1.png', depois: 'depois/UI1.png' }]);
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.telas[0]?.antes_suspeito).toBe(true);
    expect(r.evidencia_visual).toBe('parcial');
    expect(r.motivo).toMatch(/UI1: antes tirado depois do primeiro checkpoint/);
    // Sem checkpoint ainda, não há o que provar.
    expect((await coletarEvidencias(dirExec, null)).evidencia_visual).toBe('completa');
  });

  it('telas.json ausente, inválido ou fora do formato → sem_evidencia_visual com motivo', async () => {
    let r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r).toMatchObject({ existe: false, evidencia_visual: 'sem_evidencia_visual' });
    expect(r.motivo).toMatch(/telas.json ausente/);

    mkdirSync(join(dirExec, 'evidencias'), { recursive: true });
    writeFileSync(join(dirExec, 'evidencias', 'telas.json'), '{ quebrado');
    r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.motivo).toMatch(/inválido/);

    // Tolerância (2026-10-03): id fora do padrão é normalizado e o caminho ruim
    // vira problema DA TELA, nunca rejeição do arquivo inteiro.
    telas([{ id: '../x', depois: 'a.png' }]);
    r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.motivo).not.toMatch(/fora do formato/);
    expect(r.evidencia_visual).toBe('sem_evidencia_visual');
  });

  it('motivo_geral honesto do agente vira sem_evidencia_visual com o texto dele', async () => {
    telas({ telas: [], motivo_geral: 'o app exige SSO corporativo; não há usuário de dev' });
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.evidencia_visual).toBe('sem_evidencia_visual');
    expect(r.motivo).toBe(
      'o agente não conseguiu fotografar: o app exige SSO corporativo; não há usuário de dev',
    );
  });

  it('recusa caminho fora de evidencias/, symlink, vazio e não-PNG', async () => {
    writeFileSync(join(dirExec, 'segredo.png'), pngFalso(10, 10));
    png('depois/vazio.png', DEPOIS_DO_CP, Buffer.alloc(0));
    png('depois/texto.png', DEPOIS_DO_CP, Buffer.from('não sou png'));
    mkdirSync(join(dirExec, 'evidencias', 'depois'), { recursive: true });
    symlinkSync(join(dirExec, 'segredo.png'), join(dirExec, 'evidencias', 'depois', 'link.png'));
    png('depois/ok.png', DEPOIS_DO_CP);
    png('antes/ok.png', ANTES_DO_CP);
    telas([
      { id: 'UI1', antes: '../segredo.png', depois: 'depois/ok.png' },
      { id: 'UI2', antes: 'antes/ok.png', depois: 'depois/vazio.png' },
      { id: 'UI3', antes: 'antes/ok.png', depois: 'depois/texto.png' },
      { id: 'UI4', antes: 'antes/ok.png', depois: 'depois/link.png' },
      { id: 'UI5', antes: '/etc/passwd', depois: 'depois/ok.png' },
    ]);
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    const p = (id: string) => r.telas.find((t) => t.tela_id === id)?.problemas.join(' ');
    expect(p('UI1')).toMatch(/fora de evidencias/);
    expect(p('UI2')).toMatch(/vazio/);
    expect(p('UI3')).toMatch(/não é PNG/);
    expect(p('UI4')).toMatch(/não é arquivo regular/);
    expect(p('UI5')).toMatch(/fora de evidencias/);
    expect(r.evidencia_visual).toBe('parcial');
  });

  it('sem nenhum depois válido → sem_evidencia_visual', async () => {
    png('antes/UI1.png', ANTES_DO_CP);
    telas([{ id: 'UI1', antes: 'antes/UI1.png', depois: null }]);
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(r.evidencia_visual).toBe('sem_evidencia_visual');
    expect(r.motivo).toMatch(/UI1: sem depois/);
  });
});

describe('coletarEvidencias — nao_se_aplica (FJ-031)', () => {
  it('declarado sem UI no diff → nao_se_aplica; com UI no diff → sem_evidencia_visual contestado', async () => {
    mkdirSync(join(dirExec, 'evidencias'), { recursive: true });
    writeFileSync(join(dirExec, 'evidencias', 'telas.json'), '{ "nao_se_aplica": true }');
    const ok = await coletarEvidencias(dirExec, CHECKPOINT, { ligado: false, arquivos: [] });
    expect(ok).toMatchObject({
      nao_se_aplica: true,
      evidencia_visual: 'nao_se_aplica',
      motivo: null,
    });
    expect((await coletarEvidencias(dirExec, CHECKPOINT)).evidencia_visual).toBe('nao_se_aplica');
    const contestado = await coletarEvidencias(dirExec, CHECKPOINT, {
      ligado: true,
      arquivos: ['web/a.tsx', 'web/b.tsx', 'web/c.tsx', 'web/d.tsx', 'web/e.tsx', 'web/f.tsx'],
    });
    expect(contestado).toMatchObject({
      nao_se_aplica: true,
      evidencia_visual: 'sem_evidencia_visual',
      motivo:
        'o agente declarou não alterar UI, mas o diff toca web/a.tsx, web/b.tsx, web/c.tsx, web/d.tsx, web/e.tsx e mais 1',
    });
    const soPlano = await coletarEvidencias(dirExec, CHECKPOINT, { ligado: true, arquivos: [] });
    expect(soPlano.motivo).toMatch(/^o agente declarou não alterar UI, mas a mudança foi marcada/);
  });
});

describe('apoio', () => {
  it('caminhoContido só aceita relativos dentro do diretório', () => {
    expect(caminhoContido('/d/ev', 'antes/a.png')).toBe('/d/ev/antes/a.png');
    expect(caminhoContido('/d/ev', 'antes/../../x')).toBeNull();
    expect(caminhoContido('/d/ev', '/abs.png')).toBeNull();
    expect(caminhoContido('/d/ev', '')).toBeNull();
  });

  it('dimensoesPng lê o IHDR e recusa o que não é PNG', () => {
    expect(dimensoesPng(pngFalso(800, 600))).toEqual({ largura: 800, altura: 600 });
    expect(dimensoesPng(Buffer.from('GIF89a'))).toBeNull();
  });

  it('motivoGeralDoMotivo devolve o motivo_geral do agente e só ele (aba Evidências)', async () => {
    telas({ telas: [], motivo_geral: 'app exige VPN' });
    const r = await coletarEvidencias(dirExec, CHECKPOINT);
    expect(motivoGeralDoMotivo(r.motivo)).toBe('app exige VPN');
    expect(motivoGeralDoMotivo('nenhuma tela registrada em telas.json')).toBeNull();
    expect(motivoGeralDoMotivo(null)).toBeNull();
  });
});
