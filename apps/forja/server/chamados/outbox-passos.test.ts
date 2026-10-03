import { describe, expect, it } from 'vitest';
import { ErroRede } from '@chamados/cliente-api';
import type { StatusChamado } from '@chamados/shared';
import {
  executarPasso,
  traduzirErro,
  type ContextoOutbox,
  type EntradaPasso,
} from './outbox-passos';
import { montarMensagemModelo, montarNotaConclusao, montarNotaInicio } from './notas';
import {
  ChamadosFalso,
  detalheFalso,
  erro,
  mensagemFalsa,
  type Requisicao,
} from './servidor-falso.test-apoio';

/**
 * Passos do outbox contra um Chamados falso (specs/forja/03 §9; 07 §9, §2.4):
 * leitura antes de escrever, idempotência por marcador / corpo normalizado,
 * cadeia de status recalculada em 409, e erros traduzidos em resultado tipado.
 */

const EXEC = '0b5f3c1e-1111-4222-8333-944455556666';
const REF = 'uuid-12';

function montar(
  status: StatusChamado = 'em_atendimento',
  extra: Parameters<typeof detalheFalso>[0] = { numero: 12 },
) {
  const s = new ChamadosFalso();
  s.adicionar({ detalhe: detalheFalso({ ...extra, numero: 12, id: REF, status }), mensagens: [] });
  const ctx: ContextoOutbox = {
    api: s.cliente(),
    execucaoId: EXEC,
    identidade: { usuarioId: s.usuario.id, nome: s.usuario.nome },
    d036: true,
    agora: () => new Date(s.agora),
  };
  const chamado = s.chamados.get(REF)!;
  return { s, ctx, chamado };
}

const passo = (p: EntradaPasso['passo'], extra: Partial<EntradaPasso> = {}): EntradaPasso => ({
  passo: p,
  chamado_ref: REF,
  ...extra,
});

const statusPosts = (s: ChamadosFalso): unknown[] =>
  s
    .escritas()
    .filter((r) => r.caminho.endsWith('/status'))
    .map((r) => (r.corpo as { status: string }).status);

/** Devolve o corpo das mensagens como o servidor devolveria em markdown (escapes + espaços). */
function comoMarkdownDoServidor(s: ChamadosFalso): void {
  s.interceptores.push((r: Requisicao) => {
    if (r.metodo !== 'GET' || !r.caminho.startsWith('/api/v1/chamados/')) return null;
    for (const c of s.chamados.values()) {
      for (const m of c.mensagens)
        m.corpo = m.corpo.replace(/([[\]_.-])/g, '\\$1').replace(/\n\n/g, '\n \n');
    }
    return null;
  });
}

