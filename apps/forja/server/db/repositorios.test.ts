import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configProjetoDeResolvida, detectadoVazio } from '../../comum/config-projeto';
import {
  ambienteTemporario,
  configDeTeste,
  semear,
  type Ambiente,
  type Semente,
} from './apoio-testes';
import { ExecucaoSchema } from './entidades/execucao';
import { ErroEstado, ErroJsonInvalido, ErroRestricao } from './erros';
import { novoId } from './ids';
import { configDoProjeto } from './repositorios/projeto';

let amb: Ambiente;
let s: Semente;

beforeEach(async () => {
  amb = await ambienteTemporario();
  s = await semear(amb.banco);
});

afterEach(async () => {
  await amb.limpar();
});

const SHA = 'a'.repeat(40);

/** SQL cru pela fila do banco (erros traduzidos), contornando as checagens dos repositórios. */
function bruto(sql: string, params: unknown[] = []): Promise<unknown> {
  return amb.banco.transacao((_r, m) => m.query(sql, params));
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('era para falhar');
    },
    (e: unknown) => e,
  );
}

async function invariante(p: Promise<unknown>): Promise<string> {
  const e = await falha(p);
  expect(e).toBeInstanceOf(ErroRestricao);
  return (e as ErroRestricao).invariante;
}

describe('conexao_chamados (02 §4.1)', () => {
  it('nome único; papel só operador/admin; login grava identidade e envelope', async () => {
    const { banco } = amb;
    expect(
      await invariante(
        banco.transacao((r) =>
          r.conexoes.criar({
            nome: 'dev-local',
            url_base: 'http://localhost:3001',
            ambiente: 'dev',
            email: 'x@y',
            local_senha: 'arquivo',
          }),
        ),
      ),
    ).toBe('unico');
    const login = {
      usuario_id: 'u1',
      usuario_nome: 'Forja',
      token_cifrado: 'v1:iv:tag:cifra',
      token_expira_em: null,
    };
    expect(
      await invariante(
        banco.transacao((r) => r.conexoes.gravarLogin(s.conexaoId, { ...login, papel: 'cliente' })),
      ),
    ).toBe('check');
    await banco.transacao((r) =>
      r.conexoes.gravarLogin(s.conexaoId, { ...login, papel: 'operador' }),
    );
    const c = await banco.ler((r) => r.conexoes.exigir(s.conexaoId));
    expect(c).toMatchObject({ papel: 'operador', token_cifrado: 'v1:iv:tag:cifra' });
    expect(c.ultimo_login_em).toBe('2026-10-02T12:00:00.000Z');
    await banco.transacao((r) => r.conexoes.limparToken(s.conexaoId));
    expect((await banco.ler((r) => r.conexoes.exigir(s.conexaoId))).token_cifrado).toBeNull();
  });
});

