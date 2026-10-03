import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Git real + SQLite: o default de 5 s estoura por carga da suíte inteira, não por defeito.
vi.setConfig({ testTimeout: 60_000 });
import {
  aprovarG2,
  montarAmbiente,
  reprovadoExemplo,
  roteiroFeliz,
  vereditoExemplo,
  type AmbienteOrquestrador,
  type ContextoTurno,
  type OpcoesAmbiente,
} from './apoio-orquestrador.test-apoio';
import type { FonteChamados } from './nucleo';

/**
 * Regressões da revisão da área B (orquestrador, fila de merge, outbox): cada
 * teste reproduz o cenário de um finding que a suíte não pegava (estado preso,
 * laço de despacho, aprovação vigente fantasma, integração em voo).
 */

let amb: AmbienteOrquestrador | null = null;

afterEach(async () => {
  await amb?.limpar();
  amb = null;
});

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Alguém publica na `main` uma mudança no topo de `src/app.ts` (arquivo do patch), sem conflito. */
function destinoAndou(a: AmbienteOrquestrador): void {
  execFileSync(
    'sh',
    [
      '-c',
      "sed -i '1s/.*/\\/\\/ cabeçalho do destino/' src/app.ts && git commit -qam destino && git push -q origin main",
    ],
    { cwd: a.repo.repo },
  );
}

async function ateAprovacao(
  op: OpcoesAmbiente = {},
): Promise<{ a: AmbienteOrquestrador; id: string }> {
  amb = await montarAmbiente(op);
  roteiroFeliz(amb.runner);
  const { execucao_id } = await amb.orq.criarExecucao({
    projeto_id: amb.projetoId,
    chamado_id: 'uuid-12',
  });
  await amb.orq.ocioso();
  expect((await amb.banco.ler((r) => r.execucoes.exigir(execucao_id))).estado).toBe(
    'aguardando_aprovacao',
  );
  return { a: amb, id: execucao_id };
}

/** Aprova com o despachante parado: a execução fica em `na_fila_merge` com o item `aguardando`. */
async function naFilaMerge(): Promise<{ a: AmbienteOrquestrador; id: string }> {
  const { a, id } = await ateAprovacao();
  await a.orq.parar();
  await aprovarG2(a, id);
  return { a, id };
}