describe('notas internas — idempotência pelo marcador', () => {
  const corpo = montarNotaConclusao({
    execucaoId: EXEC,
    branch: 'forja/chamado-12-frete',
    shaMerge: 'a'.repeat(40),
    destino: 'main',
    modoEntrega: 'merge_e_push',
    nivelVerificacao: 'verificacao_estatica',
    resumo: 'Ajusta o frete.',
    arquivos: ['src/frete.ts'],
    alteraUi: false,
    evidenciaVisual: 'nao_se_aplica',
    telas: [],
  });

  it('envia uma vez; a retentativa acha o marcador (mesmo com escapes) e não reenvia', async () => {
    const { s, ctx } = montar();
    comoMarkdownDoServidor(s);
    const r1 = await executarPasso(ctx, passo('nota_interna', { corpo }));
    expect(r1).toMatchObject({ resultado: 'enviado', ja_feito: false, ultimo_http: 201 });
    const r2 = await executarPasso(ctx, passo('nota_interna', { corpo }));
    expect(r2).toMatchObject({
      resultado: 'enviado',
      ja_feito: true,
      id_remoto: (r1 as { id_remoto: string }).id_remoto,
    });
    expect(s.escritas()).toHaveLength(1);
    expect(s.escritas()[0]!.corpo).toEqual({ visibilidade: 'interna', corpo });
  });

  it('marcador de OUTRO momento não conta como feito', async () => {
    const { s, ctx, chamado } = montar();
    chamado.mensagens.push(
      mensagemFalsa({
        corpo: montarNotaInicio({ execucaoId: EXEC, branch: 'b' }),
        visibilidade: 'interna',
        autor_papel: 'operador',
        autor_nome: s.usuario.nome,
      }),
    );
    expect(await executarPasso(ctx, passo('nota_interna', { corpo }))).toMatchObject({
      ja_feito: false,
    });
  });

  it('segredo no corpo bloqueia; sem marcador bloqueia; terminal pula', async () => {
    const { s, ctx } = montar();
    const comSegredo = corpo.replace('Ajusta o frete.', 'Use postgres://app:S3nh4F0rte@db/erp');
    expect(await executarPasso(ctx, passo('nota_interna', { corpo: comSegredo }))).toMatchObject({
      resultado: 'bloqueado',
      motivo: 'segredo_detectado',
    });
    expect(
      await executarPasso(ctx, passo('nota_interna', { corpo: 'sem marcador' })),
    ).toMatchObject({
      resultado: 'bloqueado',
      motivo: 'marcador_ausente',
    });
    expect(s.escritas()).toHaveLength(0);
    const t = montar('fechado');
    expect(await executarPasso(t.ctx, passo('nota_interna', { corpo }))).toMatchObject({
      resultado: 'pulado',
      motivo: 'estado_terminal',
    });
  });

  it('valor sensível conhecido (token) bloqueia', async () => {
    const { ctx } = montar();
    const r = await executarPasso(
      { ...ctx, valoresSensiveis: ['tok-sessao-secreta-1'] },
      passo('nota_inicio', {
        corpo: `${montarNotaInicio({ execucaoId: EXEC, branch: 'b' })}\ntok-sessao-secreta-1`,
      }),
    );
    expect(r).toMatchObject({ resultado: 'bloqueado', motivo: 'segredo_detectado' });
  });
});

describe('mensagem pública — idempotência por corpo normalizado + autor + janela', () => {
  const corpo = montarMensagemModelo('aguardando_publicacao', {
    solicitanteNome: 'Maria Souza',
    oQueMuda: 'o relatório de frete mostra o valor uma vez só.',
  });

  it('não duplica após timeout (corpo devolvido com escapes)', async () => {
    const { s, ctx } = montar();
    comoMarkdownDoServidor(s);
    await executarPasso(ctx, passo('mensagem_publica', { corpo, enviado_em: s.agora }));
    const r = await executarPasso(ctx, passo('mensagem_publica', { corpo, enviado_em: s.agora }));
    expect(r).toMatchObject({ resultado: 'enviado', ja_feito: true });
    expect(s.escritas()).toHaveLength(1);
  });

  it('pública igual FORA da janela, ou de outro autor, não conta', async () => {
    const { s, ctx, chamado } = montar();
    chamado.mensagens.push(
      mensagemFalsa({
        corpo,
        autor_nome: s.usuario.nome,
        autor_papel: 'operador',
        created_at: '2026-10-02T11:00:00.000Z',
      }),
      mensagemFalsa({
        corpo,
        autor_nome: 'Outro Operador',
        autor_papel: 'operador',
        created_at: s.agora,
      }),
    );
    expect(
      await executarPasso(ctx, passo('mensagem_publica', { corpo, enviado_em: s.agora })),
    ).toMatchObject({
      ja_feito: false,
    });
  });

  it('plano B: mesmos 200 primeiros caracteres normalizados', async () => {
    const { s, ctx, chamado } = montar();
    chamado.mensagens.push(
      mensagemFalsa({
        corpo: `${corpo}\n\n(rodapé do e-mail)`,
        autor_nome: s.usuario.nome,
        autor_papel: 'operador',
        created_at: s.agora,
      }),
    );
    expect(await executarPasso(ctx, passo('mensagem_publica', { corpo }))).toMatchObject({
      ja_feito: true,
    });
  });

  it('revalida a linguagem no envio; "publicar mesmo assim" pelos mesmos motivos libera', async () => {
    const { s, ctx } = montar();
    const tecnico = 'Fizemos o merge da branch e entra na próxima atualização.';
    const r = await executarPasso(
      ctx,
      passo('mensagem_publica', { corpo: tecnico, tipo_resposta: 'aguardando_publicacao' }),
    );
    expect(r).toMatchObject({ resultado: 'bloqueado', motivo: 'linguagem' });
    expect((r as { motivos_nao_confirmados: string[] }).motivos_nao_confirmados).toEqual(
      expect.arrayContaining(['lexico:merge', 'lexico:branch']),
    );
    expect(s.escritas()).toHaveLength(0);
    const ok = await executarPasso(
      ctx,
      passo('mensagem_publica', {
        corpo: tecnico,
        tipo_resposta: 'aguardando_publicacao',
        publicar_mesmo_assim: { motivos: ['lexico:merge', 'lexico:branch'] },
      }),
    );
    expect(ok).toMatchObject({ resultado: 'enviado', ja_feito: false });
  });

  it('chamado encerrado: pula com aviso de resposta não publicada', async () => {
    const { ctx } = montar('cancelado');
    expect(await executarPasso(ctx, passo('mensagem_publica', { corpo }))).toMatchObject({
      resultado: 'pulado',
      motivo: 'estado_terminal',
    });
  });
});