describe('projeto + mapeamento_sistema (02 §4.2, §4.3)', () => {
  it('config v2 ida e volta pelas colunas (FJ-030 §1)', async () => {
    const p = await amb.banco.ler((r) => r.projetos.exigir(s.projetoId));
    expect(configDoProjeto(p)).toEqual(configProjetoDeResolvida('Acme', configDeTeste()));
    expect(p.ativo).toBe(true);
    expect(p.config_versao).toBe(2);
    expect(p.detectado).toBeNull();
  });

  it('só repo_dir: branch, sistemas e avançado ficam nulos (automáticos)', async () => {
    const p = await amb.banco.transacao((r) =>
      r.projetos.criar({
        slug: 'b',
        conexao_id: s.conexaoId,
        config: { versao: 2, nome: 'B', repo_dir: '/tmp/b' },
      }),
    );
    expect(p).toMatchObject({ nome: 'B', branch_destino: null, sistemas: null, avancado: null });
    expect(configDoProjeto(p)).toEqual({ versao: 2, nome: 'B', repo_dir: '/tmp/b' });
  });

  it('avançado fora do schema zod (estrito) é recusado na escrita', async () => {
    const config = configProjetoDeResolvida('Acme', configDeTeste());
    (config.avancado as Record<string, unknown>).gatez = { plano: 'sempre' };
    expect(
      await falha(amb.banco.transacao((r) => r.projetos.atualizar(s.projetoId, { config }))),
    ).toBeInstanceOf(ErroJsonInvalido);
  });

  it('JSON gravado fora do formato = erro explícito na leitura (nunca default)', async () => {
    await amb.banco.ds.query(`UPDATE "projeto" SET "avancado" = '{"gates":{"plano":"talvez"}}'`);
    expect(await falha(amb.banco.ler((r) => r.projetos.exigir(s.projetoId)))).toBeInstanceOf(
      ErroJsonInvalido,
    );
  });

  it('trocar de pasta descarta o detectado e a URL do remoto confirmada', async () => {
    const { banco } = amb;
    await banco.transacao(async (r) => {
      await r.projetos.gravarDetectado(s.projetoId, detectadoVazio('/tmp/repo-de-teste'));
      await r.projetos.fixarRemotoUrl(s.projetoId, 'git@exemplo:acme.git');
    });
    const p = await banco.transacao((r) =>
      r.projetos.atualizar(s.projetoId, {
        config: { versao: 2, nome: 'Acme', repo_dir: '/tmp/outro' },
      }),
    );
    expect(p.detectado).toBeNull();
    expect(p.remoto_url).toBeNull();
  });

  it('definirSistemas substitui o conjunto; um sistema aponta para um projeto só', async () => {
    const { banco } = amb;
    await banco.transacao((r) =>
      r.projetos.definirSistemas(s.projetoId, [
        { sistema_nome: 'ERP Web' },
        { sistema_nome: 'App' },
      ]),
    );
    const maps = await banco.transacao((r) =>
      r.projetos.definirSistemas(s.projetoId, [
        { sistema_nome: 'ERP Web', sistema_alvo_id: 'sa-1' },
      ]),
    );
    expect(maps.map((m) => [m.sistema_nome, m.sistema_alvo_id])).toEqual([['ERP Web', 'sa-1']]);
    const porId = await banco.ler((r) =>
      r.projetos.projetoDoSistema(s.conexaoId, { sistema_alvo_id: 'sa-1' }),
    );
    const porNome = await banco.ler((r) =>
      r.projetos.projetoDoSistema(s.conexaoId, { sistema_nome: 'ERP Web' }),
    );
    expect(porId?.id).toBe(s.projetoId);
    expect(porNome?.id).toBe(s.projetoId);

    const outro = await banco.transacao((r) =>
      r.projetos.criar({
        nome: 'Outro',
        slug: 'outro',
        conexao_id: s.conexaoId,
        config: configProjetoDeResolvida('Outro', configDeTeste()),
      }),
    );
    expect(
      await invariante(
        banco.transacao((r) => r.projetos.definirSistemas(outro.id, [{ sistema_nome: 'ERP Web' }])),
      ),
    ).toBe('unico');
  });
});

describe('chamado_cache (02 §4.4)', () => {
  it('upsert pela chave remota mantém o id e o que só o detalhe informa', async () => {
    const { banco } = amb;
    await banco.transacao((r) =>
      r.chamados.gravarDetalhe(s.chamadoCacheId, {
        sinais: { tem_spec_ia: true, tem_diagnostico_ia: false, tem_pr_ia: false, branch_ia: null },
        ia_silenciada: true,
        ultima_mensagem_id: 'm9',
      }),
    );
    amb.relogio.avancar(1000);
    const c = await banco.transacao((r) =>
      r.chamados.gravarDaLista({
        conexao_id: s.conexaoId,
        chamado_id: 'uuid-chamado-42',
        numero: 42,
        titulo: 'Título novo',
        status: 'aguardando_cliente',
        natureza: 'alteracao',
        prioridade: 'alta',
      }),
    );
    expect(c.id).toBe(s.chamadoCacheId);
    expect(c).toMatchObject({
      titulo: 'Título novo',
      status: 'aguardando_cliente',
      ia_silenciada: true,
      ultima_mensagem_id: 'm9',
      sincronizado_em: '2026-10-02T12:00:01.000Z',
    });
    expect(c.sinais.tem_spec_ia).toBe(true);
    const lista = await banco.ler((r) =>
      r.chamados.listar(s.conexaoId, { status: ['aguardando_cliente'] }),
    );
    expect(lista).toHaveLength(1);
  });

  it('status fora do enum do Chamados → CHECK', async () => {
    expect(
      await invariante(
        amb.banco.transacao((r) =>
          r.chamados.gravarDaLista({
            conexao_id: s.conexaoId,
            chamado_id: 'x',
            numero: 7,
            titulo: 't',
            status: 'inventado' as never,
            natureza: 'problema',
            prioridade: 'baixa',
          }),
        ),
      ),
    ).toBe('check');
  });
});

