/**
 * Smoke test de Mensagens/Anexos/Eventos (M4 — specs/04 §5-§9, specs/09 §5-§6).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) e prova:
 *  1. cliente não vê mensagem interna (filtro no repositório) e o evento
 *     `nota_interna_publicada` fica oculto ao cliente;
 *  2. anexo de nota interna é INACESSÍVEL ao cliente (URL assinada negada);
 *  3. upload com magic bytes inválido (arquivo que não bate com o tipo) é rejeitado;
 *  4. imagem `data:` no doc vira Anexo inline e o HTML final NÃO contém `data:`;
 *  5. XSS (script/handler/`javascript:`) é removido pela sanitização;
 *  6. resposta do cliente em `aguardando_cliente` dispara `→ em_triagem` (evento);
 *  7. eventos gerados em todas as mutações; visibilidade por papel;
 *  8. isolamento RLS entre tenants (mensagens/anexos);
 *  9. imutabilidade de mensagem (sem API de edição/exclusão).
 *
 * Requer MinIO de pé (upload de anexos). Sai com 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource, criarAdminDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { provisionarTenant, criarUsuarioAtivoComSenha } = await import('../auth');
const { ChamadoSchema } = await import('../entities/chamado');
const { criarChamado, transicionarStatus, definirComplexidade, atorSistema } =
  await import('../chamados/chamado-service');
const mensagemMod = await import('../chamados/mensagem-service');
const { criarMensagem, listarMensagens } = mensagemMod;
type DocRico = import('../chamados/rich-text').DocRico;
const { autorizarDownloadAnexo, listarAnexosDaMensagem } =
  await import('../chamados/anexo-service');
const { listarEventos } = await import('../chamados/evento-service');
const { Papel, StatusTenant, StatusChamado, Natureza, Complexidade, VisibilidadeMensagem } =
  await import('@chamados/shared');

/** PNG 1x1 transparente (base64) — magic bytes válidos. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-mensagens] conectado como role da aplicação (sem bypass).');

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-msg-a-${sufixo}`,
      nome: 'Msg A',
      nomeExibicao: 'Msg A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-msg-b-${sufixo}`,
      nome: 'Msg B',
      nomeExibicao: 'Msg B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    const { cliente, operador } = await runInTenantContext(ds, tenantA, async (em) => {
      const cliente = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli.${sufixo}@a.dev`,
        nome: 'Cliente A',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      const operador = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `op.${sufixo}@a.dev`,
        nome: 'Operador A',
        papel: Papel.operador,
        senha: 'Dev@12345',
      });
      return { cliente, operador };
    });
    const clienteB = await runInTenantContext(ds, tenantB, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantB,
        email: `cli.${sufixo}@b.dev`,
        nome: 'Cliente B',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      }),
    );

    const atorCli = { id: cliente, tenant_id: tenantA, papel: Papel.cliente };
    const atorOp = { id: operador, tenant_id: tenantA, papel: Papel.operador };
    const atorCliB = { id: clienteB, tenant_id: tenantB, papel: Papel.cliente };

    // Chamado base.
    const ch = await runInTenantContext(ds, tenantA, (em) =>
      criarChamado(em, atorCli, {
        titulo: 'Falha ao gerar relatório',
        descricao: 'Ao clicar em gerar, nada acontece.',
        natureza: Natureza.problema,
      }),
    );
    if (!ch.ok) throw new Error('falha ao criar chamado base');
    const chamadoId = ch.id;

    // 1) Mensagens pública e interna; filtro por papel -----------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const pub = await criarMensagem(em, atorCli, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: 'Segue mais um detalhe do erro.',
      });
      ok(pub.ok, 'cliente publica mensagem pública — ok');

      const interna = await criarMensagem(em, atorOp, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: 'Nota interna: suspeita de timeout no serviço X.',
      });
      ok(interna.ok, 'operador publica nota interna — ok');

      const negada = await criarMensagem(em, atorCli, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: 'tentativa do cliente de nota interna',
      });
      ok(!negada.ok, 'cliente NÃO publica nota interna — NEGADO');

      const comoCliente = await listarMensagens(em, atorCli, chamadoId);
      ok(
        comoCliente.every((m) => !('visibilidade' in m)),
        'timeline do cliente não expõe o campo visibilidade (serializer)',
      );
      ok(comoCliente.length === 1, 'cliente vê SÓ a mensagem pública (1), não a interna');

      const comoOperador = await listarMensagens(em, atorOp, chamadoId);
      const internas = comoOperador.filter(
        (m) => 'visibilidade' in m && m.visibilidade === VisibilidadeMensagem.interna,
      );
      ok(comoOperador.length === 2 && internas.length === 1, 'operador vê pública + interna (2)');
    });

    // 2) Anexo de nota interna é inacessível ao cliente ----------------------
    const anexoInternoId = await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarMensagem(em, atorOp, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: 'Log anexado para diagnóstico.',
        anexos: [
          { nome_arquivo: 'erro.log', buffer: Buffer.from('2026-07-15 ERRO timeout\n', 'utf8') },
        ],
      });
      if (!r.ok) throw new Error('falha ao anexar log em nota interna');
      const anexos = await listarAnexosDaMensagem(em, r.id);
      ok(anexos.length === 1, 'anexo da nota interna foi gravado');
      return anexos[0]!.id;
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      const comoCliente = await autorizarDownloadAnexo(em, atorCli, anexoInternoId);
      ok(!comoCliente.ok, 'cliente NÃO baixa anexo de nota interna — URL assinada negada');
      const comoOperador = await autorizarDownloadAnexo(em, atorOp, anexoInternoId);
      ok(comoOperador.ok, 'operador baixa o anexo da nota interna — ok');
    });

    // 3) Upload com magic bytes inválido -------------------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarMensagem(em, atorOp, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: 'Tentando anexar um falso PNG.',
        anexos: [
          { nome_arquivo: 'foto.png', buffer: Buffer.from('isto nao eh uma imagem', 'utf8') },
        ],
      });
      ok(!r.ok, 'anexo cujo conteúdo NÃO bate com o tipo é rejeitado (magic bytes)');
      if (!r.ok) ok(r.motivo === 'anexo_invalido', 'motivo = anexo_invalido');
    });

    // 4) Imagem data: vira anexo inline; HTML final sem data: ----------------
    const msgImagemId = await runInTenantContext(ds, tenantA, async (em) => {
      const doc = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Print do erro:' }] },
          { type: 'image', attrs: { src: `data:image/png;base64,${PNG_1x1}`, alt: 'print' } },
        ],
      };
      const r = await criarMensagem(em, atorOp, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: doc as DocRico,
      });
      if (!r.ok) throw new Error('falha ao criar mensagem com imagem colada');
      const anexos = await em.query(
        `SELECT id, inline FROM anexo WHERE mensagem_id = $1 AND inline = true`,
        [r.id],
      );
      ok(anexos.length === 1, 'imagem data: virou 1 Anexo inline');
      return r.id;
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      const msgs = await listarMensagens(em, atorOp, chamadoId);
      const alvo = msgs.find((m) => m.id === msgImagemId)!;
      ok(
        !alvo.corpo_html.includes('data:'),
        'HTML final NÃO contém data: (imagem virou referência)',
      );
      ok(alvo.corpo_html.includes('/api/anexos/'), 'HTML referencia o anexo por /api/anexos/<id>');
    });

    // 5) Sanitização de XSS --------------------------------------------------
    const msgXssId = await runInTenantContext(ds, tenantA, async (em) => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '<script>alert(1)</script> clique',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
          { type: 'image', attrs: { src: 'javascript:alert(2)' } },
          { type: 'scriptNode', attrs: { onerror: 'x' }, content: [{ type: 'text', text: 'oi' }] },
        ],
      };
      const r = await criarMensagem(em, atorOp, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: doc as DocRico,
      });
      if (!r.ok) throw new Error('falha ao criar mensagem XSS');
      return r.id;
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      const msgs = await listarMensagens(em, atorOp, chamadoId);
      const html = msgs.find((m) => m.id === msgXssId)!.corpo_html;
      ok(!html.toLowerCase().includes('javascript:'), 'HTML sanitizado NÃO contém javascript:');
      ok(!html.includes('<script'), 'HTML sanitizado NÃO contém <script');
      ok(!html.toLowerCase().includes('onerror'), 'HTML sanitizado NÃO contém handler onerror');
      ok(html.includes('&lt;script&gt;'), 'texto perigoso foi ESCAPADO (não interpretado)');
    });

    // 6) Resposta do cliente em aguardando_cliente → em_triagem --------------
    await runInTenantContext(ds, tenantA, async (em) => {
      await transicionarStatus(em, atorSistema(tenantA), chamadoId, StatusChamado.em_triagem);
      await transicionarStatus(em, atorOp, chamadoId, StatusChamado.aguardando_cliente);
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await criarMensagem(em, atorCli, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: 'Aqui está a informação que faltava.',
      });
      ok(r.ok, 'cliente responde em aguardando_cliente — ok');
      const ch = await em.findOne(ChamadoSchema, { where: { id: chamadoId } });
      ok(
        ch?.status === StatusChamado.em_triagem,
        'resposta do cliente re-enfileirou a triagem (→ em_triagem)',
      );
    });

    // 6b) D-017 (parte 3): mensagem do cliente em em_atendimento re-dispara a
    //     triagem SEM mudar o status (o operador segue com o chamado).
    {
      const capturadas: Array<{ tipo: string; gatilho?: string }> = [];
      const desp = { publicar: (e: { tipo: string }) => void capturadas.push(e) };
      await runInTenantContext(ds, tenantA, async (em) => {
        await transicionarStatus(em, atorOp, chamadoId, StatusChamado.em_atendimento);
        const r = await criarMensagem(
          em,
          atorCli,
          {
            chamado_id: chamadoId,
            visibilidade: VisibilidadeMensagem.publica,
            corpo: 'Complementando: o erro também acontece na tela de listagem.',
          },
          { despachante: desp },
        );
        ok(r.ok, 'cliente responde em em_atendimento — ok');
        const ch = await em.findOne(ChamadoSchema, { where: { id: chamadoId } });
        ok(
          ch?.status === StatusChamado.em_atendimento,
          'mensagem em em_atendimento NÃO muda o status',
        );
      });
      ok(
        capturadas.some((e) => e.tipo === 'triagem_solicitada'),
        'mensagem em em_atendimento DISPARA triagem (triagem_solicitada publicado)',
      );
    }

    // 6c) D-017 (parte 3): mensagem do cliente em resolvido REABRE (autor) e
    //     re-dispara a triagem.
    {
      const capturadas: Array<{ tipo: string }> = [];
      const desp = { publicar: (e: { tipo: string }) => void capturadas.push(e) };
      await runInTenantContext(ds, tenantA, async (em) => {
        await transicionarStatus(em, atorOp, chamadoId, StatusChamado.resolvido);
        const r = await criarMensagem(
          em,
          atorCli,
          {
            chamado_id: chamadoId,
            visibilidade: VisibilidadeMensagem.publica,
            corpo: 'Na verdade o problema voltou a acontecer hoje.',
          },
          { despachante: desp },
        );
        ok(r.ok, 'cliente responde em resolvido — ok');
        const ch = await em.findOne(ChamadoSchema, { where: { id: chamadoId } });
        ok(
          ch?.status === StatusChamado.em_atendimento,
          'mensagem do cliente em resolvido REABRE (→ em_atendimento)',
        );
        const evs = await listarEventos(em, atorOp, chamadoId);
        ok(
          evs.some((e) => e.tipo === 'chamado_reaberto'),
          'evento chamado_reaberto registrado na reabertura por mensagem',
        );
      });
      ok(
        capturadas.some((e) => e.tipo === 'triagem_solicitada'),
        'mensagem em resolvido DISPARA triagem (triagem_solicitada publicado)',
      );
    }

    // 7) Eventos: gerados em todas as mutações; visibilidade por papel -------
    await runInTenantContext(ds, tenantA, (em) =>
      definirComplexidade(em, atorOp, chamadoId, Complexidade.medio),
    );
    await runInTenantContext(ds, tenantA, async (em) => {
      const doOperador = await listarEventos(em, atorOp, chamadoId);
      const tipos = new Set(doOperador.map((e) => e.tipo));
      ok(tipos.has('chamado_criado'), 'evento chamado_criado registrado');
      ok(tipos.has('mensagem_publicada'), 'evento mensagem_publicada registrado');
      ok(tipos.has('nota_interna_publicada'), 'evento nota_interna_publicada registrado');
      ok(tipos.has('anexo_adicionado'), 'evento anexo_adicionado registrado');
      ok(tipos.has('status_alterado'), 'evento status_alterado (re-enfileiramento) registrado');
      ok(tipos.has('complexidade_alterada'), 'evento complexidade_alterada registrado');

      const doCliente = await listarEventos(em, atorCli, chamadoId);
      const tiposCliente = new Set(doCliente.map((e) => e.tipo));
      ok(!tiposCliente.has('nota_interna_publicada'), 'cliente NÃO vê nota_interna_publicada');
      ok(!tiposCliente.has('complexidade_alterada'), 'cliente NÃO vê complexidade_alterada');
      ok(
        !tiposCliente.has('anexo_adicionado'),
        'cliente NÃO vê anexo_adicionado (pode ser interno)',
      );
      ok(tiposCliente.has('chamado_criado'), 'cliente vê chamado_criado');
      ok(tiposCliente.has('mensagem_publicada'), 'cliente vê mensagem_publicada');
    });

    // 8) Isolamento RLS entre tenants ----------------------------------------
    await runInTenantContext(ds, tenantB, async (em) => {
      const msgs = await listarMensagens(em, atorCliB, chamadoId);
      ok(msgs.length === 0, 'tenant B não enxerga mensagens do chamado do tenant A (RLS)');
      const dl = await autorizarDownloadAnexo(em, atorCliB, anexoInternoId);
      ok(!dl.ok, 'tenant B não baixa anexo do tenant A (RLS → inexistente)');
    });

    // 9) Imutabilidade de mensagem -------------------------------------------
    ok(
      !('editarMensagem' in mensagemMod) &&
        !('removerMensagem' in mensagemMod) &&
        !('atualizarMensagem' in mensagemMod),
      'mensagem-service não expõe edição/exclusão (imutável no MVP)',
    );

    console.log('\n[smoke-mensagens] RESULTADO: PASSOU — mensagens/anexos/eventos confirmados.');
  } finally {
    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        // CASCADE de chamado→mensagem/anexo/evento; depois usuários e tenant.
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-mensagens] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-mensagens] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
