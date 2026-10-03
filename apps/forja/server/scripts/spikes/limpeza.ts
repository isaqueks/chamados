import { spawn } from 'node:child_process';
import { envClaude } from './apoio';

/**
 * `claude purge <dir> -y`: apaga transcripts e a entrada de config que os
 * spikes criam para diretórios temporários (o `~/.claude` do usuário não fica
 * acumulando projetos-fantasma). Melhor esforço: falha só vira aviso.
 */
export function purgarEstado(dir: string): Promise<{ codigo: number | null; saida: string }> {
  return new Promise((ok) => {
    const p = spawn('claude', ['purge', dir, '-y'], {
      env: envClaude(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    p.stdout.on('data', (c: Buffer) => (saida += c.toString('utf8')));
    p.stderr.on('data', (c: Buffer) => (saida += c.toString('utf8')));
    const teto = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('close', (codigo) => {
      clearTimeout(teto);
      ok({ codigo, saida: saida.trim() });
    });
    p.on('error', (e) => {
      clearTimeout(teto);
      ok({ codigo: null, saida: String(e) });
    });
  });
}
