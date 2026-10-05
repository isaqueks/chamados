import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Jornadas completas rodam git REAL em repositório temporário + SQLite: cada uma
// leva alguns segundos e, com a suíte inteira em paralelo, o default de 5 s
// estoura por carga, não por defeito. Timeout generoso só neste arquivo.
vi.setConfig({ testTimeout: 60_000 });
import type { ConfigResolvida } from '../../comum/config-projeto';
import type { PlanoRegistrado, TelaAfetada } from '../../comum/contratos';
import {
  aprovarG2,
  eventosBash,
  montarAmbiente,
  planoExemplo,
  relatorioComRef,
  reprovadoExemplo,
  resumoExemplo,
  roteiroFeliz,
  servicos,
  vereditoExemplo,
  type AmbienteOrquestrador,
  type ContextoTurno,
} from './apoio-orquestrador.test-apoio';
import { ErroForja } from './nucleo';
import { Orquestrador } from './orquestrador';

/**
 * Jornadas do pipeline (specs/forja/03 §12; 00 J2/J4/J5/J6): retrabalho e
 * verificação pelo agente (FJ-032), pingue-pongue, conflito na fila, pedir ajustes, crash
 * + retomada, lote com freio de cota e FJ-026 (UI com e sem prints).
 */

let amb: AmbienteOrquestrador | null = null;
const extras: Orquestrador[] = [];

afterEach(async () => {
  for (const o of extras.splice(0)) await o.parar();
  await amb?.limpar();
  amb = null;
});

const sh = (cwd: string, cmd: string) => execFileSync('sh', ['-c', cmd], { cwd });

async function estado(a: AmbienteOrquestrador, id: string) {
  return a.banco.ler((r) => r.execucoes.exigir(id));
}

async function tiposEtapas(a: AmbienteOrquestrador, id: string) {
  return (await a.banco.ler((r) => r.etapas.listar(id))).map((e) => `${e.tipo}:${e.motivo_fim}`);
}

async function criar(a: AmbienteOrquestrador, numero = 12) {
  return (await a.orq.criarExecucao({ projeto_id: a.projetoId, chamado_id: `uuid-${numero}` }))
    .execucao_id;
}

