import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clonarDescartavel,
  comandoBash,
  criarAreaTemporaria,
  descendentes,
  envClaude,
  esperar,
  executarSpike,
  gravarRodada,
  iniciarRodada,
  MODELO_MECANICA,
  novoUuid,
  processosDoGrupo,
  processoVivo,
  resumirStream,
  rodarClaude,
  sinalizarGrupo,
  ultimoResult,
  vereditoDe,
  type ProcessoListado,
  type RelatorioSpike,
} from './apoio';
import { prepararEtapa, schemaObjeto, type AmbienteEtapa } from './etapa-spike';
import { purgarEstado } from './limpeza';

/**
 * S4 — retomada real (specs/forja/08 §2; 01 §6.7; 03 §3.3; 02 §9).
 *
 *  A. T1 (haiku, bypass) com 6 passos Bash lentos; SIGINT no grupo logo depois
 *     do resultado do passo 2; depois `--resume` + `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`
 *     com OUTRO schema. Coerente = não refaz passo 1/2 e termina o 6.
 *  B. Um script Node PAI spawna o `claude` como o runner (detached, pipes) e
 *     leva SIGKILL; medimos se o filho e o grupo dele morrem sozinhos e se
 *     algo continua escrevendo 30 s depois.
 *  C. `claude purge <dir>` de um diretório removido não quebra o `--resume`
 *     de uma sessão em outro diretório (02 §9).
 */

const SCHEMA_A = schemaObjeto({ passos_feitos: { type: 'array', items: { type: 'string' } } });
const SCHEMA_RETOMADA = schemaObjeto({
  passos_ja_feitos_antes: { type: 'array', items: { type: 'string' } },
  passos_feitos_agora: { type: 'array', items: { type: 'string' } },
});

function passosDoComando(comandos: readonly string[]): number[] {
  const n: number[] = [];
  for (const c of comandos) {
    const m = /passo-(\d)/.exec(c);
    if (m) n.push(Number(m[1]));
  }
  return n;
}

export async function executar(): Promise<number> {
  return executarSpike('s4', 'Retomada real (F-08)', async (r) => {
    const area = await criarAreaTemporaria('s4');
    const purgar: string[] = [];
    try {
      const clone = await clonarDescartavel(area);
      purgar.push(clone.dir);
      const amb: AmbienteEtapa = {
        dirDados: join(area.raiz, 'dados'),
        execucaoId: novoUuid(),
        worktree: clone.dir,
        repoUsuario: join(area.raiz, 'checkout-usuario'),
      };
      await parteA(r, amb);
      await parteB(r, amb, area.raiz);
      await parteC(r, area.raiz, purgar);
    } finally {
      for (const d of purgar) await purgarEstado(d);
      await area.limpar();
    }
  });
}