describe('passos de status — lê, calcula a cadeia, recalcula em 409', () => {
  it('resolvido a partir de aguardando_cliente passa por em_atendimento', async () => {
    const { s, ctx, chamado } = montar('aguardando_cliente');
    const r = await executarPasso(ctx, passo('status_resolvido'));
    expect(r).toMatchObject({ resultado: 'enviado', ja_feito: false, status_lido: 'resolvido' });
    expect(statusPosts(s)).toEqual(['em_atendimento', 'resolvido']);
    expect(s.escritas()[0]!.corpo).toEqual({
      status: 'em_atendimento',
      motivo: 'implementado_via_forja',
    });
    expect(chamado.detalhe.status).toBe('resolvido');
  });

  it('já no alvo = feito sem escrever (nunca repete a transição → 409)', async () => {
    const { s, ctx } = montar('resolvido');
    expect(await executarPasso(ctx, passo('status_resolvido'))).toMatchObject({
      resultado: 'enviado',
      ja_feito: true,
    });
    expect(s.escritas()).toHaveLength(0);
  });

  it('409 transicao_invalida: relê e recalcula 1× (um humano mudou no meio)', async () => {
    const { s, ctx, chamado } = montar('em_atendimento');
    let primeira = true;
    s.interceptores.push((r) => {
      if (r.caminho.endsWith('/status') && primeira) {
        primeira = false;
        chamado.detalhe.status = 'aguardando_cliente';
        return erro(409, 'transicao_invalida');
      }
      return null;
    });
    const r = await executarPasso(ctx, passo('status_resolvido'));
    expect(r).toMatchObject({ resultado: 'enviado', status_lido: 'resolvido' });
    expect(statusPosts(s)).toEqual(['resolvido', 'em_atendimento', 'resolvido']);
  });

  it('409 persistente vira precisa_humano (nunca sucesso às cegas)', async () => {
    const { s, ctx } = montar('em_atendimento');
    s.interceptores.push((r) =>
      r.caminho.endsWith('/status') ? erro(409, 'transicao_invalida') : null,
    );
    expect(await executarPasso(ctx, passo('status_resolvido'))).toMatchObject({
      resultado: 'precisa_humano',
      motivo: 'transicao_recusada',
      motivo_execucao: 'transicao_recusada',
    });
    expect(statusPosts(s)).toHaveLength(2);
  });

  it('403 persistente em /status vira bloqueado (configuração da identidade)', async () => {
    const { s, ctx } = montar('em_atendimento');
    s.interceptores.push((r) =>
      r.caminho.endsWith('/status') ? erro(403, 'sem_permissao') : null,
    );
    expect(await executarPasso(ctx, passo('status_resolvido'))).toMatchObject({
      resultado: 'bloqueado',
      motivo: 'sem_permissao',
    });
  });

  it('fechado imediato a partir de em_atendimento: resolvido → fechado', async () => {
    const { s, ctx } = montar('em_atendimento');
    await executarPasso(ctx, passo('status_fechado'));
    expect(statusPosts(s)).toEqual(['resolvido', 'fechado']);
  });

  it('terminal: pulado; resolvido → aguardando_cliente exige reabrir: precisa_humano', async () => {
    expect(await executarPasso(montar('cancelado').ctx, passo('status_resolvido'))).toMatchObject({
      resultado: 'pulado',
      motivo: 'estado_terminal',
    });
    expect(
      await executarPasso(montar('resolvido').ctx, passo('status_aguardando_cliente')),
    ).toMatchObject({
      resultado: 'precisa_humano',
    });
  });

  it('status_aguardando_cliente (Gdec) com motivo próprio', async () => {
    const { s, ctx } = montar('em_atendimento');
    await executarPasso(ctx, passo('status_aguardando_cliente'));
    expect(s.escritas()[0]!.corpo).toEqual({
      status: 'aguardando_cliente',
      motivo: 'pergunta_via_forja',
    });
  });

  it('status_em_atendimento: só de em_triagem/aguardando_cliente', async () => {
    const t = montar('em_triagem');
    await executarPasso(t.ctx, passo('status_em_atendimento', { motivo: 'retomada_via_forja' }));
    expect(t.s.escritas()[0]!.corpo).toEqual({
      status: 'em_atendimento',
      motivo: 'retomada_via_forja',
    });
    expect(
      await executarPasso(montar('em_atendimento').ctx, passo('status_em_atendimento')),
    ).toMatchObject({ ja_feito: true });
    expect(
      await executarPasso(montar('resolvido').ctx, passo('status_em_atendimento')),
    ).toMatchObject({
      resultado: 'pulado',
      motivo: 'nao_aplicavel',
    });
  });
});