describe('fila de merge coerente com a execução (#5, #6, #7, #15)', () => {
  it('Descartar em na_fila_merge finaliza o item e invalida a aprovação: a fila não trava', async () => {
    const { a, id } = await naFilaMerge();
    expect((await a.banco.ler((r) => r.filaMerge.proximo(a.projetoId, 'main')))?.execucao_id).toBe(
      id,
    );
    await a.orq.descartar(id, {
      motivo: 'não precisa',
      nota_interna: null,
      remover_worktree: false,
    });
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('descartado');
    expect(await a.banco.ler((r) => r.filaMerge.ativoDaExecucao(id))).toBeNull();
    expect(await a.banco.ler((r) => r.filaMerge.proximo(a.projetoId, 'main'))).toBeNull();
    expect(await a.banco.ler((r) => r.aprovacoes.vigente(id))).toBeNull();
  });

  it('reverificação vermelha devolve ao T1 SEM aprovação vigente: o G2 seguinte registra', async () => {
    const { a, id } = await naFilaMerge();
    const n = a.orq.n;
    await n.transicionar(id, {
      tipo: 'vez_na_fila_merge',
      proximo_da_fila: true,
      semaforo_merge_livre: true,
    });
    const t = await n.transicionar(id, {
      tipo: 'integracao_concluida',
      resultado: 'reverificacao_vermelha',
    });
    expect(t.execucao.estado).toBe('implementando');
    expect(await a.banco.ler((r) => r.aprovacoes.vigente(id))).toBeNull();
    expect(await a.banco.ler((r) => r.filaMerge.ativoDaExecucao(id))).toBeNull();
    // I-3 não dispara mais no próximo G2.
    await a.banco.transacao((r) =>
      r.aprovacoes.registrar({
        execucao_id: id,
        tipo: 'final',
        decisao: 'aprovado',
        patch_id: 'p2',
        sha: 'b'.repeat(40),
      }),
    );
  });

  it('conflito: o item fica visível e a próxima aprovação o substitui (I-5)', async () => {
    const { a, id } = await naFilaMerge();
    const n = a.orq.n;
    await n.transicionar(id, {
      tipo: 'vez_na_fila_merge',
      proximo_da_fila: true,
      semaforo_merge_livre: true,
    });
    const item = await a.banco.ler((r) => r.filaMerge.ativoDaExecucao(id));
    await a.banco.transacao((r) => r.filaMerge.mudarEstado(item!.id, 'conflito'));
    await n.transicionar(id, { tipo: 'integracao_concluida', resultado: 'conflito' });
    expect((await a.banco.ler((r) => r.filaMerge.ativoDaExecucao(id)))?.estado).toBe('conflito');
    expect(await a.banco.ler((r) => r.aprovacoes.vigente(id))).toBeNull();
    const novo = await a.banco.transacao(async (r) => {
      const ap = await r.aprovacoes.registrar({
        execucao_id: id,
        tipo: 'reaprovacao',
        decisao: 'aprovado',
        patch_id: 'p2',
        sha: 'b'.repeat(40),
      });
      return r.filaMerge.enfileirar({
        projeto_id: a.projetoId,
        branch_destino: 'main',
        execucao_id: id,
        aprovacao_id: ap.id,
      });
    });
    expect(novo.id).not.toBe(item!.id);
    expect((await a.banco.ler((r) => r.filaMerge.obter(item!.id)))?.estado).toBe('devolvido');
  });

  it('integração em voo (reverificação do revisor): Descartar/Encerrar recusados (409); o merge conclui normalmente (#13)', async () => {
    const { a, id } = await ateAprovacao();
    // O destino anda DEPOIS da aprovação mexendo num arquivo do patch, sem conflito (FJ-032 §5).
    destinoAndou(a);
    a.runner.roteiro('condutor_t2', {
      segurar: true,
      saida: (c: ContextoTurno) => vereditoExemplo(c.head()),
    });
    await aprovarG2(a, id);
    for (let i = 0; i < 200; i++) {
      const item = await a.banco.ler((r) => r.filaMerge.ativoDaExecucao(id));
      if (item?.estado === 'verificando' && a.runner.chamadasDe('condutor_t2').length === 2) break;
      await dormir(20);
    }
    await expect(
      a.orq.descartar(id, { motivo: 'x', nota_interna: null, remover_worktree: false }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(a.orq.encerrar(id, 'x')).rejects.toMatchObject({ status: 409 });
    a.runner.liberarSegurados();
    await a.orq.ocioso();
    const e = await a.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('concluido');
    // A reverificação é um T2 AVULSO: sessão nova, na worktree de integração.
    const [t2, rev] = a.runner.chamadasDe('condutor_t2');
    expect(rev!.args).toContain('--session-id');
    expect(rev!.sessionId).not.toBe(t2!.sessionId);
    expect(e.session_id_condutor).toBe(t2!.sessionId);
    expect(rev!.prompt).toContain('Reverificação antes do merge');
    expect(rev!.prompt).toContain('src/app.ts');
    expect(e.nivel_verificacao).toBe('verificado_pelo_revisor');
  });

  it('destino andou SEM interseção com o patch: integra direto, sem reverificação (FJ-032 §5)', async () => {
    const { a, id } = await ateAprovacao();
    execFileSync(
      'sh',
      ['-c', 'echo "# outro" >> README.md && git commit -qam outro && git push -q origin main'],
      { cwd: a.repo.repo },
    );
    await aprovarG2(a, id);
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('concluido');
    expect(a.runner.chamadasDe('condutor_t2')).toHaveLength(1);
  });

  it('reverificação reprovada → T1 com as instruções e o destino integrado na branch', async () => {
    const { a, id } = await ateAprovacao();
    destinoAndou(a);
    a.runner.roteiro('condutor_t2', {
      saida: (c: ContextoTurno) =>
        reprovadoExemplo(c.head(), 1, 'A mudança do destino quebrou o total.'),
    });
    await a.orq.parar();
    await aprovarG2(a, id);
    const n = a.orq.n;
    await n.transicionar(id, {
      tipo: 'vez_na_fila_merge',
      proximo_da_fila: true,
      semaforo_merge_livre: true,
    });
    await a.orq.filaMerge.processar(id);
    const e = await a.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('implementando');
    expect(e.ciclo_total).toBe(1);
    const log = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: e.worktree_dir as string,
      encoding: 'utf8',
    });
    expect(log).toContain('para corrigir a reverificação');
    const vereditos = await a.banco.ler(async (r) =>
      (await r.artefatos.listar(id)).filter((x) => x.tipo === 'veredito'),
    );
    expect((vereditos.at(-1)!.conteudo as { decisao: string }).decisao).toBe('reprovado');
  });

  it('reverificação que não conclui → falhou (setup_falhou); "Tentar de novo" re-enfileira e integra (#9)', async () => {
    const { a, id } = await ateAprovacao();
    destinoAndou(a);
    a.runner
      .roteiro('condutor_t2', { classificacao: 'timeout' })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) });
    await aprovarG2(a, id);
    await a.orq.ocioso();
    const falhou = await a.banco.ler((r) => r.execucoes.exigir(id));
    expect([falhou.estado, falhou.motivo_estado, falhou.estado_anterior]).toEqual([
      'falhou',
      'setup_falhou',
      'integrando',
    ]);
    expect(falhou.motivo_texto).toContain('reverificação pelo revisor não concluiu');
    await a.orq.tentarNovamente(id);
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('concluido');
  });
});