async function parteA(r: RelatorioSpike, amb: AmbienteEtapa): Promise<void> {
  const sessao = novoUuid();
  const t1 = await prepararEtapa(amb, {
    perfil: 'condutor_t1',
    n: 1,
    sessao: { modo: 'novo', sessionId: sessao },
    jsonSchema: SCHEMA_A,
    maxTurns: 20,
    orcamentoUsd: 0.5,
  });
  const comandos = [1, 2, 3, 4, 5, 6].map((k) => `sleep 4 && echo passo-${k}`);
  let tSigint: number | null = null;
  const emCurso = iniciarRodada({
    rotulo: 'a-t1-interrompido',
    args: t1.comando.args,
    cwd: amb.worktree,
    env: t1.comando.env,
    prompt: [
      'Teste de interrupção. Execute, UM POR VEZ (uma chamada Bash por mensagem, esperando o resultado de cada uma), estes 6 comandos:',
      ...comandos.map((c, i) => `${i + 1}. \`${c}\``),
      'Depois chame a saída estruturada com `passos_feitos` (as saídas, ex.: "passo-1").',
    ].join('\n'),
    timeoutMs: 300_000,
    aoMensagem: (m, c) => {
      if (tSigint !== null || m.type !== 'user') return;
      if (JSON.stringify(m.message ?? '').includes('passo-2')) {
        tSigint = c.t();
        c.sinalizar('SIGINT');
      }
    },
  });
  const rodA = await emCurso.fim;
  await gravarRodada('s4', rodA);
  const sA = resumirStream(rodA.mensagens);
  const depoisDoSinal = tSigint === null ? [] : rodA.mensagens.filter((x) => x.t > (tSigint ?? 0));
  r.anexar('a_sigint_ms', tSigint);
  r.anexar('a_saida', { exitCode: rodA.exitCode, sinal: rodA.sinal, duracaoMs: rodA.duracaoMs });
  r.anexar(
    'a_mensagens_apos_sigint',
    depoisDoSinal.map((x) => `${x.m.type}/${String(x.m.subtype ?? '')}`),
  );
  r.anexar(
    'a_results',
    sA.results.map((x) => ({
      subtype: x.subtype,
      is_error: x.is_error,
      terminal_reason: x.terminal_reason,
    })),
  );
  r.criterio(
    'S4.a1',
    'registro: SIGINT no grupo em -p encerra o processo (tempo, código, result emitido)',
    tSigint === null ? 'FALHOU' : 'PASSOU',
    tSigint === null
      ? 'o passo 2 não chegou: SIGINT não enviado'
      : `saiu em ${rodA.duracaoMs - tSigint} ms após o SIGINT, exit=${String(rodA.exitCode)} sinal=${String(rodA.sinal)}; results=${sA.results.length}${sA.results[0] ? ` (${String(sA.results[0].subtype)}, terminal_reason=${String(sA.results[0].terminal_reason)})` : ''}; ${depoisDoSinal.length} mensagens depois do sinal`,
  );

  const t2 = await prepararEtapa(amb, {
    perfil: 'condutor_t1',
    n: 2,
    sessao: { modo: 'resume', sessionId: sessao },
    retomarTurnoInterrompido: true,
    jsonSchema: SCHEMA_RETOMADA,
    maxTurns: 20,
    orcamentoUsd: 0.5,
  });
  const rodB = await rodarClaude({
    rotulo: 'a-resume',
    args: t2.comando.args,
    cwd: amb.worktree,
    env: t2.comando.env,
    prompt:
      'Retome; estado atual: o turno anterior foi interrompido pelo app. Execute APENAS os passos da lista original que ainda não têm resultado no histórico desta conversa (não repita nenhum), um por vez, e então chame a saída estruturada (`passos_ja_feitos_antes` = os que já tinham resultado antes desta retomada; `passos_feitos_agora` = os que você executou agora).',
    timeoutMs: 300_000,
  });
  await gravarRodada('s4', rodB);
  const sB = resumirStream(rodB.mensagens);
  const resB = ultimoResult(sB);
  const refeitos = passosDoComando(sB.usos.filter((u) => u.nome === 'Bash').map(comandoBash));
  const so = (resB?.structured_output ?? null) as {
    passos_ja_feitos_antes?: string[];
    passos_feitos_agora?: string[];
  } | null;
  const initB = sB.inits[0];
  r.anexar('a_resume_passos_executados', refeitos);
  r.anexar('a_resume_structured_output', so);
  r.anexar('a_resume_inits', sB.inits.length);
  r.anexar('a_resume_custo', resB?.total_cost_usd ?? null);
  const coerente =
    resB?.subtype === 'success' &&
    so !== null &&
    !refeitos.includes(1) &&
    !refeitos.includes(2) &&
    (refeitos.includes(6) || (so.passos_feitos_agora ?? []).some((p) => p.includes('6'))) &&
    (so.passos_ja_feitos_antes ?? []).some((p) => p.includes('2'));
  r.criterio(
    'S4.a2',
    '--resume + CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 com schema trocado é coerente',
    vereditoDe(coerente),
    `sessão=${initB?.session_id === sessao ? 'mesma' : String(initB?.session_id)}; result=${String(resB?.subtype)}; passos executados na retomada=[${refeitos.join(',')}]; antes=[${(so?.passos_ja_feitos_antes ?? []).join(',')}]; agora=[${(so?.passos_feitos_agora ?? []).join(',')}]`,
  );
}

