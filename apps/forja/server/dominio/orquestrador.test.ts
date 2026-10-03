import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Jornadas com git real + SQLite: o default de 5 s estoura por carga da suíte,
// não por defeito (mesma regra de orquestrador-jornadas.test.ts).
vi.setConfig({ testTimeout: 60_000 });
import type { EventoForja } from '../../comum/protocolo-eventos';
import {
  aprovarG2,
  montarAmbiente,
  roteiroFeliz,
  TEXTO_RESPOSTA,
  type AmbienteOrquestrador,
} from './apoio-orquestrador.test-apoio';

/**
 * Orquestrador ponta a ponta (specs/forja/03 §12): SQLite real, git real num
 * repositório de brinquedo com `origin` bare, Chamados falso e runner
 * roteirizado. Cada teste é uma jornada do 00 (J1 feliz…).
 */

let amb: AmbienteOrquestrador | null = null;

afterEach(async () => {
  await amb?.limpar();
  amb = null;
});

describe('orquestrador — J1 caminho feliz', () => {
  it('G0 → plano → T1 → coleta → T2 → T3 → G2 → merge_e_push → outbox → concluido', async () => {
    amb = await montarAmbiente();
    const eventos: EventoForja[] = [];
    amb.barramento.assinar((e) => eventos.push(e));
    roteiroFeliz(amb.runner);
    const { execucao_id: id } = await amb.orq.criarExecucao({
      projeto_id: amb.projetoId,
      chamado_id: 'uuid-12',
    });
    await amb.orq.ocioso();
    let e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('aguardando_aprovacao');
    // FJ-032: o revisor relatou `npm test` e o stream do T2 mostra o Bash com exit 0.
    expect(e.nivel_verificacao).toBe('verificado_pelo_revisor');
    expect(e.sha_verificado).toBe(e.sha_atual);

    // Etapas em ordem, sem retrabalho; T2 e T3 retomam a MESMA sessão condutora do T1 (F-02).
    const etapas = await amb.banco.ler((r) => r.etapas.listar(id));
    expect(etapas.map((x) => `${x.tipo}:${x.estado}`)).toEqual([
      'planejar:concluida',
      'implementar:concluida',
      'verificar:concluida',
      'revisar:concluida',
      'relatar:concluida',
    ]);
    const t1 = amb.runner.chamadasDe('condutor_t1')[0]!;
    const t2 = amb.runner.chamadasDe('condutor_t2')[0]!;
    expect(t1.args).toContain('--session-id');
    expect(t2.args).toContain('--resume');
    expect(t2.sessionId).toBe(t1.sessionId);
    // O planejador recebeu o dado do cliente delimitado; o condutor nunca (F-03).
    expect(amb.runner.chamadasDe('planejador')[0]!.prompt).toContain(
      'O relatório precisa mostrar o total do mês.',
    );
    expect(t1.prompt).not.toContain('O relatório precisa mostrar o total do mês.');

    // Rodada de início do outbox: silenciar (já silenciada), atribuir, nota de início.
    const notaInicio = amb.chamados.chamados
      .get('uuid-12')!
      .mensagens.find((m) => m.corpo.includes(`[forja:${id}:inicio]`));
    expect(notaInicio?.visibilidade).toBe('interna');

    // Toda transição publicou `execucao.estado` com o seq do SQLite.
    const estados = eventos.filter((x) => x.tipo === 'execucao.estado').map((x) => x.dados.estado);
    expect(estados).toEqual([
      'na_fila',
      'preparando',
      'planejando',
      'plano_pronto',
      'implementando',
      'verificando',
      'revisando',
      'relatando',
      'aguardando_aprovacao',
    ]);
    const persistidos = await amb.banco.ler((r) =>
      r.eventos.desde(0, { execucao_id: id, tipos: ['execucao.estado'] }),
    );
    expect(persistidos.map((x) => x.seq)).toEqual(
      eventos.filter((x) => x.tipo === 'execucao.estado').map((x) => x.seq),
    );

    // G2 → fila de merge → integração → push → outbox → concluído.
    await aprovarG2(amb, id);
    await amb.orq.ocioso();
    e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('concluido');
    const remotoMain = execFileSync('git', ['rev-parse', 'main'], {
      cwd: amb.remoto,
      encoding: 'utf8',
    }).trim();
    expect(remotoMain).toBe(e.sha_merge);
    const msg = execFileSync('git', ['log', '-1', '--format=%s', 'main'], {
      cwd: amb.remoto,
      encoding: 'utf8',
    }).trim();
    expect(msg).toBe('Chamado #12: Chamado 12');
    const chamado = amb.chamados.chamados.get('uuid-12')!;
    expect(chamado.detalhe.status).toBe('resolvido');
    expect(
      chamado.mensagens.filter((m) => m.corpo.includes(`[forja:${id}:conclusao]`)),
    ).toHaveLength(1);
    expect(
      chamado.mensagens.filter((m) => m.visibilidade === 'publica' && m.corpo === TEXTO_RESPOSTA),
    ).toHaveLength(1);
    // A worktree de execução concluída sai (02 §9).
    expect(e.worktree_dir && existsSync(e.worktree_dir)).toBe(false);
  });
});
