import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `forja-print` (FJ-030 §3) como o agente o usa: um processo `node`. Só os
 * caminhos que não abrem navegador (uso, URL, saída); a captura real é coberta
 * pelo spike S10 e pelo Diagnóstico ("Prints pelos agentes").
 */
const SCRIPT = fileURLToPath(new URL('./forja-print.mjs', import.meta.url));

function rodar(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 });
  return { codigo: r.status, erro: r.stderr.trim() };
}

describe('forja-print (FJ-030 §3)', () => {
  it('sem argumentos: uso e código 2', () => {
    const r = rodar();
    expect(r.codigo).toBe(2);
    expect(r.erro).toMatch(/^forja-print: uso: node forja-print\.mjs <url> <saida\.png>/);
  });

  it.each([
    [['ftp://x/a', '/tmp/a.png'], /só http\(s\)/],
    [['nao é url', '/tmp/a.png'], /URL inválida/],
    [['http://localhost:1/', '/tmp/a.jpg'], /terminar em \.png/],
    [['http://localhost:1/', '/tmp/a.png', '--viewport', 'grande'], /LARGURAxALTURA/],
    [
      ['http://localhost:1/', '/tmp/a.png', '--storage', '/nao/existe.json'],
      /--storage inexistente/,
    ],
    [['http://localhost:1/', '/tmp/a.png', '--cor', 'azul'], /opção desconhecida: --cor/],
  ])('recusa %j com mensagem clara e código 2', (args, msg) => {
    const r = rodar(...args);
    expect(r.codigo).toBe(2);
    expect(r.erro).toMatch(msg);
  });
});