async function parteB(r: RelatorioSpike, amb: AmbienteEtapa, raiz: string): Promise<void> {
  const t1 = await prepararEtapa(amb, {
    perfil: 'condutor_t1',
    n: 3,
    sessao: { modo: 'novo', sessionId: novoUuid() },
    jsonSchema: SCHEMA_A,
    maxTurns: 20,
    orcamentoUsd: 0.5,
  });
  const ticks = join(raiz, 'ticks.txt');
  const comandos = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => `sleep 3 && echo tick-${k} >> ${ticks}`);
  const cfg = join(raiz, 'pai.json');
  await writeFile(
    cfg,
    JSON.stringify({
      args: [...t1.comando.args, '--no-session-persistence'],
      cwd: amb.worktree,
      env: t1.comando.env,
      prompt: [
        'Teste de processo. Execute, UM POR VEZ (uma chamada Bash por mensagem), estes 8 comandos:',
        ...comandos.map((c, i) => `${i + 1}. \`${c}\``),
        'Depois chame a saída estruturada com `passos_feitos`.',
      ].join('\n'),
    }),
  );
  // O PAI imita o app: spawn detached, stdin com o prompt e FECHADO, stdout lido por pipe.
  const script = join(raiz, 'pai.mjs');
  await writeFile(
    script,
    `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const c = spawn('claude', cfg.args, { cwd: cfg.cwd, env: cfg.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdout.write('FILHO ' + c.pid + '\\n');
c.stdin.end(cfg.prompt);
c.stdout.on('data', () => {});
c.stderr.on('data', () => {});
setInterval(() => {}, 1000);
`,
  );
  const pai = spawn(process.execPath, [script, cfg], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pidFilho = await new Promise<number>((ok, falha) => {
    let buf = '';
    const teto = setTimeout(() => falha(new Error('o pai não informou o pid do filho')), 30_000);
    pai.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const m = /FILHO (\d+)/.exec(buf);
      if (m) {
        clearTimeout(teto);
        ok(Number(m[1]));
      }
    });
  });
  const linhas = () =>
    existsSync(ticks) ? readFileSync(ticks, 'utf8').split('\n').filter(Boolean).length : 0;
  const limite = Date.now() + 240_000;
  // Árvore do filho enquanto um comando do agente roda: em que grupo/sessão o Bash põe os comandos?
  let arvore: ProcessoListado[] = [];
  while (
    (linhas() < 1 || !arvore.some((p) => p.comando.includes('sleep'))) &&
    Date.now() < limite
  ) {
    const agora = descendentes(pidFilho);
    if (agora.some((p) => p.comando.includes('sleep'))) arvore = agora;
    await esperar(200);
  }
  const ticksNoKill = linhas();
  pai.kill('SIGKILL');
  const amostras: { s: number; filhoVivo: boolean; grupo: number[]; ticks: number }[] = [];
  const t0 = Date.now();
  for (const s of [1, 5, 15, 35]) {
    await esperar(t0 + s * 1000 - Date.now());
    amostras.push({
      s,
      filhoVivo: processoVivo(pidFilho),
      grupo: processosDoGrupo(pidFilho),
      ticks: linhas(),
    });
  }
  const sobreviveu =
    amostras.at(-1)?.filhoVivo === true || (amostras.at(-1)?.grupo.length ?? 0) > 0;
  const arvoreFinal = descendentes(pidFilho);
  sinalizarGrupo(pidFilho, 'SIGKILL');
  for (const p of [...arvore, ...arvoreFinal]) sinalizarGrupo(p.pgid, 'SIGKILL');
  const ticksAos5 = amostras.find((a) => a.s === 5)?.ticks ?? 0;
  const ticksAos35 = amostras.at(-1)?.ticks ?? 0;
  r.anexar('b_amostras', amostras);
  r.anexar('b_ticks_no_kill', ticksNoKill);
  r.anexar('b_arvore_filho', arvore);
  const foraDoGrupo = arvore.filter((p) => p.pgid !== pidFilho);
  r.criterio(
    'S4.d',
    'os comandos que o agente roda pelo Bash ficam no grupo (pgid) do `claude` — a escada no -pgid os alcança',
    arvore.length ? vereditoDe(foraDoGrupo.length === 0) : 'PENDENTE',
    arvore.length
      ? `claude pgid=${pidFilho}; descendentes: ${arvore.map((p) => `${p.pid}(pgid ${p.pgid}, sid ${p.sid}) ${p.comando.slice(0, 40)}`).join(' | ')}`
      : 'nenhum descendente observado durante um comando',
  );
  const morte = amostras.find((a) => !a.filhoVivo && a.grupo.length === 0);
  r.criterio(
    'S4.b',
    'SIGKILL no PAI: o filho (stream-json, detached) sai sozinho, sem órfão escrevendo 30 s depois',
    ticksNoKill === 0 ? 'FALHOU' : vereditoDe(!sobreviveu && ticksAos35 === ticksAos5),
    ticksNoKill === 0
      ? 'nenhum tick antes do prazo: o filho não chegou a trabalhar'
      : `${morte ? `filho e grupo mortos em ≤ ${morte.s} s` : 'filho/grupo AINDA VIVOS aos 35 s (órfão)'}; ticks: no kill=${ticksNoKill}, +5 s=${ticksAos5}, +35 s=${ticksAos35}; amostras=${amostras.map((a) => `${a.s}s:${a.filhoVivo ? 'vivo' : 'morto'}/${a.grupo.length}proc/${a.ticks}t`).join(' ')}`,
  );
}