describe('execucao (02 §4.6; I-1, I-6, I-9)', () => {
  it('I-1: segunda execução ativa do mesmo chamado é recusada (app e índice)', async () => {
    const { banco } = amb;
    const nova = {
      conexao_id: s.conexaoId,
      chamado_id: s.execucao.chamado_id,
      chamado_cache_id: s.chamadoCacheId,
      projeto_id: s.projetoId,
      numero: 42,
      config_snapshot: configDeTeste(),
    };
    expect(await invariante(banco.transacao((r) => r.execucoes.criar(nova)))).toBe('I-1');
    // Rede de segurança: INSERT direto, sem a checagem do repositório.
    const bruto = { ...s.execucao, id: novoId(), tentativa: 2 };
    expect(
      await invariante(banco.transacao((_r, m) => m.insert(ExecucaoSchema, bruto as never))),
    ).toBe('I-1');

    await banco.transacao((r) => r.execucoes.mudarEstado(s.execucao.id, 'descartado'));
    const segunda = await banco.transacao((r) => r.execucoes.criar(nova));
    expect(segunda.tentativa).toBe(2);
    expect(
      await banco.ler((r) => r.execucoes.tentativas(s.conexaoId, nova.chamado_id)),
    ).toHaveLength(2);
  });

  it('mudarEstado: lateral guarda estado_anterior, terminal fecha e não muda mais', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    let { atual } = await banco.transacao((r) => r.execucoes.mudarEstado(id, 'implementando'));
    expect(atual.iniciado_em).toBe('2026-10-02T12:00:00.000Z');
    ({ atual } = await banco.transacao((r) => r.execucoes.mudarEstado(id, 'pausado_usuario')));
    expect(atual.estado_anterior).toBe('implementando');
    ({ atual } = await banco.transacao((r) =>
      r.execucoes.mudarEstado(id, 'pausado_cota', { motivo: 'cota_overage', motivo_texto: 'cota' }),
    ));
    expect(atual.estado_anterior).toBe('implementando');
    expect(atual.motivo_estado).toBe('cota_overage');
    ({ atual } = await banco.transacao((r) => r.execucoes.mudarEstado(id, 'implementando')));
    expect(atual.estado_anterior).toBeNull();
    ({ atual } = await banco.transacao((r) =>
      r.execucoes.mudarEstado(id, 'cancelado', { motivo: 'humano_encerrou' }),
    ));
    expect(atual.concluido_em).not.toBeNull();
    expect(
      await falha(banco.transacao((r) => r.execucoes.mudarEstado(id, 'na_fila'))),
    ).toBeInstanceOf(ErroEstado);
  });

  it('I-9: lateral sem estado_anterior é recusado pelo CHECK', async () => {
    expect(
      await invariante(
        bruto(`UPDATE "execucao" SET "estado" = 'falhou' WHERE "id" = ?`, [s.execucao.id]),
      ),
    ).toBe('I-9');
  });

  it('I-6: worktree e branch exclusivas entre execuções ativas', async () => {
    const { banco } = amb;
    const outra = await semear(banco, 43);
    await banco.transacao((r) =>
      r.execucoes.atualizar(s.execucao.id, { worktree_dir: '/w/42', branch: 'forja/chamado-42-x' }),
    );
    expect(
      await invariante(
        banco.transacao((r) => r.execucoes.atualizar(outra.execucao.id, { worktree_dir: '/w/42' })),
      ),
    ).toBe('I-6');
    expect(
      await invariante(
        banco.transacao((r) =>
          r.execucoes.atualizar(outra.execucao.id, { branch: 'forja/chamado-42-x' }),
        ),
      ),
    ).toBe('I-6');
  });

  it('custo em micro-USD inteiro, ciclos, filtros e contagem', async () => {
    const { banco } = amb;
    await banco.transacao(async (r) => {
      await r.execucoes.somarCusto(s.execucao.id, 1_250_000);
      await r.execucoes.somarCusto(s.execucao.id, 3);
      await r.execucoes.incrementarCiclos(s.execucao.id, { automatico: true });
      await r.execucoes.incrementarCiclos(s.execucao.id, { automatico: false });
    });
    const e = await banco.ler((r) => r.execucoes.exigir(s.execucao.id));
    expect(e.custo_micro_usd).toBe(1_250_003);
    expect([e.ciclo_auto, e.ciclo_total]).toEqual([1, 2]);
    expect(
      await falha(banco.transacao((r) => r.execucoes.somarCusto(s.execucao.id, 0.5))),
    ).toBeInstanceOf(RangeError);
    expect(
      await banco.ler((r) => r.execucoes.contar({ projeto_id: s.projetoId, ativas: true })),
    ).toBe(1);
    expect(await banco.ler((r) => r.execucoes.contar({ ativas: false }))).toBe(0);
    expect(e.config_snapshot).toEqual(configDeTeste());
  });

  it('apagarHistorico: só terminal, e leva as filhas em cascata', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    await banco.transacao(async (r) => {
      const etapa = await r.etapas.criar({
        execucao_id: id,
        tipo: 'planejar',
        ciclo: 0,
        session_id: 's1',
      });
      const art = await r.artefatos.criar({
        execucao_id: id,
        etapa_id: etapa.id,
        tipo: 'plano',
        conteudo: { a: 1 },
      });
      await r.comentarios.criar({
        execucao_id: id,
        artefato_id: art.id,
        alvo: 'plano',
        texto: 'x',
        ciclo_destino: 1,
      });
      await r.aprovacoes.registrar({
        execucao_id: id,
        tipo: 'final',
        decisao: 'aprovado',
        patch_id: 'p',
        sha: SHA,
        artefato_id: art.id,
      });
      await r.eventos.acrescentar({
        execucao_id: id,
        etapa_id: etapa.id,
        tipo: 'git.checkpoint',
        nivel: 'info',
        resumo: 'c',
        dados: { sha: SHA, passo: null, mensagem: 'm', arquivos: 1 },
      });
      await r.outbox.criarRodada(id, 0, [{ passo: 'nota_interna' }]);
    });
    expect(await falha(banco.transacao((r) => r.execucoes.apagarHistorico(id)))).toBeInstanceOf(
      ErroEstado,
    );
    await banco.transacao((r) => r.execucoes.mudarEstado(id, 'descartado'));
    await banco.transacao((r) => r.execucoes.apagarHistorico(id));
    for (const t of ['etapa', 'artefato', 'comentario', 'aprovacao', 'evento', 'outbox_chamado']) {
      const [{ n }] = (await banco.ds.query(`SELECT count(*) AS n FROM "${t}"`)) as [{ n: number }];
      expect(n, t).toBe(0);
    }
  });
});

