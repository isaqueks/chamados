import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Git real + SQLite: o default de 5 s estoura por carga da suíte inteira, não por defeito.
vi.setConfig({ testTimeout: 60_000 });
import { erro, type Requisicao } from '../chamados/servidor-falso.test-apoio';
import { normalizarStream } from '../claude/stream';
import { lerFixture } from '../claude/fixtures/processo-falso';
import { ItemFilaMergeSchema } from '../db/entidades/item-fila-merge';
import { OutboxChamadoSchema } from '../db/entidades/outbox-chamado';
import {
  aprovarG2,
  montarAmbiente,
  planoExemplo,
  relatorioComRef,
  resumoExemplo,
  roteiroFeliz,
  servicos,
  TEXTO_RESPOSTA,
  vereditoExemplo,
  type AmbienteOrquestrador,
  type ContextoTurno,
} from './apoio-orquestrador.test-apoio';
import { backoffMs, situacaoRodada, tipoDaRodada } from './outbox';
import { Orquestrador } from './orquestrador';

/**
 * Fila de merge e outbox (specs/forja/03 §8, §9, §12.4, §12.6): reconciliação
 * no boot sem segundo merge, cópia suja do usuário intacta, idempotência do
 * outbox depois de queda da API e de crash em `enviando`.
 */

let amb: AmbienteOrquestrador | null = null;
const extras: Orquestrador[] = [];

afterEach(async () => {
  for (const o of extras.splice(0)) await o.parar();
  await amb?.limpar();
  amb = null;
});

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function ateAprovacao(a: AmbienteOrquestrador): Promise<string> {
  roteiroFeliz(a.runner);
  const { execucao_id } = await a.orq.criarExecucao({
    projeto_id: a.projetoId,
    chamado_id: 'uuid-12',
  });
  await a.orq.ocioso();
  return execucao_id;
}

describe('outbox — regras puras', () => {
  it('backoff 1, 2, 4… até 30 min; tipo e situação da rodada', () => {
    expect([0, 1, 2, 10].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 1_800_000]);
    expect(tipoDaRodada([{ passo: 'silenciar_ia' }, { passo: 'nota_inicio' }])).toBe('inicio');
    expect(tipoDaRodada([{ passo: 'nota_interna' }, { passo: 'mensagem_publica' }])).toBe(
      'encerramento',
    );
    expect(tipoDaRodada([{ passo: 'pergunta_publica' }])).toBe('pergunta');
    expect(situacaoRodada([{ estado: 'enviado' }, { estado: 'pulado' }])).toBe('concluida');
    expect(situacaoRodada([{ estado: 'enviado' }, { estado: 'retido' }])).toBe('so_retidos');
    expect(situacaoRodada([{ estado: 'enviado' }, { estado: 'bloqueado' }])).toBe('bloqueada');
    expect(situacaoRodada([{ estado: 'pendente' }])).toBe('em_andamento');
  });
});

