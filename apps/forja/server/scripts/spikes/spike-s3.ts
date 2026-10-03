import { join } from 'node:path';
import {
  clonarDescartavel,
  criarAreaTemporaria,
  ehAgente,
  executarSpike,
  intervalosSubagentes,
  gravarRodada,
  negacoesDoResult,
  novoUuid,
  resumirStream,
  rodarClaude,
  sobrepoem,
  ultimoResult,
  vereditoDe,
} from './apoio';
import { prepararEtapa, schemaObjeto } from './etapa-spike';
import { purgarEstado } from './limpeza';

/**
 * S3 — revisores em paralelo no foreground (specs/forja/08 §2; 03 §3.2; 04 §2).
 *
 * Perfil T2 do S2 (haiku na mecânica, sessão nova): o condutor pede
 * `revisor_correcao` e `revisor_seguranca` NA MESMA MENSAGEM. Mede, pelo
 * instante de chegada de `task_started`/`task_notification` de cada subagente,
 * se os intervalos se sobrepõem e se a fase dura ≈ o mais lento (paralelo) ou
 * ≈ a soma (sequencial). Com `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, o turno
 * precisa fechar com 1 `result`.
 */

const TAREFA_REVISOR =
  'Rode, UM POR VEZ, os comandos Bash `git log -3 --stat`, `git show --stat HEAD` e `git log --oneline -10`, depois leia o arquivo package.json com Read, e responda em UMA frase o que viu.';

export async function executar(): Promise<number> {
  return executarSpike('s3', 'Revisores em paralelo no foreground', async (r) => {
    const area = await criarAreaTemporaria('s3');
    const clone = await clonarDescartavel(area);
    try {
      const etapa = await prepararEtapa(
        {
          dirDados: join(area.raiz, 'dados'),
          execucaoId: novoUuid(),
          worktree: clone.dir,
          repoUsuario: join(area.raiz, 'checkout-usuario'),
        },
        {
          perfil: 'condutor_t2',
          n: 1,
          sessao: { modo: 'novo', sessionId: novoUuid() },
          jsonSchema: schemaObjeto({
            revisores: { type: 'array', items: { type: 'string' } },
            mesma_mensagem: { type: 'boolean' },
          }),
          maxTurns: 8,
          orcamentoUsd: 0.6,
        },
      );
      const prompt = [
        'Teste automatizado de concorrência de subagentes.',
        'Na SUA PRÓXIMA RESPOSTA, emita DUAS chamadas da ferramenta Agent JUNTAS, na MESMA mensagem (chamadas paralelas), e nada mais:',
        `- subagent_type \`revisor_correcao\`, prompt: "${TAREFA_REVISOR}"`,
        `- subagent_type \`revisor_seguranca\`, prompt: "${TAREFA_REVISOR}"`,
        'Quando os dois responderem, chame a saída estruturada com `revisores` (as duas frases) e `mesma_mensagem` = true se você emitiu as duas chamadas juntas.',
      ].join('\n');
      const rod = await rodarClaude({
        rotulo: 't2-dois-revisores',
        args: [...etapa.comando.args, '--no-session-persistence'],
        cwd: clone.dir,
        env: etapa.comando.env,
        prompt,
        timeoutMs: 600_000,
      });
      await gravarRodada('s3', rod);
      const s = resumirStream(rod.mensagens);
      const res = ultimoResult(s);
      const agentes = s.usos.filter((u) => ehAgente(u) && u.pai === null);
      const ids = new Set(agentes.map((a) => a.mensagemId));
      const mesmaMensagem = agentes.length === 2 && ids.size === 1 && !ids.has(null);
      const intervalos = intervalosSubagentes(s);
      const [a, b] = intervalos;
      const paralelo = Boolean(a && b && sobrepoem(a, b));
      const duracoes = intervalos.map((x) => x.fim - x.inicio);
      const fase =
        intervalos.length > 0
          ? Math.max(...intervalos.map((x) => x.fim)) - Math.min(...intervalos.map((x) => x.inicio))
          : 0;
      const soma = duracoes.reduce((x, y) => x + y, 0);
      const maisLento = duracoes.length ? Math.max(...duracoes) : 0;
      r.anexar('intervalos_ms', intervalos);
      r.anexar('fase_ms', fase);
      r.anexar('soma_ms', soma);
      r.anexar('duracao_total_ms', rod.duracaoMs);
      r.anexar(
        'agentes',
        agentes.map((x) => ({ tipo: x.entrada.subagent_type, mensagemId: x.mensagemId })),
      );
      r.anexar('negacoes', negacoesDoResult(res));
      r.anexar('custo', res?.total_cost_usd ?? null);
      r.anexar('subagent_stats', res?.subagent_stats ?? null);

      r.criterio(
        'S3.a',
        'o condutor emite os 2 revisores na mesma mensagem',
        vereditoDe(mesmaMensagem),
        `${agentes.length} chamadas Agent na thread principal, ${ids.size} message.id distinto(s): [${agentes.map((x) => String(x.entrada.subagent_type)).join(', ')}]`,
      );
      r.criterio(
        'S3.b',
        'os revisores rodam em paralelo (intervalos sobrepostos; fase ≈ o mais lento)',
        intervalos.length === 2 ? vereditoDe(paralelo && fase < 0.8 * soma) : 'FALHOU',
        `intervalos=${intervalos.map((x) => `${x.nome}[${x.inicio}–${x.fim}]`).join(' ')}; fase=${fase} ms; mais lento=${maisLento} ms; soma=${soma} ms`,
      );
      r.criterio(
        'S3.c',
        '1 único result com structured_output',
        vereditoDe(s.results.length === 1 && res?.structured_output != null),
        `results=${s.results.length} (${String(res?.subtype)}); custo=${String(res?.total_cost_usd)}`,
      );
    } finally {
      await purgarEstado(clone.dir);
      await area.limpar();
    }
  });
}