describe('etapa (02 §4.7; I-2)', () => {
  it('numera n por execução; I-2 por session_id executando; finalizar libera a sessão', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    const e1 = await banco.transacao((r) =>
      r.etapas.criar({
        execucao_id: id,
        tipo: 'implementar',
        ciclo: 1,
        papel: 'condutor',
        session_id: 'sess-1',
      }),
    );
    expect(e1.n).toBe(1);
    expect(
      await invariante(
        banco.transacao((r) =>
          r.etapas.criar({
            execucao_id: id,
            tipo: 'revisar',
            ciclo: 1,
            papel: 'condutor',
            session_id: 'sess-1',
          }),
        ),
      ),
    ).toBe('I-2');
    await banco.transacao(async (r) => {
      await r.etapas.registrarProcesso(e1.id, { pid: 100, pgid: 100 });
      await r.etapas.finalizar(e1.id, {
        estado: 'concluida',
        motivo_fim: 'concluido',
        custo_micro_usd: 10,
        model_usage: { 'claude-opus-5-5': { inputTokens: 1 } },
      });
    });
    expect(
      await falha(
        banco.transacao((r) =>
          r.etapas.finalizar(e1.id, { estado: 'falhou', motivo_fim: 'timeout' }),
        ),
      ),
    ).toBeInstanceOf(ErroEstado);
    const e2 = await banco.transacao((r) =>
      r.etapas.criar({
        execucao_id: id,
        tipo: 'revisar',
        ciclo: 1,
        papel: 'condutor',
        session_id: 'sess-1',
        retomada: true,
      }),
    );
    expect(e2.n).toBe(2);
    expect((await banco.ler((r) => r.etapas.executando())).map((e) => e.id)).toEqual([e2.id]);
    const lida = await banco.ler((r) => r.etapas.exigir(e1.id));
    expect(lida).toMatchObject({
      pid: 100,
      estado: 'concluida',
      retomada: false,
      fim: '2026-10-02T12:00:00.000Z',
    });
    expect(lida.model_usage).toEqual({ 'claude-opus-5-5': { inputTokens: 1 } });
    expect((await banco.ler((r) => r.etapas.ultima(id, 'implementar')))?.id).toBe(e1.id);
  });

  it('etapa do app não tem papel nem session_id (CHECK)', async () => {
    expect(
      await invariante(
        amb.banco.transacao((r) =>
          r.etapas.criar({
            execucao_id: s.execucao.id,
            tipo: 'verificar',
            ciclo: 1,
            session_id: 'x',
          }),
        ),
      ),
    ).toBe('check');
  });
});