describe('despacho sem laço e etapas sem órfãs (#4, #14, #16, #54)', () => {
  it('planejando sem conexão utilizável: adia, não relança em laço', async () => {
    amb = await montarAmbiente({
      config: (c) => ({ ...c, gates: { ...c.gates, plano: 'sempre' } }),
    });
    const a = amb;
    roteiroFeliz(a.runner);
    let usar = true;
    const original = a.orq.n.deps.chamados;
    (a.orq.n.deps as { chamados: (id: string) => FonteChamados | null }).chamados = (c) => {
      const f = original(c);
      return f && { ...f, podeUsar: () => usar };
    };
    const { execucao_id: id } = await a.orq.criarExecucao({
      projeto_id: a.projetoId,
      chamado_id: 'uuid-12',
    });
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('aguardando_plano');
    usar = false;
    await a.orq.comentarPlano(id, 'considere os descontos');
    await a.orq.ocioso(200);
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('planejando');
    expect(a.runner.chamadasDe('planejador')).toHaveLength(1);
  });

  it('timeout do planejador vai a precisa_humano (não reabre o planejador)', async () => {
    amb = await montarAmbiente();
    amb.runner.roteiro('planejador', { classificacao: 'timeout' });
    const { execucao_id: id } = await amb.orq.criarExecucao({
      projeto_id: amb.projetoId,
      chamado_id: 'uuid-12',
    });
    await amb.orq.ocioso();
    const e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect([e.estado, e.motivo_estado]).toEqual(['precisa_humano', 'timeout_etapa']);
    expect(amb.runner.chamadasDe('planejador')).toHaveLength(1);
  });

  it('spawn do T1 lança: etapa finalizada (sem órfã executando) e "Tentar de novo" funciona', async () => {
    amb = await montarAmbiente();
    const a = amb;
    roteiroFeliz(a.runner);
    const iniciar = a.runner.iniciar.bind(a.runner);
    let lancou = false;
    a.runner.iniciar = (c, e) => {
      if (!lancou && c.esperado.perfil === 'condutor_t1') {
        lancou = true;
        throw new Error('spawn falhou');
      }
      return iniciar(c, e);
    };
    const { execucao_id: id } = await a.orq.criarExecucao({
      projeto_id: a.projetoId,
      chamado_id: 'uuid-12',
    });
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('falhou');
    const etapas = await a.banco.ler((r) => r.etapas.listar(id));
    expect(etapas.filter((x) => x.estado === 'executando')).toEqual([]);
    await a.orq.tentarNovamente(id);
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('aguardando_aprovacao');
  });

  it('ocioso() lança quando o despacho não para (nunca passa calado)', async () => {
    amb = await montarAmbiente();
    const o = amb.orq as unknown as { despachando: boolean };
    o.despachando = true;
    await expect(amb.orq.ocioso(3)).rejects.toThrow(/não ficou ocioso/);
    o.despachando = false;
  });
});