async function parteC(r: RelatorioSpike, raiz: string, purgar: string[]): Promise<void> {
  const x = join(raiz, 'wt-removida');
  const y = join(raiz, 'wt-viva');
  await mkdir(x, { recursive: true });
  await mkdir(y, { recursive: true });
  purgar.push(y);
  const base = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    MODELO_MECANICA,
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--tools',
    '',
    '--max-turns',
    '1',
  ];
  const env = envClaude();
  const sa = novoUuid();
  const sb = novoUuid();
  const ra = await rodarClaude({
    rotulo: 'c-sessao-a',
    args: [...base, '--session-id', sa],
    cwd: x,
    env,
    prompt: 'Palavra-código: GOIABA-1. Responda só: ok',
  });
  const rb = await rodarClaude({
    rotulo: 'c-sessao-b',
    args: [...base, '--session-id', sb],
    cwd: y,
    env,
    prompt: 'Palavra-código: CAJU-3. Responda só: ok',
  });
  await rm(x, { recursive: true, force: true });
  const purge = await purgarEstado(x);
  const rbr = await rodarClaude({
    rotulo: 'c-resume-b',
    args: [...base, '--resume', sb],
    cwd: y,
    env,
    prompt: 'Qual era a palavra-código desta conversa? Responda só a palavra.',
  });
  await mkdir(x, { recursive: true });
  const rar = await rodarClaude({
    rotulo: 'c-resume-a-purgada',
    args: [...base, '--resume', sa],
    cwd: x,
    env,
    prompt: 'Qual era a palavra-código? Responda só a palavra.',
  });
  purgar.push(x);
  for (const rod of [ra, rb, rbr, rar]) await gravarRodada('s4', rod);
  const resB = ultimoResult(resumirStream(rbr.mensagens));
  const resA = ultimoResult(resumirStream(rar.mensagens));
  r.anexar('c_purge', purge);
  r.anexar('c_resume_purgada', {
    exitCode: rar.exitCode,
    stderr: rar.stderr.slice(0, 600),
    result: resA?.result ?? null,
    subtype: resA?.subtype ?? null,
  });
  r.criterio(
    'S4.c',
    '`claude purge <dir>` de uma worktree removida não quebra o --resume de outra sessão',
    vereditoDe(
      purge.codigo === 0 &&
        resB?.subtype === 'success' &&
        String(resB?.result ?? '')
          .toUpperCase()
          .includes('CAJU-3'),
    ),
    `purge exit=${String(purge.codigo)}; resume da outra sessão: ${String(resB?.subtype)} "${String(resB?.result ?? '').slice(0, 40)}"; resume da sessão purgada: exit=${String(rar.exitCode)} stderr="${rar.stderr.trim().slice(0, 160)}"`,
  );
}