describe('artefato (02 §4.9)', () => {
  it('versiona por (execucao, tipo), calcula sha256 do conteúdo e acha o print antes', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    const [v1, v2] = await banco.transacao(async (r) => [
      await r.artefatos.criar({
        execucao_id: id,
        tipo: 'plano',
        contrato: 'plano.v1',
        conteudo: { objetivo: 'x' },
      }),
      await r.artefatos.criar({
        execucao_id: id,
        tipo: 'plano',
        contrato: 'plano.v1',
        conteudo: { objetivo: 'y' },
        editado_por_humano: true,
      }),
    ]);
    expect([v1!.versao, v2!.versao]).toEqual([1, 2]);
    expect(v1!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await banco.ler((r) => r.artefatos.ultimaVersao(id, 'plano')))?.id).toBe(v2!.id);

    await banco.transacao((r) =>
      r.artefatos.criar({
        execucao_id: id,
        tipo: 'evidencia',
        caminho: 'evidencias/antes/UI1.png',
        sha256: 'f'.repeat(64),
        tamanho_bytes: 1234,
        sha_git: SHA,
        conteudo: { momento: 'antes', tela_id: 'UI1', rota: '/clientes' },
      }),
    );
    expect(await banco.ler((r) => r.artefatos.evidenciaAntes(id, '/clientes', SHA))).not.toBeNull();
    expect(
      await banco.ler((r) => r.artefatos.evidenciaAntes(id, '/clientes', 'b'.repeat(40))),
    ).toBeNull();
  });

  it('CHECKs: conteúdo ou caminho; patch_id só em diff; arquivo exige assinatura', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    expect(
      await invariante(
        banco.transacao((r) =>
          r.artefatos.criar({ execucao_id: id, tipo: 'diff', sha256: 'x', tamanho_bytes: 0 }),
        ),
      ),
    ).toBe('check');
    expect(
      await invariante(
        banco.transacao((r) =>
          r.artefatos.criar({ execucao_id: id, tipo: 'relatorio', conteudo: {}, patch_id: 'p' }),
        ),
      ),
    ).toBe('check');
    expect(
      await falha(
        banco.transacao((r) =>
          r.artefatos.criar({ execucao_id: id, tipo: 'diff', caminho: 'a.patch' }),
        ),
      ),
    ).toBeInstanceOf(TypeError);
  });
});

describe('aprovacao (02 §4.11; I-3)', () => {
  it('final exige patch_id + sha; só uma vigente; invalidar libera e limpa o ponteiro', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    expect(
      await invariante(
        banco.transacao((r) =>
          r.aprovacoes.registrar({ execucao_id: id, tipo: 'final', decisao: 'aprovado' }),
        ),
      ),
    ).toBe('I-3');
    const a1 = await banco.transacao((r) =>
      r.aprovacoes.registrar({
        execucao_id: id,
        tipo: 'final',
        decisao: 'aprovado',
        patch_id: 'p1',
        sha: SHA,
        aprovado_sem_prints: true,
        validacao_resposta: {
          tecnico: [],
          promessa: [],
          lexico: [],
          disponibilidade: [],
          ok: true,
          publicar_mesmo_assim: false,
        },
      }),
    );
    expect((await banco.ler((r) => r.execucoes.exigir(id))).aprovacao_vigente_id).toBe(a1.id);
    expect(
      await invariante(
        banco.transacao((r) =>
          r.aprovacoes.registrar({
            execucao_id: id,
            tipo: 'reaprovacao',
            decisao: 'aprovado',
            patch_id: 'p2',
            sha: SHA,
          }),
        ),
      ),
    ).toBe('I-3');
    // Rede de segurança: INSERT direto viola o único parcial.
    expect(
      await invariante(
        bruto(
          `INSERT INTO "aprovacao" ("id","execucao_id","tipo","decisao","patch_id","sha","aprovado_sem_prints","em_bloco","criado_em","atualizado_em")
           VALUES (?, ?, 'reaprovacao', 'aprovado', 'p2', ?, 0, 0, 'x', 'x')`,
          [novoId(), id, SHA],
        ),
      ),
    ).toBe('I-3');

    await banco.transacao((r) => r.aprovacoes.invalidar(a1.id, 'patch-id mudou na integração'));
    expect((await banco.ler((r) => r.execucoes.exigir(id))).aprovacao_vigente_id).toBeNull();
    const a2 = await banco.transacao((r) =>
      r.aprovacoes.registrar({
        execucao_id: id,
        tipo: 'reaprovacao',
        decisao: 'aprovado',
        patch_id: 'p2',
        sha: SHA,
      }),
    );
    expect((await banco.ler((r) => r.aprovacoes.vigente(id)))?.id).toBe(a2.id);
    expect(await banco.ler((r) => r.aprovacoes.listar(id))).toHaveLength(2);
  });

  it('em bloco só para plano com lote; sem prints só em final', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    expect(
      await invariante(
        banco.transacao((r) =>
          r.aprovacoes.registrar({
            execucao_id: id,
            tipo: 'plano',
            decisao: 'aprovado',
            em_bloco: true,
          }),
        ),
      ),
    ).toBe('check');
    expect(
      await invariante(
        banco.transacao((r) =>
          r.aprovacoes.registrar({
            execucao_id: id,
            tipo: 'plano',
            decisao: 'aprovado',
            aprovado_sem_prints: true,
          }),
        ),
      ),
    ).toBe('check');
    const lote = await banco.transacao((r) =>
      r.lotes.criar({ projeto_id: s.projetoId, concorrencia_planos: 3, concorrencia_impl: 2 }),
    );
    expect(lote.nome).toMatch(/^Lote \d{2}\/10\/2026 \d{2}:00$/);
    const a = await banco.transacao((r) =>
      r.aprovacoes.registrar({
        execucao_id: id,
        tipo: 'plano',
        decisao: 'aprovado',
        em_bloco: true,
        lote_id: lote.id,
      }),
    );
    expect(a.em_bloco).toBe(true);
  });
});

