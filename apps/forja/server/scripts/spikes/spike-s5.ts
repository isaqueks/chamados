import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analisarLinha } from '../../claude/stream';
import {
  criarAreaTemporaria,
  dirSaida,
  envClaude,
  executarSpike,
  gravarRodada,
  MODELO_MECANICA,
  novoUuid,
  recorteCota,
  resumirStream,
  rodarClaude,
  ultimoResult,
  usoDoResult,
  vereditoDe,
  type RecorteCota,
} from './apoio';
import { purgarEstado } from './limpeza';

/**
 * S5 — custo e cota (specs/forja/08 §2; 01 §6.5; 03 §7.6; critica F3).
 *
 * O "chamado `facil` ponta a ponta em dry-run" depende do orquestrador (M2) e
 * fica PENDENTE. O que este spike mede já, com haiku:
 *  - `rate_limit_event` ANTES/DEPOIS: o primeiro e o último observados em
 *    TODOS os streams gravados pelos spikes (rode o S5 por último) + os daqui;
 *  - "processo frio": dois processos NOVOS, mesmo prefixo (cwd, flags, system
 *    prompt), um depois do outro — o 2º lê do cache (`cache_read_input_tokens`)?
 *  - `total_cost_usd` no `--resume`: acumula o da sessão ou é só do turno
 *    (01 §6.5, delta × bruto)?
 *  - o processo frio do Fable (rodada única do S2), se gravada.
 */

interface EventoCota extends RecorteCota {
  origem: string;
}

/** Todos os `rate_limit_event` dos `.jsonl` gravados (ordem: mtime do arquivo, depois linha). */
export function coletarCotas(raiz: string): EventoCota[] {
  if (!existsSync(raiz)) return [];
  const arquivos: { caminho: string; mtime: number }[] = [];
  for (const sub of readdirSync(raiz)) {
    const dir = join(raiz, sub);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl')) {
        const caminho = join(dir, f);
        arquivos.push({ caminho, mtime: statSync(caminho).mtimeMs });
      }
    }
  }
  arquivos.sort((a, b) => a.mtime - b.mtime);
  const eventos: EventoCota[] = [];
  for (const a of arquivos) {
    for (const linha of readFileSync(a.caminho, 'utf8').split('\n')) {
      if (!linha.includes('rate_limit_event')) continue;
      const x = analisarLinha(linha);
      if (x.tipo !== 'mensagem' || x.mensagem.type !== 'rate_limit_event') continue;
      const info = (x.mensagem.rate_limit_info ?? {}) as Record<string, unknown>;
      eventos.push({
        ...recorteCota(info, new Date(a.mtime).toISOString()),
        origem: a.caminho.slice(raiz.length + 1),
      });
    }
  }
  return eventos;
}

/** Soma do `total_cost_usd` do último result de cada stream gravado (equivalente a preço de tabela). */
/** `cacheCreationInputTokens` somado no `modelUsage` do último result (acumulado da sessão). */
function cacheCriadoSessao(rod: { mensagens: Parameters<typeof resumirStream>[0] }): number | null {
  const mu = (ultimoResult(resumirStream(rod.mensagens))?.modelUsage ?? null) as Record<
    string,
    { cacheCreationInputTokens?: number }
  > | null;
  if (!mu) return null;
  return Object.values(mu).reduce((a, u) => a + (u.cacheCreationInputTokens ?? 0), 0);
}

function gastoGravado(raiz: string): { arquivo: string; custo: number }[] {
  const lista: { arquivo: string; custo: number }[] = [];
  if (!existsSync(raiz)) return lista;
  for (const sub of readdirSync(raiz)) {
    const dir = join(raiz, sub);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      let custo: number | null = null;
      for (const linha of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!linha.startsWith('{') || !linha.includes('"type":"result"')) continue;
        const x = analisarLinha(linha);
        if (x.tipo === 'mensagem' && typeof x.mensagem.total_cost_usd === 'number') {
          custo = x.mensagem.total_cost_usd;
        }
      }
      if (custo !== null) lista.push({ arquivo: `${sub}/${f}`, custo });
    }
  }
  return lista;
}