describe('J4 — a Forja não roda comandos (FJ-032); retrabalho da revisão converge', () => {
  it('T1 roda os checks ele mesmo → coleta registra → T2 relata comando vermelho → T1 ciclo 2 → T2 aprova', async () => {
    amb = await montarAmbiente();
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro(
        'condutor_t1',
        {
          // O implementador instala, roda o typecheck, corrige e roda de novo.
          antes: (c) =>
            void sh(c.cwd, 'echo ok > ok.txt && echo "export const total = 0;" >> src/app.ts'),
          eventos: [
            ...eventosBash('npm ci', true, 't1-ci'),
            ...eventosBash('npm run typecheck', false, 't1-tc1'),
            ...eventosBash('ls -la', true, 't1-ls'),
            ...eventosBash('npm run typecheck', true, 't1-tc2'),
          ],
          checkpoint: true,
          saida: resumoExemplo(1),
        },
        {
          antes: (c) => void sh(c.cwd, 'echo "// descontos" >> src/app.ts'),
          checkpoint: true,
          saida: resumoExemplo(2),
        },
      )
      .roteiro(
        'condutor_t2',
        {
          saida: (c: ContextoTurno) => ({
            ...reprovadoExemplo(c.head(), 1, 'O total ignora os descontos do pedido.'),
            comandos_executados: [{ comando: 'npm test', exit_code: 1, resumo: '1 teste falhou' }],
          }),
        },
        { saida: (c: ContextoTurno) => vereditoExemplo(c.head(), 2) },
      )
      .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    // Sem verificação pelo app: a coleta sempre segue para a revisão.
    expect(await tiposEtapas(amb, id)).toEqual([
      'planejar:concluido',
      'implementar:concluido',
      'verificar:concluido',
      'revisar:concluido',
      'implementar:concluido',
      'verificar:concluido',
      'revisar:concluido',
      'relatar:concluido',
    ]);
    expect([e.ciclo_auto, e.ciclo_total]).toEqual([1, 1]);
    expect(e.nivel_verificacao).toBe('verificado_pelo_revisor');
    // A coleta registra o que o T1 rodou (último resultado de cada comando; sem `ls`).
    const coleta = (await amb.banco.ler((r) => r.etapas.listar(id))).find(
      (x) => x.tipo === 'verificar',
    )!;
    expect(coleta.comandos?.map((c) => [c.nome, c.exit_code])).toEqual([
      ['npm ci', 0],
      ['npm run typecheck', 0],
    ]);
    // Nenhum comando do projeto rodou pelo app: não há logs de comando.
    expect(existsSync(join(amb.repo.dados, 'execucoes', id, 'logs'))).toBe(false);
    const t1 = amb.runner.chamadasDe('condutor_t1');
    expect(t1[0]!.prompt).toContain('Scripts encontrados (dicas; a Forja não os executa)');
    expect(t1[1]!.prompt).toContain('Considere os descontos no total.');
    const t2 = amb.runner.chamadasDe('condutor_t2');
    expect(t2[0]!.prompt).toContain('`npm run typecheck` → exit 0');
    expect(t2[0]!.args.join(' ')).toContain('Bash(npm run *)');
    // O 1º veredito relatou `npm test` vermelho (visto no stream com erro): declarado.
    const vereditos = await amb.banco.ler(async (r) =>
      (await r.artefatos.listar(id)).filter((a) => a.tipo === 'veredito'),
    );
    const v1 = vereditos[0]!.conteudo as unknown as {
      verificacao: { nivel: string; comandos: { no_stream: string }[] };
    };
    expect(v1.verificacao.nivel).toBe('declarado');
    expect(v1.verificacao.comandos[0]?.no_stream).toBe('erro');
  });

  it('o revisor só DECLARA os comandos (nada no stream) → nível declarado, sem bloquear o G2', async () => {
    amb = await montarAmbiente();
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro('condutor_t1', {
        antes: (c) => void sh(c.cwd, 'echo ok > ok.txt && echo "// x" >> src/app.ts'),
        checkpoint: true,
        saida: resumoExemplo(),
      })
      .roteiro('condutor_t2', {
        semBash: true,
        saida: (c: ContextoTurno) => vereditoExemplo(c.head()),
      })
      .roteiro('condutor_t3', {
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            como_foi_testado: {
              cenarios: [{ criterio: 'CA1', resultado: 'nao_testado', evidencia_ref: null }],
            },
          }),
      });
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    expect(e.nivel_verificacao).toBe('declarado');
  });

  it('achado repetido em dois vereditos seguidos → precisa_humano (pingue-pongue) antes do limite', async () => {
    amb = await montarAmbiente();
    const desc = 'O total ignora os descontos do pedido.';
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro(
        'condutor_t1',
        {
          antes: (c) => void sh(c.cwd, 'echo ok > ok.txt'),
          checkpoint: true,
          saida: resumoExemplo(1),
        },
        {
          antes: (c) => void sh(c.cwd, 'echo "// x" >> src/app.ts'),
          checkpoint: true,
          saida: resumoExemplo(2),
        },
      )
      .roteiro(
        'condutor_t2',
        { saida: (c: ContextoTurno) => reprovadoExemplo(c.head(), 1, desc) },
        { saida: (c: ContextoTurno) => reprovadoExemplo(c.head(), 2, `${desc}`) },
      );
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect([e.estado, e.motivo_estado]).toEqual(['precisa_humano', 'pingue_pongue']);
    expect(e.ciclo_auto).toBeLessThan(e.config_snapshot.limites.ciclos.max_auto);
  });
});