describe('lote e comentario (02 §4.5, §4.10)', () => {
  it('lote encerra com data; comentários pendentes até o ciclo e consumidos uma vez', async () => {
    const { banco } = amb;
    const lote = await banco.transacao((r) =>
      r.lotes.criar({
        projeto_id: s.projetoId,
        nome: 'L',
        concorrencia_planos: 3,
        concorrencia_impl: 2,
      }),
    );
    expect(await banco.ler((r) => r.lotes.listar({ ativos: true }))).toHaveLength(1);
    const enc = await banco.transacao((r) => r.lotes.mudarEstado(lote.id, 'encerrado'));
    expect(enc.encerrado_em).not.toBeNull();
    expect(await banco.ler((r) => r.lotes.listar({ ativos: true }))).toHaveLength(0);

    const id = s.execucao.id;
    const [c1] = await banco.transacao(async (r) => [
      await r.comentarios.criar({
        execucao_id: id,
        alvo: 'diff',
        arquivo: 'a.ts',
        linha: 3,
        texto: 'renomeie',
        ciclo_destino: 1,
      }),
      await r.comentarios.criar({
        execucao_id: id,
        alvo: 'plano',
        texto: 'depois',
        ciclo_destino: 2,
      }),
    ]);
    expect((await banco.ler((r) => r.comentarios.pendentes(id, 1))).map((c) => c.id)).toEqual([
      c1!.id,
    ]);
    await banco.transacao((r) => r.comentarios.marcarConsumidos([c1!.id]));
    expect(await banco.ler((r) => r.comentarios.pendentes(id, 2))).toHaveLength(1);
  });
});

describe('item_fila_merge (02 §4.12; I-5)', () => {
  async function aprovar(execucaoId: string): Promise<string> {
    const a = await amb.banco.transacao((r) =>
      r.aprovacoes.registrar({
        execucao_id: execucaoId,
        tipo: 'final',
        decisao: 'aprovado',
        patch_id: 'p',
        sha: SHA,
      }),
    );
    return a.id;
  }

  it('ordem por fila, 1 item ativo por execução, 1 em processamento por fila', async () => {
    const { banco } = amb;
    const outra = await semear(banco, 43);
    const i1 = await banco.transacao(async (r) =>
      r.filaMerge.enfileirar({
        projeto_id: s.projetoId,
        branch_destino: 'main',
        execucao_id: s.execucao.id,
        aprovacao_id: await aprovar(s.execucao.id),
      }),
    );
    const i2 = await banco.transacao(async (r) =>
      r.filaMerge.enfileirar({
        projeto_id: s.projetoId,
        branch_destino: 'main',
        execucao_id: outra.execucao.id,
        aprovacao_id: await aprovar(outra.execucao.id),
      }),
    );
    expect([i1.ordem, i2.ordem]).toEqual([1, 2]);
    expect(
      await invariante(
        banco.transacao((r) =>
          r.filaMerge.enfileirar({
            projeto_id: s.projetoId,
            branch_destino: 'main',
            execucao_id: s.execucao.id,
            aprovacao_id: i1.aprovacao_id,
          }),
        ),
      ),
    ).toBe('I-5');

    // `proximo` ignora item de execução fora de `na_fila_merge`/`integrando`.
    expect(await banco.ler((r) => r.filaMerge.proximo(s.projetoId, 'main'))).toBeNull();
    await banco.transacao(async (r) => {
      await r.m.update(ExecucaoSchema, { id: outra.execucao.id }, { estado: 'na_fila_merge' });
    });
    expect((await banco.ler((r) => r.filaMerge.proximo(s.projetoId, 'main')))?.id).toBe(i2.id);
    await banco.transacao(async (r) => {
      await r.m.update(ExecucaoSchema, { id: s.execucao.id }, { estado: 'na_fila_merge' });
    });
    expect((await banco.ler((r) => r.filaMerge.proximo(s.projetoId, 'main')))?.id).toBe(i1.id);
    await banco.transacao((r) =>
      r.filaMerge.mudarEstado(i1.id, 'integrando', { sha_destino_antes: SHA }),
    );
    expect(await banco.ler((r) => r.filaMerge.proximo(s.projetoId, 'main'))).toBeNull();
    expect(
      await invariante(banco.transacao((r) => r.filaMerge.mudarEstado(i2.id, 'verificando'))),
    ).toBe('I-5');
    expect((await banco.ler((r) => r.filaMerge.emProcessamento())).map((i) => i.id)).toEqual([
      i1.id,
    ]);

    await banco.transacao((r) =>
      r.filaMerge.mudarEstado(i1.id, 'concluido', {
        modo_avanco: 'update_ref',
        arquivos_em_conflito: [],
      }),
    );
    const fila = await banco.transacao((r) => r.filaMerge.reordenar(s.projetoId, 'main', [i2.id]));
    expect(fila.map((i) => i.id)).toEqual([i2.id]);
    expect((await banco.ler((r) => r.filaMerge.proximo(s.projetoId, 'main')))?.id).toBe(i2.id);
  });
});

