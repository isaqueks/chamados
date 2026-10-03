import { describe, expect, it } from 'vitest';
import type { EstadoSondado, ProcessoParaSondar } from './proc-linux';
import {
  comandoEsperadoDaEtapa,
  reconciliarNoBoot,
  type FontesReconciliacao,
  type SondasReconciliacao,
} from './reconciliacao';

/** Casos de 03 §11 (crash do app, SIGKILL no pai) e 03 §9.5 / 01 §9.1. */

const RAIZ = '/dados/worktrees';

function fontes(parcial: Partial<FontesReconciliacao>): FontesReconciliacao {
  return {
    etapasExecutando: () => [],
    sessoesTerminalAbertas: () => [],
    execucoesAtivas: () => [],
    worktrees: () => [],
    itensMergeIntegrando: () => [],
    outboxEnviando: () => [],
    ...parcial,
  };
}

function sondas(
  estados: Record<number, EstadoSondado>,
  ancestrais: Record<string, boolean | Error> = {},
): SondasReconciliacao & { sondados: ProcessoParaSondar[] } {
  const sondados: ProcessoParaSondar[] = [];
  return {
    sondados,
    sondar: (p) => {
      sondados.push(p);
      return estados[p.pid] ?? 'morto';
    },
    ehAncestral: async (_repo, sha) => {
      const r = ancestrais[sha];
      if (r instanceof Error) throw r;
      return r ?? false;
    },
  };
}