describe('J5 — conflito na fila de merge: o agente resolve, o humano reaprova (FJ-036)', () => {
  /** Publica no remoto um `main` que reescreve os arquivos (conflita com a branch do chamado). */
  function destinoAnda(a: AmbienteOrquestrador, arquivos: Record<string, string>, msg: string) {
    sh(a.repo.repo, 'git fetch -q origin && git reset -q --hard origin/main');
    for (const [caminho, conteudo] of Object.entries(arquivos)) {
      mkdirSync(join(a.repo.repo, caminho, '..'), { recursive: true });
      writeFileSync(join(a.repo.repo, caminho), conteudo);
    }
    sh(a.repo.repo, `git add -A && git commit -qm "${msg}" && git push -q origin main`);
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: a.repo.repo,
      encoding: 'utf8',
    }).trim();
  }

  const appDestino = (k: number) =>
    `export const destino = ${k};\nexport const total = ${100 + k};\n`;

  /** Turno T1 de conflito (o implementador resolve) + T2 + T3 da reaprovação. */
  function roteiroResolucao(a: AmbienteOrquestrador, k: number) {
    a.runner
      .roteiro('condutor_t1', {
        antes: (c) =>
          // Preserva as duas intenções: a linha do destino e o total do chamado.
          void writeFileSync(
            join(c.cwd, 'src/app.ts'),
            `export const destino = ${k};\nexport const total = 1;\n`,
          ),
        saida: {
          ...resumoExemplo(1, ['src/app.ts']),
          resumo_tecnico: `Mantive a linha do destino ${k} e o total do chamado.`,
        },
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', {
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            mudou_desde_a_ultima_versao: [`O destino avançou (${k}) e o conflito foi resolvido.`],
          }),
      });
  }

  it('conflito → resolvendo_conflito → T1 resolve → coleta → T2 → T3 → reaprovação; limite de 2; tentar de novo resolve de novo', async () => {
    amb = await montarAmbiente();
    roteiroFeliz(amb.runner);
    const id = await criar(amb);
    await amb.orq.ocioso();
    expect((await estado(amb, id)).estado).toBe('aguardando_aprovacao');
    const sessaoCondutor = (await estado(amb, id)).session_id_condutor;

    // 1ª ocorrência: alguém reescreve o mesmo arquivo na main (e cria outro).
    const t0 = destinoAnda(
      amb,
      { 'src/app.ts': appDestino(1), 'docs/destino.md': '# só do destino\n' },
      'destino 1',
    );
    const pre = await servicos(amb).aprovacao_obter({ id });
    expect(pre.alertas.map((x) => x.tipo)).toContain('conflito_destino');
    roteiroResolucao(amb, 1);
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    let e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    expect(await tiposEtapas(amb, id)).toEqual([
      'planejar:concluido',
      'implementar:concluido',
      'verificar:concluido',
      'revisar:concluido',
      'relatar:concluido',
      'integrar:comando_vermelho',
      'resolver_conflito:concluido',
      'verificar:concluido',
      'revisar:concluido',
      'relatar:concluido',
    ]);
    // O turno de conflito roda na sessão condutora, com o merge em curso e os arquivos.
    const turnoConflito = amb.runner.chamadasDe('condutor_t1').at(-1)!;
    expect(turnoConflito.sessionId).toBe(sessaoCondutor);
    expect(turnoConflito.prompt).toContain(`git merge --no-commit ${t0}`);
    expect(turnoConflito.prompt).toContain('`src/app.ts`');
    // O app commitou o merge (2 pais), sem marcador, com a mensagem da decisão.
    const dir = e.worktree_dir as string;
    const pais = execFileSync('git', ['rev-list', '--parents', '-n1', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .trim()
      .split(' ');
    expect(pais).toHaveLength(3);
    expect(pais).toContain(t0);
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim(),
    ).toBe(`forja: resolve conflito com main@${t0.slice(0, 7)}`);
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).not.toMatch(/<{7}|>{7}/);
    // T2 reverifica a resolução; T3 diz o que mudou desde a aprovação.
    expect(amb.runner.chamadasDe('condutor_t2').at(-1)!.prompt).toContain(
      'conflito com o destino resolvido pelo agente',
    );
    expect(amb.runner.chamadasDe('condutor_t3').at(-1)!.prompt).toContain(
      'Mudou desde a sua aprovação',
    );
    // Aprovação: reaprovação (G2') com a faixa do conflito; Interdiff só com os arquivos do chamado.
    const s = servicos(amb);
    const ap = await s.aprovacao_obter({ id });
    expect(ap.reaprovacao?.conflito).toMatchObject({ destino: 'main', sha_destino: t0 });
    expect(ap.reaprovacao?.conflito?.arquivos).toContain('src/app.ts');
    const faixa = ap.alertas.find((x) => x.tipo === 'reaprovacao');
    expect(faixa?.mensagem).toContain('conflito foi resolvido pelo agente');
    expect(ap.versao).toBe(2);
    const inter = await s.aprovacao_interdiff({ id });
    expect(inter.arquivos.map((x) => x.caminho)).toContain('src/app.ts');
    expect(inter.arquivos.map((x) => x.caminho)).not.toContain('docs/destino.md');
    const diff = await s.aprovacao_diff({ id });
    expect(diff.arquivos.map((x) => x.caminho)).not.toContain('docs/destino.md');
    // Trilha: sub-etapa do Merge.
    const ex = await s.execucao_obter({ id });
    const merge = ex.trilha.find((n) => n.chave === 'merge')!;
    expect(merge.subnos).toEqual([
      expect.objectContaining({ chave: 'resolver_conflito', estado: 'feito' }),
    ]);

    // 2ª ocorrência: o destino anda de novo antes da reaprovação → resolve de novo.
    destinoAnda(amb, { 'src/app.ts': appDestino(2) }, 'destino 2');
    roteiroResolucao(amb, 2);
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    expect((await estado(amb, id)).estado).toBe('aguardando_aprovacao');

    // 3ª: passou do limite de 2 resoluções automáticas → precisa de você.
    destinoAnda(amb, { 'src/app.ts': appDestino(3) }, 'destino 3');
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    e = await estado(amb, id);
    expect([e.estado, e.motivo_estado]).toEqual(['precisa_humano', 'conflito_merge']);
    expect(e.motivo_texto).toContain('2 resoluções automáticas');
    expect(amb.runner.pendentes('condutor_t1')).toBe(0);
    const itemConflito = (await amb.banco.ler((r) => r.filaMerge.ativos())).find(
      (i) => i.execucao_id === id,
    );
    expect([itemConflito?.estado, itemConflito?.tentativas_conflito]).toEqual(['conflito', 3]);

    // "Tentar de novo" (o humano pediu) → o agente resolve; reaprovação → mergeado.
    roteiroResolucao(amb, 3);
    await s.execucao_tentar_novamente({ id });
    await amb.orq.ocioso();
    expect((await estado(amb, id)).estado).toBe('aguardando_aprovacao');
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    e = await estado(amb, id);
    expect(['mergeado', 'comunicando', 'concluido']).toContain(e.estado);
    const mainRemota = execFileSync('git', ['rev-parse', 'main'], {
      cwd: amb.remoto,
      encoding: 'utf8',
    }).trim();
    expect(
      execFileSync('git', ['show', `${mainRemota}:src/app.ts`], {
        cwd: amb.remoto,
        encoding: 'utf8',
      }),
    ).toBe('export const destino = 3;\nexport const total = 1;\n');
  });

  it('marcador que sobra depois de 1 correção → precisa_humano com o merge em curso; tentar de novo retoma', async () => {
    amb = await montarAmbiente();
    roteiroFeliz(amb.runner);
    const id = await criar(amb);
    await amb.orq.ocioso();
    destinoAnda(amb, { 'src/app.ts': appDestino(1) }, 'destino 1');
    // O agente "termina" duas vezes sem tirar os marcadores.
    amb.runner.roteiro(
      'condutor_t1',
      { saida: resumoExemplo(1, ['src/app.ts']) },
      { saida: resumoExemplo(1, ['src/app.ts']) },
    );
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    let e = await estado(amb, id);
    expect([e.estado, e.motivo_estado]).toEqual(['precisa_humano', 'conflito_merge']);
    expect(e.motivo_texto).toContain('marcadores de conflito restantes');
    expect(amb.runner.chamadasDe('condutor_t1').at(-1)!.prompt).toContain(
      'ainda há marcadores de conflito em: src/app.ts',
    );
    const dir = e.worktree_dir as string;
    // Nada commitado com marcador: o merge continua em curso para a próxima tentativa.
    expect(sh(dir, 'git rev-parse -q --verify MERGE_HEAD').toString().trim()).not.toBe('');
    roteiroResolucao(amb, 1);
    await servicos(amb).execucao_tentar_novamente({ id });
    await amb.orq.ocioso();
    e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    expect(readFileSync(join(dir, 'src/app.ts'), 'utf8')).toBe(
      'export const destino = 1;\nexport const total = 1;\n',
    );
  });

  it('conflito em migration/schema (detector banco) → precisa_humano direto, worktree intocada', async () => {
    amb = await montarAmbiente({
      config: (c) => ({ ...c, detectores: { ...c.detectores, banco: ['**/migrations/**'] } }),
    });
    const migracao = 'db/migrations/001_total.sql';
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro('condutor_t1', {
        antes: (c) =>
          void sh(
            c.cwd,
            `mkdir -p db/migrations && echo "ALTER TABLE t ADD total int;" > ${migracao} && echo ok > ok.txt`,
          ),
        checkpoint: true,
        saida: resumoExemplo(1, [migracao, 'ok.txt']),
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', {
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            alteracoes_no_schema_do_banco: {
              houve: true,
              itens: [
                {
                  em_linguagem_simples: 'O relatório guarda o total.',
                  objeto_tecnico: 't.total',
                  tipo: 'coluna_nova',
                  afeta_dados_existentes: false,
                  reversivel: true,
                },
              ],
              declaracao: 'Uma coluna nova para o total.',
              exige_migracao_no_deploy: true,
            },
          }),
      });
    const id = await criar(amb);
    await amb.orq.ocioso();
    expect((await estado(amb, id)).estado).toBe('aguardando_aprovacao');
    destinoAnda(amb, { [migracao]: 'ALTER TABLE t ADD outra int;\n' }, 'migration do destino');
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect([e.estado, e.motivo_estado]).toEqual(['precisa_humano', 'conflito_schema']);
    expect(e.motivo_texto).toContain(migracao);
    // Nada foi integrado na branch do chamado e não houve turno de conflito.
    expect(await tiposEtapas(amb, id)).not.toContain('resolver_conflito:concluido');
    expect(e.sha_atual).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: e.worktree_dir!, encoding: 'utf8' }).trim(),
    );
    const item = (await amb.banco.ler((r) => r.filaMerge.ativos())).find(
      (i) => i.execucao_id === id,
    );
    expect(item?.estado).toBe('conflito');
  });
});