describe('outbox_chamado (02 §4.13; I-4)', () => {
  it('rodada em ordem; passo repetido recusado; cabeça retida segura a fila', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    const linhas = await banco.transacao((r) =>
      r.outbox.criarRodada(id, 0, [
        { passo: 'nota_interna', corpo: 'n' },
        { passo: 'mensagem_publica', corpo: 'oi', corpo_hash: 'h', estado: 'retido' },
        { passo: 'status_resolvido', status_alvo: 'resolvido', motivo: 'implementado_via_forja' },
      ]),
    );
    expect(linhas.map((l) => l.ordem)).toEqual([0, 1, 2]);
    expect(
      await invariante(
        banco.transacao((r) => r.outbox.criarRodada(id, 0, [{ passo: 'nota_interna' }])),
      ),
    ).toBe('I-4');
    expect(
      await invariante(
        bruto(
          `INSERT INTO "outbox_chamado" ("id","execucao_id","passo","estado","rodada","ordem","tentativas","criado_em","atualizado_em")
           VALUES (?, ?, 'nota_interna', 'pendente', 0, 9, 0, 'x', 'x')`,
          [novoId(), id],
        ),
      ),
    ).toBe('I-4');
    // Rodada 1 (pergunta ao cliente) pode repetir o passo.
    await banco.transacao((r) =>
      r.outbox.criarRodada(id, 1, [{ passo: 'pergunta_publica', corpo: '?' }]),
    );

    let prontos = await banco.ler((r) => r.outbox.prontos());
    expect(prontos.map((l) => [l.rodada, l.passo])).toEqual([
      [0, 'nota_interna'],
      [1, 'pergunta_publica'],
    ]);
    const [nota] = linhas;
    await banco.transacao(async (r) => {
      await r.outbox.marcarEnviando(nota!.id);
      await r.outbox.marcarEnviado(nota!.id, { id_remoto: 'msg-1', ultimo_http: 201 });
    });
    prontos = await banco.ler((r) => r.outbox.prontos());
    expect(prontos.map((l) => l.passo)).toEqual(['pergunta_publica']);

    expect(await banco.transacao((r) => r.outbox.liberarRetidos(id))).toBe(1);
    const publica = linhas[1]!;
    await banco.transacao(async (r) => {
      await r.outbox.marcarEnviando(publica.id);
      await r.outbox.registrarFalha(publica.id, {
        erro: '503',
        ultimo_http: 503,
        proxima_em: '2026-10-02T12:01:00.000Z',
      });
    });
    expect((await banco.ler((r) => r.outbox.prontos())).map((l) => l.passo)).toEqual([
      'pergunta_publica',
    ]);
    amb.relogio.avancar(60_000);
    expect((await banco.ler((r) => r.outbox.prontos())).map((l) => l.passo)).toEqual([
      'mensagem_publica',
      'pergunta_publica',
    ]);
    expect((await banco.ler((r) => r.outbox.exigir(publica.id))).tentativas).toBe(1);
    expect(await banco.ler((r) => r.outbox.rodadaConcluida(id, 0))).toBe(false);
  });
});