describe('reconciliação no boot', () => {
  it('crash com condutor vivo: mata o grupo PRIMEIRO, depois marca etapa e execução', async () => {
    const s = sondas({ 101: 'vivo' });
    const acoes = await reconciliarNoBoot(
      fontes({
        etapasExecutando: () => [
          {
            etapa_id: 'e1',
            execucao_id: 'x1',
            tipo: 'implementar',
            pid: 101,
            pgid: 101,
            session_id: 's1',
          },
        ],
      }),
      s,
      { raizWorktrees: RAIZ },
    );
    expect(s.sondados).toEqual([{ pid: 101, pgid: 101, comando: 'claude' }]);
    expect(acoes.map((a) => a.tipo)).toEqual([
      'encerrar_grupo',
      'varrer_cwd',
      'etapa_interrompida',
      'execucao_interrompida',
    ]);
    expect(acoes[0]).toMatchObject({ pgid: 101, escada: 'padrao', estado_sondado: 'vivo' });
    expect(acoes[1]).toMatchObject({ etapa_id: 'e1', execucao_id: 'x1' });
    expect(acoes[2]).toMatchObject({ processo: 'vivo', session_id: 's1' });
    expect(acoes[3]).toMatchObject({ recuperacao: 'retomar_agente', etapas: ['e1'] });
  });

  it('filho morreu junto (ou pid reutilizado): só marca interrompido, sem sinal', async () => {
    const acoes = await reconciliarNoBoot(
      fontes({
        etapasExecutando: () => [
          {
            etapa_id: 'e1',
            execucao_id: 'x1',
            tipo: 'revisar',
            pid: 201,
            pgid: 201,
            session_id: 's',
          },
          {
            etapa_id: 'e2',
            execucao_id: 'x2',
            tipo: 'planejar',
            pid: 202,
            pgid: 202,
            session_id: 't',
          },
          {
            etapa_id: 'e3',
            execucao_id: 'x3',
            tipo: 'relatar',
            pid: null,
            pgid: null,
            session_id: 'u',
          },
        ],
      }),
      sondas({ 201: 'morto', 202: 'pid_reutilizado' }),
      { raizWorktrees: RAIZ },
    );
    expect(acoes.filter((a) => a.tipo === 'encerrar_grupo')).toEqual([]);
    expect(acoes.flatMap((a) => (a.tipo === 'etapa_interrompida' ? [a.processo] : []))).toEqual([
      'morto',
      'pid_reutilizado',
      'sem_pid',
    ]);
    // [V S4] o claude morreu mas o Bash dele (setsid) pode ter ficado: varre o cwd mesmo assim.
    expect(acoes.flatMap((a) => (a.tipo === 'varrer_cwd' ? [a.etapa_id] : []))).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
  });

  it('líder morto com netos no grupo (grupo órfão) também leva a escada', async () => {
    const acoes = await reconciliarNoBoot(
      fontes({
        etapasExecutando: () => [
          {
            etapa_id: 'e1',
            execucao_id: 'x1',
            tipo: 'implementar',
            pid: 9,
            pgid: 9,
            session_id: 's',
          },
        ],
      }),
      sondas({ 9: 'grupo_orfao' }),
      { raizWorktrees: RAIZ },
    );
    expect(acoes[0]).toMatchObject({ tipo: 'encerrar_grupo', estado_sondado: 'grupo_orfao' });
  });

  it('verificação recomeça do zero; integrar vai pela regra do merge', async () => {
    expect(comandoEsperadoDaEtapa('verificar')).toBe('sh');
    expect(comandoEsperadoDaEtapa('integrar')).toBe('git');
    const acoes = await reconciliarNoBoot(
      fontes({
        etapasExecutando: () => [
          {
            etapa_id: 'v',
            execucao_id: 'x1',
            tipo: 'verificar',
            pid: 5,
            pgid: 5,
            session_id: null,
          },
          { etapa_id: 'g', execucao_id: 'x2', tipo: 'integrar', pid: 6, pgid: 6, session_id: null },
        ],
      }),
      sondas({ 5: 'vivo' }),
      { raizWorktrees: RAIZ },
    );
    const exec = acoes.filter((a) => a.tipo === 'execucao_interrompida');
    expect(exec).toMatchObject([
      { execucao_id: 'x1', recuperacao: 'refazer_verificacao' },
      { execucao_id: 'x2', recuperacao: 'reconciliar_merge' },
    ]);
  });

  it('PTY órfão: escada de PTY; a assumida é sinalizada como tal', async () => {
    const acoes = await reconciliarNoBoot(
      fontes({
        sessoesTerminalAbertas: () => [
          {
            sessao_terminal_id: 't1',
            tipo: 'assumida',
            pid: 77,
            pgid: 77,
            execucao_id: 'x1',
            session_id_claude: 's1',
          },
          {
            sessao_terminal_id: 't2',
            tipo: 'livre',
            pid: 78,
            pgid: 78,
            execucao_id: null,
            session_id_claude: null,
          },
        ],
      }),
      sondas({ 77: 'vivo', 78: 'morto' }),
      { raizWorktrees: RAIZ },
    );
    expect(acoes).toEqual([
      expect.objectContaining({
        tipo: 'encerrar_grupo',
        origem: 'terminal',
        escada: 'pty',
        pid: 77,
      }),
      expect.objectContaining({
        tipo: 'sessao_terminal_encerrada',
        assumida: true,
        processo: 'vivo',
      }),
      expect.objectContaining({
        tipo: 'sessao_terminal_encerrada',
        assumida: false,
        processo: 'morto',
      }),
    ]);
  });

  it('worktrees: órfã, ausente, prunable e fora da raiz da Forja', async () => {
    const acoes = await reconciliarNoBoot(
      fontes({
        execucoesAtivas: () => [
          { execucao_id: 'x1', caminho_worktree: `${RAIZ}/p/1-aaaa` },
          { execucao_id: 'x2', caminho_worktree: `${RAIZ}/p/2-bbbb` },
        ],
        itensMergeIntegrando: () => [
          {
            item_id: 'i1',
            execucao_id: 'x9',
            sha_merge: null,
            repositorio: '/repo',
            ref_destino: 'refs/heads/main',
            caminho_worktree: `${RAIZ}/p/_integracao/i1`,
          },
        ],
        worktrees: () => [
          { repositorio: '/repo', caminho: '/repo', branch: 'main', prunable: false },
          {
            repositorio: '/repo',
            caminho: `${RAIZ}/p/1-aaaa`,
            branch: 'forja/c-1',
            prunable: false,
          },
          {
            repositorio: '/repo',
            caminho: `${RAIZ}/p/3-cccc`,
            branch: 'forja/c-3',
            prunable: false,
          },
          { repositorio: '/repo', caminho: `${RAIZ}/p/4-dddd`, branch: null, prunable: true },
          {
            repositorio: '/repo',
            caminho: `${RAIZ}/p/_integracao/i1`,
            branch: null,
            prunable: false,
          },
        ],
      }),
      sondas({}),
      { raizWorktrees: RAIZ },
    );
    expect(
      acoes.filter((a) => a.tipo.startsWith('worktree') || a.tipo === 'podar_worktrees'),
    ).toEqual([
      {
        tipo: 'worktree_orfa',
        repositorio: '/repo',
        caminho: `${RAIZ}/p/3-cccc`,
        branch: 'forja/c-3',
      },
      { tipo: 'worktree_ausente', execucao_id: 'x2', caminho: `${RAIZ}/p/2-bbbb` },
      { tipo: 'podar_worktrees', repositorio: '/repo' },
    ]);
  });

  it('fila de merge (03 §9.5): nunca re-mergeia o que já está na ref', async () => {
    const item = (item_id: string, sha_merge: string | null) => ({
      item_id,
      execucao_id: `x-${item_id}`,
      sha_merge,
      repositorio: '/repo',
      ref_destino: 'refs/remotes/origin/main',
      caminho_worktree: null,
    });
    const acoes = await reconciliarNoBoot(
      fontes({
        itensMergeIntegrando: () => [
          item('a', 'sha-ja-entrou'),
          item('b', 'sha-nao-entrou'),
          item('c', null),
          item('d', 'sha-erro'),
        ],
      }),
      sondas(
        {},
        { 'sha-ja-entrou': true, 'sha-nao-entrou': false, 'sha-erro': new Error('sem rede') },
      ),
      { raizWorktrees: RAIZ },
    );
    expect(acoes.map((a) => a.tipo)).toEqual([
      'item_merge_mergeado',
      'item_merge_recomecar',
      'item_merge_recomecar',
      'item_merge_indeterminado',
    ]);
    expect(acoes[3]).toMatchObject({ erro: 'sem rede' });
  });

  it('outbox em enviando → checagem "já feito?" antes de reenviar (03 §9.2)', async () => {
    const acoes = await reconciliarNoBoot(
      fontes({
        outboxEnviando: async () => [
          { outbox_id: 'o1', execucao_id: 'x1', passo: 'mensagem_publica' },
        ],
      }),
      sondas({}),
      { raizWorktrees: RAIZ },
    );
    expect(acoes).toEqual([
      {
        tipo: 'outbox_checar_ja_feito',
        outbox_id: 'o1',
        execucao_id: 'x1',
        passo: 'mensagem_publica',
      },
    ]);
  });

  it('a ordem global é: matar → varrer → marcar → terminal → worktrees → merge → outbox', async () => {
    const acoes = await reconciliarNoBoot(
      fontes({
        outboxEnviando: () => [{ outbox_id: 'o', execucao_id: 'x', passo: 'nota_interna' }],
        itensMergeIntegrando: () => [
          {
            item_id: 'i',
            execucao_id: 'x',
            sha_merge: null,
            repositorio: '/r',
            ref_destino: 'main',
            caminho_worktree: null,
          },
        ],
        sessoesTerminalAbertas: () => [
          {
            sessao_terminal_id: 't',
            tipo: 'livre',
            pid: 3,
            pgid: 3,
            execucao_id: null,
            session_id_claude: null,
          },
        ],
        etapasExecutando: () => [
          {
            etapa_id: 'e',
            execucao_id: 'x',
            tipo: 'implementar',
            pid: 2,
            pgid: 2,
            session_id: 's',
          },
        ],
      }),
      sondas({ 2: 'vivo', 3: 'vivo' }),
      { raizWorktrees: RAIZ },
    );
    expect(acoes.map((a) => a.tipo)).toEqual([
      'encerrar_grupo',
      'encerrar_grupo',
      'varrer_cwd',
      'etapa_interrompida',
      'execucao_interrompida',
      'sessao_terminal_encerrada',
      'item_merge_recomecar',
      'outbox_checar_ja_feito',
    ]);
  });
});