describe('fila de merge (03 §8, §9.5)', () => {
  it('app morreu entre o push e o registro: no boot vira mergeado SEM segundo merge', async () => {
    amb = await montarAmbiente();
    const id = await ateAprovacao(amb);
    // Para o despachante antes do G2: a integração "acontece" à mão, como se o app tivesse caído.
    await amb.orq.parar();
    await aprovarG2(amb, id);
    const e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    const dirInt = join(amb.repo.raiz, 'int');
    g(amb.repo.repo, 'worktree', 'add', '--detach', dirInt, 'origin/main');
    g(dirInt, 'merge', '--no-ff', '-m', 'Chamado #12: Chamado 12', e.branch as string);
    const shaMerge = g(dirInt, 'rev-parse', 'HEAD');
    g(amb.repo.repo, 'push', '-q', 'origin', `${shaMerge}:refs/heads/main`);
    await amb.orq.n.transicionar(id, {
      tipo: 'vez_na_fila_merge',
      proximo_da_fila: true,
      semaforo_merge_livre: true,
    });
    await amb.banco.transacao(async (r) => {
      await r.execucoes.atualizar(id, { sha_merge: shaMerge });
      const item = await r.filaMerge.ativoDaExecucao(id);
      await r.filaMerge.mudarEstado(item!.id, 'publicando');
    });

    const orq2 = new Orquestrador({ ...amb.orq.opcoes, sondar: () => 'morto' });
    extras.push(orq2);
    await orq2.iniciar();
    await orq2.ocioso();
    const depois = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(depois.estado).toBe('concluido');
    expect(g(amb.remoto, 'rev-parse', 'main')).toBe(shaMerge);
    expect(
      g(amb.remoto, 'log', '--oneline', '--grep', 'Chamado #12', 'main').split('\n'),
    ).toHaveLength(1);
  });

  it('cópia do usuário na main suja (merge_e_push): push direto aceito, cópia intacta, aviso', async () => {
    amb = await montarAmbiente();
    const id = await ateAprovacao(amb);
    writeFileSync(join(amb.repo.repo, 'README.md'), '# editado pelo usuário\n');
    const localAntes = g(amb.repo.repo, 'rev-parse', 'main');
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    const e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('concluido');
    expect(g(amb.remoto, 'rev-parse', 'main')).toBe(e.sha_merge);
    expect(g(amb.repo.repo, 'rev-parse', 'main')).toBe(localAntes);
    expect(readFileSync(join(amb.repo.repo, 'README.md'), 'utf8')).toBe('# editado pelo usuário\n');
    const itens = await amb.banco.ler((r) =>
      r.m.find(ItemFilaMergeSchema, { where: { execucao_id: id } }),
    );
    expect(itens.map((i) => [i.estado, i.copia_local_atras, i.modo_avanco])).toEqual([
      ['concluido', true, 'push_direto'],
    ]);
  });

  it("G2 aprovado e patch-id integrado diferente → G2' (reaprovação com interdiff)", async () => {
    amb = await montarAmbiente();
    const id = await ateAprovacao(amb);
    // Muda só o CONTEXTO no destino: o patch-id não muda (03 §12.3, S9) e o merge segue.
    g(amb.repo.repo, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(amb.repo.repo, 'README.md'), '# projeto\n\nnota nova\n');
    g(amb.repo.repo, 'commit', '-qam', 'docs');
    g(amb.repo.repo, 'push', '-q', 'origin', 'main');
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    expect((await amb.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe('concluido');
  });
});

describe('outbox (03 §9, §12.4)', () => {
  it('API fora no meio → mergeado_pendente_chamado → backoff → exatamente 1 nota e 1 pública', async () => {
    amb = await montarAmbiente();
    const id = await ateAprovacao(amb);
    let quedas = 0;
    const caiStatus = (r: Requisicao) => {
      if (r.metodo === 'POST' && r.caminho.endsWith('/status') && quedas < 5) {
        quedas += 1;
        return erro(503, 'indisponivel');
      }
      return null;
    };
    amb.chamados.interceptores.push(caiStatus);
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    let e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('mergeado_pendente_chamado');
    const pend = await servicos(amb).merge_obter({}, {});
    expect(pend.pendencias_chamados.map((p) => p.passo)).toEqual(['status_resolvido']);

    // Crash com passos em `enviando` (resultado desconhecido): o boot NÃO reenvia às cegas.
    await amb.banco.transacao((r) =>
      r.m.update(
        OutboxChamadoSchema,
        { execucao_id: id, passo: 'nota_interna' },
        { estado: 'enviando' },
      ),
    );
    await amb.banco.transacao((r) =>
      r.m.update(
        OutboxChamadoSchema,
        { execucao_id: id, passo: 'mensagem_publica' },
        { estado: 'enviando' },
      ),
    );
    amb.chamados.interceptores.splice(0);
    await amb.orq.parar();
    const orq2 = new Orquestrador({ ...amb.orq.opcoes, sondar: () => 'morto' });
    extras.push(orq2);
    await orq2.iniciar();
    amb.relogio.avancar(3 * 60_000);
    await orq2.tick();
    await orq2.ocioso();
    e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('concluido');
    const msgs = amb.chamados.chamados.get('uuid-12')!.mensagens;
    expect(msgs.filter((m) => m.corpo.includes(`[forja:${id}:conclusao]`))).toHaveLength(1);
    expect(msgs.filter((m) => m.corpo === TEXTO_RESPOSTA)).toHaveLength(1);
    expect(amb.chamados.chamados.get('uuid-12')!.detalhe.status).toBe('resolvido');
  });

  it('aguardar_deploy: só a nota sai; Gdeploy libera pública e status', async () => {
    amb = await montarAmbiente({
      config: (c) => {
        c.politica_status.ao_concluir = 'aguardar_deploy';
        return c;
      },
    });
    const disponivel =
      'Olá, Maria! O total do mês já aparece no relatório. Qualquer dúvida, é só responder por aqui.';
    amb.runner
      .roteiro('planejador', { saida: planoExemplo() })
      .roteiro('condutor_t1', {
        antes: (c) => void execFileSync('sh', ['-c', 'echo ok > ok.txt'], { cwd: c.cwd }),
        checkpoint: true,
        saida: resumoExemplo(1, ['ok.txt']),
      })
      .roteiro('condutor_t2', { saida: (c: ContextoTurno) => vereditoExemplo(c.head()) })
      .roteiro('condutor_t3', {
        // `aguardar_deploy` exige resposta do tipo "disponivel" (04 §8.2).
        saida: (c: ContextoTurno) =>
          relatorioComRef(c.head(), {
            resposta_ao_cliente: {
              versao: 1,
              tipo: 'disponivel',
              corpo_markdown: disponivel,
              cita_prazo: false,
            },
          }),
      });
    const { execucao_id: id } = await amb.orq.criarExecucao({
      projeto_id: amb.projetoId,
      chamado_id: 'uuid-12',
    });
    await amb.orq.ocioso();
    expect((await amb.banco.ler((r) => r.execucoes.exigir(id))).estado).toBe(
      'aguardando_aprovacao',
    );
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    let e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('aguardando_deploy');
    const ch = amb.chamados.chamados.get('uuid-12')!;
    expect(ch.mensagens.some((m) => m.corpo.includes(`[forja:${id}:conclusao]`))).toBe(true);
    expect(ch.detalhe.status).toBe('em_atendimento');
    await servicos(amb).merge_publicado_producao({}, { execucao_ids: [id] });
    await amb.orq.ocioso();
    e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('concluido');
    expect(ch.detalhe.status).toBe('resolvido');
  });
});

describe('feed — eventos do stream real (fixture c.jsonl) persistidos antes da UI', () => {
  it('o turno publica agente.* da fixture com a etapa certa', async () => {
    amb = await montarAmbiente();
    const fixture = normalizarStream(lerFixture('c.jsonl'), {
      execucaoId: null,
      etapaId: null,
      papelPrincipal: 'condutor',
      turno: 'T1',
    }).eventos;
    amb.runner.roteiro('planejador', { saida: planoExemplo() }).roteiro('condutor_t1', {
      antes: (c) => void execFileSync('sh', ['-c', 'echo ok > ok.txt'], { cwd: c.cwd }),
      checkpoint: true,
      eventos: fixture,
      saida: resumoExemplo(1, ['ok.txt']),
    });
    const { execucao_id: id } = await amb.orq.criarExecucao({
      projeto_id: amb.projetoId,
      chamado_id: 'uuid-12',
    });
    await amb.orq.ocioso();
    const etapa = (await amb.banco.ler((r) => r.etapas.listar(id))).find(
      (x) => x.tipo === 'implementar',
    )!;
    const feed = await servicos(amb).execucao_feed({ id }, { etapa_id: etapa.id, limite: 2000 });
    const tipos = new Set(feed.eventos.map((x) => x.tipo));
    expect(fixture.length).toBeGreaterThan(5);
    expect(
      feed.eventos.filter((x) => x.tipo.startsWith('agente.') || x.tipo.startsWith('subagente.'))
        .length,
    ).toBeGreaterThan(0);
    expect(
      tipos.has('etapa.iniciada') && tipos.has('etapa.finalizada') && tipos.has('git.checkpoint'),
    ).toBe(true);
    expect(feed.eventos.every((x) => x.etapa_id === etapa.id)).toBe(true);
  });
});