describe('D-036: silêncio da IA (L1) e atribuição (L4)', () => {
  it('silenciar: registra se foi a Forja; já silenciada = feito sem escrever', async () => {
    const a = montar('em_atendimento', { numero: 12, ia_silenciada: false });
    expect(await executarPasso(a.ctx, passo('silenciar_ia'))).toMatchObject({
      resultado: 'enviado',
      efeitos: { forja_silenciou: true },
    });
    expect(a.chamado.detalhe.ia_silenciada).toBe(true);
    const b = montar('em_atendimento', { numero: 12, ia_silenciada: true });
    expect(await executarPasso(b.ctx, passo('silenciar_ia'))).toMatchObject({
      ja_feito: true,
      efeitos: { forja_silenciou: false },
    });
    expect(b.s.escritas()).toHaveLength(0);
  });

  it('sem D-036 (modo ou rota ausente): pulado', async () => {
    const { ctx } = montar();
    expect(await executarPasso({ ...ctx, d036: false }, passo('silenciar_ia'))).toMatchObject({
      motivo: 'sem_d036',
    });
    const sem = montar('em_atendimento', { numero: 12, ia_silenciada: false });
    sem.s.d036 = false;
    expect(await executarPasso(sem.ctx, passo('silenciar_ia'))).toMatchObject({
      resultado: 'pulado',
      motivo: 'sem_d036',
    });
  });

  it('reativar: só se foi a Forja; idempotente', async () => {
    const { s, ctx } = montar();
    expect(
      await executarPasso(ctx, passo('reativar_ia', { forja_silenciou: false })),
    ).toMatchObject({ motivo: 'nao_foi_a_forja' });
    expect(await executarPasso(ctx, passo('reativar_ia', { forja_silenciou: true }))).toMatchObject(
      { ja_feito: false },
    );
    expect(await executarPasso(ctx, passo('reativar_ia', { forja_silenciou: true }))).toMatchObject(
      { ja_feito: true },
    );
    expect(s.escritas()).toHaveLength(1);
  });

  it('atribuir: atribuído a outro só reatribui com confirmação (senão pula); guarda o anterior', async () => {
    const { s, ctx, chamado } = montar('em_atendimento', {
      numero: 12,
      operador_id: 'u-ana',
      operador_nome: 'Ana',
    });
    expect(await executarPasso(ctx, passo('atribuir'))).toMatchObject({
      resultado: 'pulado',
      motivo: 'atribuido_a_outro',
    });
    expect(chamado.detalhe.operador_id).toBe('u-ana');
    const r = await executarPasso(ctx, passo('atribuir', { confirmar_reatribuir: true }));
    expect(r).toMatchObject({
      resultado: 'enviado',
      efeitos: { forja_atribuiu: true, operador_anterior: 'u-ana' },
    });
    expect(chamado.detalhe.operador_id).toBe(s.usuario.id);
    expect(await executarPasso(ctx, passo('atribuir'))).toMatchObject({ ja_feito: true });
    expect(s.escritas()).toHaveLength(1);

    expect(
      await executarPasso(
        ctx,
        passo('desatribuir', { forja_atribuiu: true, operador_anterior: 'u-ana' }),
      ),
    ).toMatchObject({
      resultado: 'enviado',
      ja_feito: false,
    });
    expect(chamado.detalhe.operador_id).toBe('u-ana');
  });

  it('desatribuir não passa por cima de quem reatribuiu depois', async () => {
    const { s, ctx } = montar('em_atendimento', { numero: 12, operador_id: 'u-bia' });
    expect(
      await executarPasso(
        ctx,
        passo('desatribuir', { forja_atribuiu: true, operador_anterior: null }),
      ),
    ).toMatchObject({
      resultado: 'pulado',
      motivo: 'atribuicao_mudou',
    });
    expect(s.escritas()).toHaveLength(0);
  });
});

