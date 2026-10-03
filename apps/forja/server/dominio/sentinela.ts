import type { Nucleo } from './nucleo';

/**
 * Sentinela de integridade (specs/forja/05 §4.9; 03 §2.5): hash antes/depois
 * de cada etapa com Bash (turnos de agente), de cada verificação, do
 * `evidenciar` e da reverificação da fila de merge. Divergência fica gravada em
 * `execucao.sentinela` (trava a fila de merge e o outbox DO PROJETO até o
 * humano reconhecer) e o chamador leva a execução a `precisa_humano`.
 *
 * Ausente `deps.sentinela` (testes), a medição é desligada. Uma medição que
 * falha (ex.: `crontab` travado) não derruba a etapa: vira log e a etapa segue
 * sem comparação naquele intervalo.
 */

export interface AlvoSentinela {
  execucao: { id: string };
  projeto: { repo_dir: string };
}

export async function medirSentinela(
  n: Nucleo,
  repoDir: string,
): Promise<Record<string, string> | null> {
  const medir = n.deps.sentinela;
  if (!medir) return null;
  try {
    return await medir(repoDir);
  } catch (e) {
    n.log(`sentinela: medição falhou (${(e as Error).message})`);
    return null;
  }
}

/** Compara duas medições e grava a divergência na execução. */
export async function registrarDivergencias(
  n: Nucleo,
  execucaoId: string,
  antes: Record<string, string> | null,
  depois: Record<string, string> | null,
): Promise<string[]> {
  if (!antes || !depois) return [];
  const chaves = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  const divergencias = [...chaves].filter((k) => antes[k] !== depois[k]).sort();
  if (divergencias.length > 0) {
    await n.banco.transacao((r) =>
      r.execucoes.atualizar(execucaoId, {
        sentinela: {
          antes,
          depois,
          divergencias,
          detectada_em: n.iso(),
          reconhecida_em: null,
        },
      }),
    );
  }
  return divergencias;
}

export async function comSentinela<T>(
  n: Nucleo,
  alvo: AlvoSentinela,
  fn: () => Promise<T>,
): Promise<{ valor: T; divergencias: string[] }> {
  if (!n.deps.sentinela) return { valor: await fn(), divergencias: [] };
  const antes = await medirSentinela(n, alvo.projeto.repo_dir);
  const valor = await fn();
  const depois = await medirSentinela(n, alvo.projeto.repo_dir);
  return { valor, divergencias: await registrarDivergencias(n, alvo.execucao.id, antes, depois) };
}