describe('J6 — pedir ajustes no G2', () => {
  it('comentário vira insumo do T1; relatório v2 com "mudou desde a última versão"', async () => {
    amb = await montarAmbiente();
    roteiroFeliz(amb.runner);
    amb.runner
      .roteiro('condutor_t1', {
        antes: (c) => void sh(c.cwd, 'echo "// com vírgula" >> src/app.ts'),
        checkpoint: true,
        saida: resumoExemplo(2),
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head(), 2) })
      .roteiro('condutor_t3', {
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            mudou_desde_a_ultima_versao: ['O total usa vírgula decimal.'],
          }),
      });
    const id = await criar(amb);
    await amb.orq.ocioso();
    await servicos(amb).aprovacao_pedir_ajustes(
      { id },
      { comentario: 'Use vírgula como separador decimal.', arquivos: ['src/app.ts'] },
    );
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    expect([e.ciclo_auto, e.ciclo_total]).toEqual([0, 1]);
    const t1 = amb.runner.chamadasDe('condutor_t1');
    expect(t1).toHaveLength(2);
    expect(t1[1]!.prompt).toContain('src/app.ts: Use vírgula como separador decimal.');
    const ap = await servicos(amb).aprovacao_obter({ id });
    expect(ap.versao).toBe(2);
    // FJ-034: nada a cumprir — só o patch curto informativo entre os avisos.
    expect(ap.avisos.find((x) => x.tipo === 'patch')?.mensagem).toContain('versão 2');
    const comentarios = await amb.banco.ler((r) => r.comentarios.listar(id));
    expect(comentarios.every((c) => c.consumido_em !== null)).toBe(true);
  });
});

