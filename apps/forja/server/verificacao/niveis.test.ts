import { describe, expect, it } from 'vitest';
import {
  calcularEvidenciaVisual,
  calcularNivelVerificacao,
  casaComando,
  ehComandoDeVerificacao,
} from './niveis';

const rel = (comando: string, exit_code: number | null = 0) => ({
  comando,
  exit_code,
  resumo: '',
});

describe('calcularNivelVerificacao (FJ-032: relatado × stream do T2)', () => {
  it('todo comando relatado visto no stream com exit 0 → verificado_pelo_revisor', () => {
    const n = calcularNivelVerificacao({
      relatados: [rel('npm run build'), rel('npm test')],
      stream: [
        { comando: 'cd /wt && npm run build', resultado: 'exit_0' },
        { comando: 'npm test', resultado: 'exit_0' },
      ],
    });
    expect(n.nivel).toBe('verificado_pelo_revisor');
    expect(n.comandos.map((c) => c.no_stream)).toEqual(['exit_0', 'exit_0']);
  });

  it('relatado mas ausente do stream → declarado (nunca arredonda para cima)', () => {
    const n = calcularNivelVerificacao({
      relatados: [rel('npm run build'), rel('npm run lint')],
      stream: [{ comando: 'npm run build', resultado: 'exit_0' }],
    });
    expect(n.nivel).toBe('declarado');
    expect(n.motivo).toContain('npm run lint');
    expect(n.comandos[1]?.no_stream).toBe('nao_visto');
  });

  it('relatado exit 0 mas o stream mostra erro → declarado (divergente)', () => {
    const n = calcularNivelVerificacao({
      relatados: [rel('npm run build', 0)],
      stream: [{ comando: 'npm run build', resultado: 'erro' }],
    });
    expect(n.nivel).toBe('declarado');
    expect(n.comandos[0]?.no_stream).toBe('erro');
  });

  it('comando vermelho relatado com honestidade → declarado, não verificado verde', () => {
    const n = calcularNivelVerificacao({
      relatados: [rel('npm run build', 1)],
      stream: [{ comando: 'npm run build', resultado: 'erro' }],
    });
    expect(n.nivel).toBe('declarado');
    expect(n.motivo).toContain('vermelhos');
  });

  it('nada relatado → nao_verificado, mesmo com Bash no stream', () => {
    const n = calcularNivelVerificacao({
      relatados: [],
      stream: [{ comando: 'npm run build', resultado: 'exit_0' }],
    });
    expect(n.nivel).toBe('nao_verificado');
  });

  it('tool_use sem tool_result (processo morreu) não confirma', () => {
    const n = calcularNivelVerificacao({
      relatados: [rel('npm run build')],
      stream: [{ comando: 'npm run build', resultado: 'sem_resultado' }],
    });
    expect(n.nivel).toBe('declarado');
  });
});

describe('casaComando / ehComandoDeVerificacao (FJ-032)', () => {
  it('casa igual, contido (cd … &&) e truncado do feed; não casa outro script', () => {
    expect(casaComando('npm run build', 'npm  run build')).toBe(true);
    expect(casaComando('npm run build', 'cd app && npm run build 2>&1 | tail -20')).toBe(true);
    expect(casaComando('npm run test -- --run --reporter=dot', 'npm run test -- --run…')).toBe(
      true,
    );
    expect(casaComando('npm run build', 'npm run lint')).toBe(false);
    expect(casaComando('', 'npm run lint')).toBe(false);
  });

  it('reconhece checks e instalação; ignora inspeção', () => {
    for (const c of [
      'npm run typecheck',
      'npm test',
      'npx tsc --noEmit',
      'pnpm lint',
      'npm ci',
      'cargo test',
      'cd web && npx vitest run',
    ]) {
      expect(ehComandoDeVerificacao(c), c).toBe(true);
    }
    for (const c of ['ls -la', 'cat package.json', 'git diff HEAD~1', 'npm run start']) {
      expect(ehComandoDeVerificacao(c), c).toBe(false);
    }
  });
});

describe('calcularEvidenciaVisual (03 §5.4)', () => {
  it('sem altera_ui → nao_se_aplica', () => {
    expect(calcularEvidenciaVisual({ alteraUi: false, pares: [] }).evidencia_visual).toBe(
      'nao_se_aplica',
    );
  });

  it('todas com par (tela_nova vale como antes) → completa', () => {
    expect(
      calcularEvidenciaVisual({
        alteraUi: true,
        pares: [
          { tela_id: 'UI1', antes: 'ok', depois: 'ok' },
          { tela_id: 'UI2', antes: 'tela_nova', depois: 'ok' },
          { tela_id: 'UI3', antes: 'reaproveitado', depois: 'ok' },
        ],
      }),
    ).toEqual({ evidencia_visual: 'completa', motivo: null });
  });

  it('alguma sem par → parcial com o motivo', () => {
    const c = calcularEvidenciaVisual({
      alteraUi: true,
      pares: [
        { tela_id: 'UI1', antes: 'ok', depois: 'ok' },
        { tela_id: 'UI2', antes: 'ok', depois: 'nao_encontrada' },
      ],
    });
    expect(c.evidencia_visual).toBe('parcial');
    expect(c.motivo).toContain('UI2');
  });

  it('falha geral, login ou nenhuma tela → sem_evidencia_visual', () => {
    expect(
      calcularEvidenciaVisual({ alteraUi: true, pares: [], falhaGeral: 'app_nao_subiu' }),
    ).toEqual({ evidencia_visual: 'sem_evidencia_visual', motivo: 'o app não subiu' });
    expect(calcularEvidenciaVisual({ alteraUi: true, pares: [] }).evidencia_visual).toBe(
      'sem_evidencia_visual',
    );
    expect(
      calcularEvidenciaVisual({
        alteraUi: true,
        pares: [{ tela_id: 'UI1', antes: 'ok', depois: 'login_falhou' }],
      }).evidencia_visual,
    ).toBe('sem_evidencia_visual');
  });
});