describe('uso_assinatura e sessao_terminal (02 §4.14, §4.15; I-2)', () => {
  it('snapshots de cota: último e expurgo por data', async () => {
    const { banco } = amb;
    const base = {
      utilizacao_5h: 0.5,
      utilizacao_7d: 0.2,
      reinicia_5h_em: null,
      reinicia_7d_em: null,
      status: 'allowed' as const,
      status_overage: null,
      usando_creditos_extras: false,
      bruto: { five_hour: { utilization: 0.5 } },
    };
    await banco.transacao((r) => r.usoAssinatura.registrar(base));
    amb.relogio.avancar(1000);
    await banco.transacao((r) => r.usoAssinatura.registrar({ ...base, utilizacao_5h: 0.85 }));
    expect((await banco.ler((r) => r.usoAssinatura.ultimo()))?.utilizacao_5h).toBe(0.85);
    expect(
      await banco.transacao((r) => r.usoAssinatura.expurgarAntesDe('2026-10-02T12:00:00.500Z')),
    ).toBe(1);
  });

  it('I-2 cruzado: não assume sessão executando; etapa não roda sessão assumida', async () => {
    const { banco } = amb;
    const id = s.execucao.id;
    const etapa = await banco.transacao((r) =>
      r.etapas.criar({
        execucao_id: id,
        tipo: 'implementar',
        ciclo: 1,
        papel: 'condutor',
        session_id: 'sess-x',
      }),
    );
    const assumir = {
      tipo: 'assumida' as const,
      cwd: '/w',
      execucao_id: id,
      etapa_id: etapa.id,
      session_id_claude: 'sess-x',
    };
    expect(await invariante(banco.transacao((r) => r.terminais.abrir(assumir)))).toBe('I-2');
    await banco.transacao((r) =>
      r.etapas.finalizar(etapa.id, { estado: 'interrompida', motivo_fim: 'pausado' }),
    );
    const t = await banco.transacao((r) => r.terminais.abrir(assumir));
    expect(await invariante(banco.transacao((r) => r.terminais.abrir(assumir)))).toBe('I-2');
    expect(
      await invariante(
        banco.transacao((r) =>
          r.etapas.criar({
            execucao_id: id,
            tipo: 'implementar',
            ciclo: 1,
            papel: 'condutor',
            session_id: 'sess-x',
            retomada: true,
          }),
        ),
      ),
    ).toBe('I-2');
    await banco.transacao((r) => r.terminais.encerrar(t.id, { sha_ao_devolver: SHA }));
    expect(await banco.ler((r) => r.terminais.abertas())).toHaveLength(0);
    await banco.transacao((r) =>
      r.etapas.criar({
        execucao_id: id,
        tipo: 'implementar',
        ciclo: 1,
        papel: 'condutor',
        session_id: 'sess-x',
        retomada: true,
      }),
    );
    expect(
      await invariante(banco.transacao((r) => r.terminais.abrir({ tipo: 'assumida', cwd: '/w' }))),
    ).toBe('check');
    const livre = await banco.transacao((r) => r.terminais.abrir({ tipo: 'livre', cwd: '/repo' }));
    expect(livre.execucao_id).toBeNull();
  });
});

describe('BancoForja.transacao', () => {
  it('erro desfaz a transação inteira', async () => {
    const { banco } = amb;
    await falha(
      banco.transacao(async (r) => {
        await r.comentarios.criar({
          execucao_id: s.execucao.id,
          alvo: 'plano',
          texto: 'x',
          ciclo_destino: 1,
        });
        throw new Error('desiste');
      }),
    );
    expect(await banco.ler((r) => r.comentarios.listar(s.execucao.id))).toHaveLength(0);
  });

  it('transações concorrentes são serializadas: a que falha não desfaz a outra', async () => {
    const { banco } = amb;
    const espera = () => new Promise((res) => setTimeout(res, 5));
    const [ok, ruim] = await Promise.allSettled([
      banco.transacao(async (r) => {
        await r.comentarios.criar({
          execucao_id: s.execucao.id,
          alvo: 'plano',
          texto: 'a',
          ciclo_destino: 1,
        });
        await espera();
        await r.comentarios.criar({
          execucao_id: s.execucao.id,
          alvo: 'plano',
          texto: 'b',
          ciclo_destino: 1,
        });
      }),
      banco.transacao(async (r) => {
        await r.comentarios.criar({
          execucao_id: s.execucao.id,
          alvo: 'plano',
          texto: 'c',
          ciclo_destino: 1,
        });
        await espera();
        throw new Error('falhou');
      }),
    ]);
    expect(ok.status).toBe('fulfilled');
    expect(ruim.status).toBe('rejected');
    const textos = (await banco.ler((r) => r.comentarios.listar(s.execucao.id))).map(
      (c) => c.texto,
    );
    expect(textos).toEqual(['a', 'b']);
  });

  it('chamada aninhada junta-se à transação corrente', async () => {
    const { banco } = amb;
    await falha(
      banco.transacao(async () => {
        await banco.transacao((r) =>
          r.comentarios.criar({
            execucao_id: s.execucao.id,
            alvo: 'plano',
            texto: 'aninhado',
            ciclo_destino: 1,
          }),
        );
        throw new Error('desfaz tudo');
      }),
    );
    expect(await banco.ler((r) => r.comentarios.listar(s.execucao.id))).toHaveLength(0);
  });
});