describe('erros traduzidos (07 §2.4; 03 §9.3)', () => {
  it('404 chamado_inexistente → precisa_humano', async () => {
    const { ctx } = montar();
    expect(
      await executarPasso(ctx, { passo: 'status_resolvido', chamado_ref: 'nao-existe' }),
    ).toMatchObject({
      resultado: 'precisa_humano',
      motivo: 'chamado_inacessivel',
      motivo_execucao: 'chamado_mudou_no_servidor',
    });
  });

  it('5xx → retentar; segundo 401 → reconectar; 409 estado_terminal no POST → pulado', async () => {
    const a = montar();
    a.s.interceptores.push(() => erro(503, 'indisponivel'));
    expect(await executarPasso(a.ctx, passo('status_resolvido'))).toMatchObject({
      resultado: 'retentar',
      motivo: 'servidor',
    });

    const b = montar();
    b.s.interceptores.push((r) =>
      r.caminho.endsWith('/sessao') ? null : erro(401, 'nao_autenticado'),
    );
    expect(await executarPasso(b.ctx, passo('status_resolvido'))).toMatchObject({
      resultado: 'reconectar',
      motivo: 'sessao_recusada',
    });

    const c = montar();
    c.s.interceptores.push((r) => (r.metodo === 'POST' ? erro(409, 'estado_terminal') : null));
    expect(
      await executarPasso(c.ctx, passo('mensagem_publica', { corpo: 'Olá! Tudo certo.' })),
    ).toMatchObject({
      resultado: 'pulado',
      motivo: 'estado_terminal',
    });
  });

  it('rede → retentar; erro desconhecido sobe', () => {
    expect(traduzirErro(new ErroRede('timeout', 'x'))).toMatchObject({
      resultado: 'retentar',
      motivo: 'rede',
    });
    expect(() => traduzirErro(new TypeError('bug'))).toThrow(TypeError);
  });
});