describe('sentinela e outbox (#10, #23, #28/#35)', () => {
  it('escrita fora da worktree durante o T1 → precisa_humano e projeto travado até reconhecer', async () => {
    let bashrc = 'original';
    amb = await montarAmbiente({
      orquestrador: { sentinela: () => Promise.resolve({ '~/.bashrc': bashrc }) },
    });
    const a = amb;
    roteiroFeliz(a.runner);
    // O T1 do roteiro feliz "persiste" algo no rc do usuário.
    const iniciar = a.runner.iniciar.bind(a.runner);
    a.runner.iniciar = (c, e) => {
      if (c.esperado.perfil === 'condutor_t1') bashrc = 'alterado pelo agente';
      return iniciar(c, e);
    };
    const { execucao_id: id } = await a.orq.criarExecucao({
      projeto_id: a.projetoId,
      chamado_id: 'uuid-12',
    });
    await a.orq.ocioso();
    const e = await a.banco.ler((r) => r.execucoes.exigir(id));
    expect([e.estado, e.motivo_estado]).toEqual(['precisa_humano', 'sentinela_divergente']);
    expect(e.sentinela?.divergencias).toEqual(['~/.bashrc']);
    expect((await a.orq.outbox.projetosTravados()).has(a.projetoId)).toBe(true);
    await a.orq.descartar(id, { motivo: 'x', nota_interna: 'nota', remover_worktree: false });
    // Descartar não destrava: só "Reconhecer".
    expect((await a.orq.outbox.projetosTravados()).has(a.projetoId)).toBe(true);
    await a.orq.reconhecerSentinela(id);
    expect((await a.orq.outbox.projetosTravados()).has(a.projetoId)).toBe(false);
  });

  it('passo bloqueado depois do merge: mergeado_pendente_chamado; "tentar agora" reenvia', async () => {
    const { a, id } = await ateAprovacao();
    // Um valor sensível conhecido aparece no texto: o detector bloqueia (05 §8.2).
    a.orq.n.registrarSegredos(['total do mês']);
    await aprovarG2(a, id);
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe(
      'mergeado_pendente_chamado',
    );
    const bloqueados = (await a.banco.ler((r) => r.outbox.listar(id))).filter(
      (l) => l.estado === 'bloqueado',
    );
    expect(bloqueados.length).toBeGreaterThan(0);
    a.orq.n.segredos.clear();
    await a.orq.outboxTentarAgora(id);
    await a.orq.ocioso();
    expect((await a.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('concluido');
  });
});

describe('reconciliação do boot (01 §3.2 [V S4])', () => {
  it('etapa de agente sem pid deixada em executando: varre a worktree e marca interrompida', async () => {
    const varridos: string[] = [];
    const { a, id } = await ateAprovacao({
      orquestrador: {
        varrerCwd: async (dir) => {
          varridos.push(dir);
          return 0;
        },
      },
    });
    const exec = await a.banco.ler((r) => r.execucoes.exigir(id));
    const etapa = await a.banco.transacao((r) =>
      r.etapas.criar({ execucao_id: id, ciclo: 1, tipo: 'implementar' }),
    );
    await a.orq.reconciliarNoBoot();
    expect(varridos).toEqual([exec.worktree_dir]);
    expect((await a.banco.ler((r) => r.etapas.exigir(etapa.id))).estado).toBe('interrompida');
  });
});