describe('crash do app + retomada (03 §3.3, §9.5)', () => {
  it('etapa em execução no boot → interrompido → retomada 1× com --resume e o turno interrompido', async () => {
    amb = await montarAmbiente();
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      // O T1 fica "rodando" quando o app cai.
      .roteiro('condutor_t1', { segurar: true, antes: (c) => void sh(c.cwd, 'echo ok > ok.txt') });
    const id = await criar(amb);
    for (let i = 0; i < 200 && amb.runner.chamadasDe('condutor_t1').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect((await estado(amb, id)).estado).toBe('implementando');
    const executando = await amb.banco.ler((r) => r.etapas.executando());
    expect(executando.map((x) => x.tipo)).toEqual(['implementar']);
    expect(executando[0]!.pid).not.toBeNull();

    // "Reboot": outro orquestrador no mesmo SQLite/dados; o processo antigo é dado como morto.
    amb.runner.roteiro('condutor_t1', {
      antes: (c) => void sh(c.cwd, 'echo ok > ok.txt'),
      saida: resumoExemplo(1, ['ok.txt']),
    });
    amb.runner
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
    const orq2 = new Orquestrador({ ...amb.orq.opcoes, sondar: () => 'morto' });
    extras.push(orq2);
    const acoes = await orq2.iniciar();
    expect(acoes.map((a) => a.tipo)).toContain('execucao_interrompida');
    await orq2.ocioso();
    const e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    const t1 = amb.runner.chamadasDe('condutor_t1');
    expect(t1).toHaveLength(2);
    expect(t1[1]!.args).toContain('--resume');
    expect(t1[1]!.sessionId).toBe(t1[0]!.sessionId);
    const etapas = await amb.banco.ler((r) => r.etapas.listar(id));
    const impl = etapas.filter((x) => x.tipo === 'implementar');
    expect(impl.map((x) => [x.estado, x.retomada])).toEqual([
      ['interrompida', false],
      ['concluida', true],
    ]);
    // Uma segunda interrupção da mesma etapa iria a precisa_humano (retomada só 1×).
    await amb.orq.parar();
  });
});

describe('J2 — lote com mesa de planos e freio de cota', () => {
  it('planeja em paralelo, G1 pela config, aprova limpos em bloco; freio segura o T1 até o resetsAt', async () => {
    // FJ-033: o lote não força mais o G1; aqui o projeto pede aprovação de todo plano.
    amb = await montarAmbiente({
      chamados: [12, 13],
      config: (c) => {
        c.gates.plano = 'sempre';
        return c;
      },
    });
    amb.runner.roteiro('planejador', { saida: planoExemplo() }, { saida: planoExemplo() });
    for (let i = 0; i < 2; i++) {
      amb.runner
        .roteiro('condutor_t1', {
          antes: (c) => void sh(c.cwd, 'echo ok > ok.txt && echo "// t" >> src/app.ts'),
          checkpoint: true,
          saida: resumoExemplo(1),
        })
        .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
        .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
    }
    const s = servicos(amb);
    const { lote_id, execucao_ids } = await s.lote_criar(
      {},
      { projeto_id: amb.projetoId, chamado_ids: ['uuid-12', 'uuid-13'] },
    );
    await amb.orq.ocioso();
    for (const id of execucao_ids) expect((await estado(amb, id)).estado).toBe('aguardando_plano');
    const mesa = await s.lote_planos({ id: lote_id });
    expect(mesa.cartoes.map((c) => c.classe)).toEqual(['limpo', 'limpo']);
    // Recusa aprovar em bloco o que não está na mesa.
    await expect(
      s.lote_aprovar_limpos({ id: lote_id }, { execucao_ids: ['outra'] }),
    ).rejects.toBeInstanceOf(ErroForja);

    // 5 h em 85 %: o freio segura o início de etapas de agente.
    const reset = new Date(amb.relogio.agora.getTime() + 3600_000).toISOString();
    await amb.banco.transacao((r) =>
      r.usoAssinatura.registrar({
        utilizacao_5h: 0.85,
        utilizacao_7d: 0.1,
        reinicia_5h_em: reset,
        reinicia_7d_em: null,
        status: 'allowed_warning',
        status_overage: null,
        usando_creditos_extras: false,
        bruto: {},
      }),
    );
    await s.lote_aprovar_limpos({ id: lote_id }, { execucao_ids });
    await amb.orq.ocioso();
    expect(amb.runner.chamadasDe('condutor_t1')).toHaveLength(0);
    for (const id of execucao_ids) expect((await estado(amb, id)).estado).toBe('implementando');
    const lote = await s.lote_obter({ id: lote_id });
    expect(lote.freio.ativo).toBe(true);
    expect(lote.lote.estado).toBe('implementando');

    // Passou o resetsAt: libera sem precisar de evento novo (03 §7.6).
    amb.relogio.avancar(2 * 3600_000);
    await amb.orq.tick();
    await amb.orq.ocioso();
    for (const id of execucao_ids)
      expect((await estado(amb, id)).estado).toBe('aguardando_aprovacao');
    const aprovs = await amb.banco.ler((r) =>
      r.aprovacoes.listar(execucao_ids[0]!, { tipo: 'plano' }),
    );
    expect(aprovs[0]?.em_bloco).toBe(true);
  });
});

describe('FJ-033 — o planejador decide; suposições vão ao relatório', () => {
  it('lote com plano limpo e pergunta com suposição: sem Gdec nem G1, suposição chega à aprovação', async () => {
    amb = await montarAmbiente({ chamados: [12] });
    amb.runner
      .roteiro('planejador', {
        saida: planoExemplo({
          suposicoes: ['O total considera só pedidos pagos.'],
          perguntas_ao_cliente: [
            {
              pergunta: 'Inclui pedidos cancelados?',
              por_que_importa: 'muda o total',
              suposicao_padrao: 'não inclui cancelados',
            },
          ],
        }),
      })
      .roteiro('condutor_t1', {
        antes: (c) => void sh(c.cwd, 'echo ok > ok.txt && echo "// t" >> src/app.ts'),
        checkpoint: true,
        saida: resumoExemplo(1),
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
    const s = servicos(amb);
    const { execucao_ids } = await s.lote_criar(
      {},
      { projeto_id: amb.projetoId, chamado_ids: ['uuid-12'] },
    );
    await amb.orq.ocioso();
    const id = execucao_ids[0]!;
    expect((await estado(amb, id)).estado).toBe('aguardando_aprovacao');
    const plano = await amb.banco.ler((r) => r.artefatos.ultimaVersao(id, 'plano'));
    const oficial = plano?.conteudo as unknown as PlanoRegistrado;
    expect(oficial.perguntas_ao_cliente).toEqual([]);
    expect(oficial.gate_g1).toEqual({ exigido: false, motivos: [] });
    const esperadas = [
      'O total considera só pedidos pagos.',
      'Pergunta ao cliente não feita: Inclui pedidos cancelados? — assumido: não inclui cancelados',
    ];
    expect(oficial.suposicoes).toEqual(esperadas);
    // O relator deixou `suposicoes_assumidas` vazio: o app copiou as do plano.
    const aprov = await s.aprovacao_obter({ id });
    expect(aprov.relatorio.suposicoes_assumidas).toEqual(esperadas);
    expect(amb.runner.chamadasDe('condutor_t3')[0]!.prompt).toContain(
      'Suposições assumidas no plano',
    );
  });
});

describe('FJ-026 — prints antes/depois em alteração de UI', () => {
  const tela: TelaAfetada = {
    id: 'UI1',
    descricao: 'Relatório mensal',
    rota: '/relatorio',
    estado_esperado: 'O total aparece no rodapé.',
  };
  const planoUi = planoExemplo({
    areas: ['ui'],
    telas_afetadas: [tela],
    arquivos_previstos: ['src/ui/relatorio.tsx', 'ok.txt'],
    passos: [
      {
        id: 'P1',
        descricao: 'Mostrar o total na tela.',
        arquivos_previstos: ['src/ui/relatorio.tsx', 'ok.txt'],
        depende_de: [],
      },
    ],
  });
  const comUi = (c: ConfigResolvida) => {
    c.detectores.frontend = ['src/ui/**'];
    return c;
  };
  const t1Ui = {
    antes: (c: ContextoTurno) =>
      void sh(
        c.cwd,
        'mkdir -p src/ui && echo "<p>total</p>" > src/ui/relatorio.tsx && echo ok > ok.txt',
      ),
    checkpoint: true,
    saida: resumoExemplo(1, ['src/ui/relatorio.tsx', 'ok.txt']),
  };

  /** PNG mínimo (assinatura + IHDR): o app confere magic bytes e dimensões. */
  const png = (largura: number, altura: number, marca: string) => {
    const b = Buffer.alloc(40);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'ascii');
    b.writeUInt32BE(largura, 16);
    b.writeUInt32BE(altura, 20);
    b.write(marca, 33, 'ascii');
    return b;
  };
  /** Diretório de evidências que o B7 entregou ao condutor (lido do arquivo de sistema). */
  const dirB7 = (c: ContextoTurno): string | null => {
    const i = c.args.indexOf('--append-system-prompt-file');
    const sistema = readFileSync(c.args[i + 1]!, 'utf8');
    return /`([^`]+\/evidencias)\/antes\/<id>\.png`/.exec(sistema)?.[1] ?? null;
  };

  it('com prints: o T1 recebe B7 e fotografa; o app coleta antes/depois; evidência completa', async () => {
    let comB7 = false;
    let semMcp = false;
    amb = await montarAmbiente({ config: comUi });
    amb.runner
      .roteiro('planejador', { saida: planoUi })
      .roteiro('condutor_t1', {
        ...t1Ui,
        antes: (c: ContextoTurno) => {
          const dir = dirB7(c);
          comB7 = dir !== null;
          semMcp = c.args.includes('--mcp-config') === false;
          if (!dir) return;
          // O agente: `antes` no sha_base (antes de editar), implementa, `depois`.
          mkdirSync(join(dir, 'antes'), { recursive: true });
          writeFileSync(join(dir, 'antes', 'UI1.png'), png(1366, 768, 'antes'));
          const passado = new Date(Date.now() - 60_000);
          utimesSync(join(dir, 'antes', 'UI1.png'), passado, passado);
          t1Ui.antes(c);
          mkdirSync(join(dir, 'depois'), { recursive: true });
          writeFileSync(join(dir, 'depois', 'UI1.png'), png(1366, 900, 'depois'));
          writeFileSync(
            join(dir, 'telas.json'),
            JSON.stringify([
              {
                id: 'UI1',
                descricao: 'Relatório mensal',
                rota: '/relatorio',
                antes: 'antes/UI1.png',
                depois: 'depois/UI1.png',
              },
            ]),
          );
        },
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', {
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            alteracoes_de_interface: {
              houve: true,
              telas: [
                { tela_id: 'UI1', o_que_mudou_para_quem_usa: 'O rodapé mostra o total do mês.' },
              ],
              declaracao: 'A tela do relatório passou a mostrar o total.',
            },
          }),
      });
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(comB7).toBe(true);
    expect(semMcp).toBe(true);
    expect(e.estado).toBe('aguardando_aprovacao');
    expect(e.evidencia_visual).toBe('completa');
    expect(e.selos?.altera_ui).toBe(true);
    const ev = await servicos(amb).aprovacao_evidencias({ id });
    expect(ev.telas[0]?.antes?.expirada).toBe(false);
    expect(ev.telas[0]?.depois?.altura).toBe(900);
    const img = await servicos(amb).imagemEvidencia(id, ev.telas[0]!.depois!.artefato_id);
    expect(img.conteudo.subarray(33, 39).toString()).toBe('depois');
    const ap = await servicos(amb).aprovacao_obter({ id });
    expect(ap.avisos.map((x) => x.tipo)).not.toContain('sem_prints');
  });

  it('o agente declara que não conseguiu: sem_evidencia_visual vira aviso e o G2 aprova num clique (FJ-034)', async () => {
    amb = await montarAmbiente({ config: comUi });
    amb.runner
      .roteiro('planejador', { saida: planoUi })
      .roteiro('condutor_t1', {
        ...t1Ui,
        antes: (c: ContextoTurno) => {
          t1Ui.antes(c);
          const dir = dirB7(c);
          if (!dir) return;
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, 'telas.json'),
            JSON.stringify({ telas: [], motivo_geral: 'o app exige SSO corporativo' }),
          );
        },
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', {
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            alteracoes_de_interface: {
              houve: true,
              telas: [
                { tela_id: 'UI1', o_que_mudou_para_quem_usa: 'O rodapé mostra o total do mês.' },
              ],
              declaracao:
                'alteração de interface sem prints: o agente não conseguiu fotografar: o app exige SSO corporativo',
            },
          }),
      });
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(e.estado).toBe('aguardando_aprovacao');
    expect(e.evidencia_visual).toBe('sem_evidencia_visual');
    const ap = await servicos(amb).aprovacao_obter({ id });
    expect(ap.avisos.map((x) => x.tipo)).toContain('sem_prints');
    expect(ap.alertas.map((a) => a.tipo)).toContain('ui_sem_prints');
    await aprovarG2(amb, id);
    const vigente = await amb.banco.ler((r) => r.aprovacoes.vigente(id));
    expect(vigente?.aprovado_sem_prints).toBe(true);
  });

  it('FJ-031: plano sem UI — o T1 recebe o B7 mesmo assim e declara nao_se_aplica', async () => {
    let sistemaT1 = '';
    amb = await montarAmbiente();
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro('condutor_t1', {
        antes: (c: ContextoTurno) => {
          const i = c.args.indexOf('--append-system-prompt-file');
          sistemaT1 = readFileSync(c.args[i + 1]!, 'utf8');
          sh(c.cwd, 'echo ok > ok.txt && echo "export const total = 1;" >> src/app.ts');
          const dir = dirB7(c);
          if (!dir) return;
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'telas.json'), JSON.stringify({ nao_se_aplica: true }));
        },
        checkpoint: true,
        saida: resumoExemplo(),
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(sistemaT1).toContain('# Evidências visuais');
    expect(sistemaT1).toContain('"nao_se_aplica": true');
    expect(e.estado).toBe('aguardando_aprovacao');
    expect(e.selos?.altera_ui).toBe(false);
    expect(e.evidencia_visual).toBe('nao_se_aplica');
  });

  it('FJ-031: declarou nao_se_aplica mas o diff toca UI → sem_evidencia_visual com o motivo', async () => {
    amb = await montarAmbiente({ config: comUi });
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro('condutor_t1', {
        ...t1Ui,
        antes: (c: ContextoTurno) => {
          t1Ui.antes(c);
          const dir = dirB7(c);
          if (!dir) return;
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'telas.json'), JSON.stringify({ nao_se_aplica: true }));
        },
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', { saida: (c: ContextoTurno) => relatorioComRef(c.head()) });
    const id = await criar(amb);
    await amb.orq.ocioso();
    const e = await estado(amb, id);
    expect(e.selos?.altera_ui).toBe(true);
    expect(e.evidencia_visual).toBe('sem_evidencia_visual');
    expect(e.evidencia_visual_motivo).toBe(
      'o agente declarou não alterar UI, mas o diff toca src/ui/relatorio.tsx',
    );
  });
});