export async function executar(): Promise<number> {
  return executarSpike('s5', 'Custo e cota', async (r) => {
    const raiz = dirSaida();
    const area = await criarAreaTemporaria('s5');
    const cwd = area.raiz;
    try {
      const base = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        MODELO_MECANICA,
        '--effort',
        'low',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--tools',
        '',
        '--max-turns',
        '1',
      ];
      const env = envClaude({ DISABLE_AUTOUPDATER: '1' });
      const prompt = 'Responda só: ok';
      const sessao = novoUuid();
      const p1 = await rodarClaude({
        rotulo: 'p1-frio',
        args: [...base, '--session-id', sessao],
        cwd,
        env,
        prompt,
      });
      const p2 = await rodarClaude({
        rotulo: 'p2-segundo-processo',
        args: [...base, '--no-session-persistence'],
        cwd,
        env,
        prompt,
      });
      const p3 = await rodarClaude({
        rotulo: 'p3-resume-p1',
        args: [...base, '--resume', sessao],
        cwd,
        env,
        prompt: 'Responda só: ok de novo',
      });
      for (const p of [p1, p2, p3]) await gravarRodada('s5', p);
      const u1 = usoDoResult(ultimoResult(resumirStream(p1.mensagens)));
      const u2 = usoDoResult(ultimoResult(resumirStream(p2.mensagens)));
      const u3 = usoDoResult(ultimoResult(resumirStream(p3.mensagens)));
      r.anexar('uso', { p1: u1, p2: u2, p3_resume: u3 });

      r.criterio(
        'S5.a',
        'confirmar ou refutar "processo frio": o 2º processo novo (mesmo prefixo) lê do cache do 1º',
        vereditoDe((u2.cache_read ?? 0) > 0),
        `p1: cache_creation=${String(u1.cache_creation)} cache_read=${String(u1.cache_read)} custo=${String(u1.custo)}; p2: cache_creation=${String(u2.cache_creation)} cache_read=${String(u2.cache_read)} custo=${String(u2.custo)} → ${(u2.cache_read ?? 0) > 0 ? 'REFUTADO: o cache do prompt é do servidor e atravessa processos' : 'confirmado: processo novo paga o cache de novo'}`,
      );
      const acumula =
        u1.custo !== null &&
        u3.custo !== null &&
        u3.custo >= u1.custo + 0.0005 &&
        u3.custo > (u2.custo ?? 0) * 1.5;
      r.criterio(
        'S5.b',
        'registro: `total_cost_usd` no --resume acumula a sessão ou é só do turno (01 §6.5)',
        u3.custo === null ? 'FALHOU' : 'PASSOU',
        `p1 (turno 1)=${String(u1.custo)}; p3 (resume, turno 2)=${String(u3.custo)}; p2 (processo isolado equivalente)=${String(u2.custo)} → ${acumula ? 'ACUMULA (o app grava o delta)' : 'NÃO acumula: o valor do resume é só do processo (delta = bruto)'}; \`usage\` do resume é só do turno (cache_creation=${String(u3.cache_creation)}), \`modelUsage\` acumula (cacheCreation=${String(cacheCriadoSessao(p3))})`,
      );

      const fable = join(raiz, 's2', 'fable.jsonl');
      if (existsSync(fable)) {
        const msgs = readFileSync(fable, 'utf8')
          .split('\n')
          .map(analisarLinha)
          .flatMap((x) => (x.tipo === 'mensagem' ? [{ t: 0, m: x.mensagem }] : []));
        const res = ultimoResult(resumirStream(msgs));
        const mu = (res?.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
        r.anexar('fable_modelUsage', mu);
        r.criterio(
          'S5.c',
          'registro: processo frio do Fable + subagente Opus (rodada única do S2)',
          'PASSOU',
          Object.entries(mu)
            .map(
              ([m, u]) =>
                `${m}: in=${String(u.inputTokens)} out=${String(u.outputTokens)} cache_read=${String(u.cacheReadInputTokens)} cache_creation=${String(u.cacheCreationInputTokens)} US$${Number(u.costUSD ?? 0).toFixed(4)}`,
            )
            .join(' | ') + ` | total US$${Number(res?.total_cost_usd ?? 0).toFixed(4)}`,
        );
      } else {
        r.criterio(
          'S5.c',
          'registro: processo frio do Fable',
          'PENDENTE',
          'rode o S2 antes (rodada fable)',
        );
      }

      const cotas = coletarCotas(raiz);
      r.anexar('rate_limit_events', cotas);
      const primeiro = cotas[0];
      const ultimo = cotas.at(-1);
      const gasto = gastoGravado(raiz);
      const total = gasto.reduce((a, b) => a + b.custo, 0);
      r.anexar('gasto_por_stream', gasto);
      r.criterio(
        'S5.d',
        'rate_limit_event antes/depois das execuções dos spikes',
        vereditoDe(cotas.length > 0),
        primeiro && ultimo
          ? `${cotas.length} eventos; 5 h: ${String(primeiro.cinco_horas)} → ${String(ultimo.cinco_horas)}; 7 d: ${String(primeiro.sete_dias)} → ${String(ultimo.sete_dias)}; status final=${String(ultimo.status)}; gasto equivalente (preço de tabela) dos streams gravados ≈ US$${total.toFixed(2)}`
          : 'nenhum rate_limit_event gravado',
      );
      r.criterio(
        'S5.e',
        'custo e cota de um chamado `facil` real em dry-run (concorrência, 80 %/90 %, --max-budget-usd)',
        'PENDENTE',
        'depende do orquestrador ponta a ponta (M2); os números acima são de mecânica com haiku',
      );
    } finally {
      await purgarEstado(cwd);
      await area.limpar();
    }
  });
}
