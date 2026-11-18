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
 *  7b. D-037 — outro cliente do MESMO tenant lê a timeline pública, os eventos
 *      públicos e os anexos públicos do chamado alheio, mas NÃO vê nota interna,
 *      não baixa anexo interno e NÃO escreve/transiciona (ler ≠ agir);
 *  8. isolamento RLS entre tenants (mensagens/anexos);
 *  9. imutabilidade de mensagem (sem API de edição/exclusão);
 * 10. D-039 — resposta PÚBLICA de operador/admin torna o autor o responsável
 *     (substitui o anterior; sem evento duplicado; sem e-mail ao próprio autor);
 *     nota interna, `agente_ia` e `cliente` não atribuem; cross-tenant intacto.
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
const { criarChamado, transicionarStatus, definirComplexidade, atribuirOperador, atorSistema } =
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

    const { cliente, operador, cliente2 } = await runInTenantContext(ds, tenantA, async (em) => {
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
      // D-037: segundo cliente do MESMO tenant (lê o chamado alheio, não age).
      const cliente2 = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `cli2.${sufixo}@a.dev`,
        nome: 'Cliente A2',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      return { cliente, operador, cliente2 };
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
    const atorCli2 = { id: cliente2, tenant_id: tenantA, papel: Papel.cliente };

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
        // D-042: mensagem do cliente em resolvido = CONTESTAÇÃO (substitui reaberto).
        ok(
          evs.some((e) => e.tipo === 'chamado_contestado'),
          'evento chamado_contestado registrado na reabertura por mensagem (D-042)',
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

    // 7b) D-037: outro cliente do mesmo tenant LÊ (visão pública), não AGE ---
    await runInTenantContext(ds, tenantA, async (em) => {
      const doOperador = await listarMensagens(em, atorOp, chamadoId);
      const publicas = doOperador.filter(
        (m) => 'visibilidade' in m && m.visibilidade === VisibilidadeMensagem.publica,
      );
      const msgs = await listarMensagens(em, atorCli2, chamadoId);
      ok(
        msgs.length > 0 && msgs.length === publicas.length,
        'cliente2 lê a timeline PÚBLICA do chamado do cliente1 (mesmo tenant — D-037)',
      );
      ok(
        msgs.every((m) => !('visibilidade' in m) && !('execucao_ia_id' in m)),
        'timeline do chamado alheio vem pelo serializer do cliente (sem visibilidade/execucao_ia_id)',
      );
      const idsInternos = new Set(
        doOperador
          .filter((m) => 'visibilidade' in m && m.visibilidade === VisibilidadeMensagem.interna)
          .map((m) => m.id),
      );
      ok(
        !msgs.some((m) => idsInternos.has(m.id)),
        'cliente2 NÃO vê nenhuma nota interna do chamado alheio',
      );

      const eventos = new Set((await listarEventos(em, atorCli2, chamadoId)).map((e) => e.tipo));
      ok(eventos.has('chamado_criado'), 'cliente2 vê eventos públicos do chamado alheio');
      ok(
        !eventos.has('nota_interna_publicada') &&
          !eventos.has('complexidade_alterada') &&
          !eventos.has('anexo_adicionado'),
        'cliente2 NÃO vê eventos internos do chamado alheio',
      );

      const [inline] = (await em.query(
        `SELECT id FROM anexo WHERE mensagem_id = $1 AND inline = true`,
        [msgImagemId],
      )) as Array<{ id: string }>;
      const dlPub = await autorizarDownloadAnexo(em, atorCli2, inline!.id);
      ok(dlPub.ok, 'cliente2 baixa anexo de mensagem PÚBLICA do chamado alheio');
      const dlInt = await autorizarDownloadAnexo(em, atorCli2, anexoInternoId);
      ok(!dlInt.ok, 'cliente2 NÃO baixa anexo de nota interna do chamado alheio');
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      const escreve = await criarMensagem(em, atorCli2, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: 'Também tenho esse problema.',
      });
      ok(
        !escreve.ok && escreve.motivo === 'sem_permissao',
        'cliente2 NÃO publica mensagem no chamado alheio (ler ≠ agir)',
      );
      const anexa = await criarMensagem(em, atorCli2, {
        chamado_id: chamadoId,
        visibilidade: VisibilidadeMensagem.publica,
        corpo: 'Anexo meu.',
        anexos: [{ nome_arquivo: 'nota.txt', buffer: Buffer.from('oi\n', 'utf8') }],
      });
      ok(
        !anexa.ok && anexa.motivo === 'sem_permissao',
        'cliente2 NÃO envia anexo no chamado alheio',
      );
      const cancela = await transicionarStatus(em, atorCli2, chamadoId, StatusChamado.cancelado);
      ok(
        !cancela.ok && cancela.motivo === 'sem_permissao',
        'cliente2 NÃO transiciona (cancela/reabre) o chamado alheio',
      );
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

    // 10) D-039 — "quem responde fica responsável" ----------------------------
    //     Chamado NOVO (o base já foi assumido pelo operador nas seções 4/5).
    {
      const { operador2, admin } = await runInTenantContext(ds, tenantA, async (em) => ({
        operador2: await criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantA,
          email: `op2.${sufixo}@a.dev`,
          nome: 'Operador A2',
          papel: Papel.operador,
          senha: 'Dev@12345',
        }),
        admin: await criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantA,
          email: `adm.${sufixo}@a.dev`,
          nome: 'Admin A',
          papel: Papel.admin,
          senha: 'Dev@12345',
        }),
      }));
      const atorOp2 = { id: operador2, tenant_id: tenantA, papel: Papel.operador };
      const atorAdm = { id: admin, tenant_id: tenantA, papel: Papel.admin };
      const atorIa = { id: provA.agente_ia_id, tenant_id: tenantA, papel: Papel.agente_ia };

      const ch10 = await runInTenantContext(ds, tenantA, (em) =>
        criarChamado(em, atorCli, {
          titulo: 'D-039: quem responde assume',
          descricao: 'Chamado para provar a auto-atribuição por resposta.',
          natureza: Natureza.duvida,
        }),
      );
      if (!ch10.ok) throw new Error('falha ao criar chamado da seção 10');
      const id10 = ch10.id;

      const responsavel = (em: import('typeorm').EntityManager) =>
        em.findOne(ChamadoSchema, { where: { id: id10 } }).then((c) => c?.operador_id ?? null);
      const atribuicoes = async (em: import('typeorm').EntityManager) =>
        (await listarEventos(em, atorOp, id10)).filter((e) => e.tipo === 'operador_atribuido');

      // a) nota interna NÃO atribui.
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarMensagem(em, atorOp, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.interna,
          corpo: 'Nota interna: vou olhar isto.',
        });
        ok(r.ok && !('assumiu' in r && r.assumiu), 'nota interna de operador — ok, sem assumir');
        ok((await responsavel(em)) === null, 'nota interna NÃO atribui o chamado (D-039)');
      });

      // b) mensagem pública do agente_ia NÃO atribui.
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarMensagem(em, atorIa, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Olá! Recebemos sua dúvida e já estamos analisando.',
        });
        ok(r.ok, 'agente_ia publica mensagem pública — ok');
        ok((await responsavel(em)) === null, 'resposta pública da IA NÃO atribui (D-039)');
        ok((await atribuicoes(em)).length === 0, 'nenhum operador_atribuido até aqui');
      });

      // c) resposta pública do operador ATRIBUI a ele (evento com ator = autor,
      //    motivo resposta_publica; o autor não recebe e-mail da própria atribuição).
      {
        type Pub = {
          tipo: string;
          job?: { evento: string; canal: string; destinatarioId?: string | null };
        };
        const capt: Pub[] = [];
        const desp = {
          capturaNotificacoes: true as const,
          publicar: (e: Pub) => void capt.push(e),
        };
        await runInTenantContext(ds, tenantA, async (em) => {
          const r = await criarMensagem(
            em,
            atorOp,
            {
              chamado_id: id10,
              visibilidade: VisibilidadeMensagem.publica,
              corpo: 'Oi! Vou te ajudar com isso.',
            },
            { despachante: desp },
          );
          ok(r.ok && r.assumiu === true, 'resposta pública do operador → assumiu = true');
          ok((await responsavel(em)) === operador, 'operador que respondeu virou o responsável');
          const evs = await atribuicoes(em);
          ok(evs.length === 1, 'exatamente 1 evento operador_atribuido');
          const ev = evs[0]!;
          ok(ev.ator_id === operador, 'ator do evento = o próprio autor da resposta');
          ok(
            ev.dados.operador_novo === operador &&
              ev.dados.operador_anterior === null &&
              ev.dados.motivo === 'resposta_publica',
            'dados do evento: anterior null → novo = autor, motivo resposta_publica',
          );
          const tudo = await listarEventos(em, atorOp, id10);
          const iMsg = tudo.findIndex((e) => e.tipo === 'mensagem_publicada');
          ok(iMsg >= 0, 'evento mensagem_publicada registrado junto');

          const doCliente = new Set((await listarEventos(em, atorCli, id10)).map((e) => e.tipo));
          ok(!doCliente.has('operador_atribuido'), 'cliente NÃO vê operador_atribuido');
        });
        ok(
          !capt.some(
            (e) =>
              e.tipo === 'notificacao' &&
              e.job?.evento === 'atribuicao' &&
              e.job.canal === 'email' &&
              e.job.destinatarioId === operador,
          ),
          'autor NÃO recebe e-mail da própria auto-atribuição',
        );
      }

      // d) o MESMO operador responde de novo: nada muda (sem evento duplicado).
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarMensagem(em, atorOp, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Complementando a resposta anterior.',
        });
        ok(r.ok && !('assumiu' in r && r.assumiu), 'segunda resposta do responsável — sem assumir');
        ok((await atribuicoes(em)).length === 1, 'nenhum operador_atribuido duplicado');
      });

      // e) segundo operador responde em público: ASSUME (substitui o anterior).
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarMensagem(em, atorOp2, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Assumindo daqui: segue a orientação.',
        });
        ok(r.ok && r.assumiu === true, 'resposta pública do operador2 → assumiu');
        ok((await responsavel(em)) === operador2, 'operador2 substituiu o responsável anterior');
        const evs = await atribuicoes(em);
        const ult = evs[evs.length - 1]!;
        ok(
          evs.length === 2 &&
            ult.dados.operador_anterior === operador &&
            ult.dados.operador_novo === operador2,
          'evento registra anterior = operador → novo = operador2',
        );
      });

      // f) nota interna do operador original NÃO tira o chamado do operador2.
      await runInTenantContext(ds, tenantA, async (em) => {
        await criarMensagem(em, atorOp, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.interna,
          corpo: 'Nota: passei o caso para o colega.',
        });
        ok((await responsavel(em)) === operador2, 'nota interna não reatribui (segue operador2)');
      });

      // g) admin também assume ao responder em público; cliente responder não muda.
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarMensagem(em, atorAdm, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Admin aqui: confirmando a orientação.',
        });
        ok(r.ok && r.assumiu === true, 'resposta pública do admin → assumiu');
        ok((await responsavel(em)) === admin, 'admin virou o responsável');
      });
      await runInTenantContext(ds, tenantA, async (em) => {
        const r = await criarMensagem(em, atorCli, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Obrigado, deu certo.',
        });
        ok(r.ok, 'cliente responde — ok');
        ok((await responsavel(em)) === admin, 'resposta do cliente NÃO muda o responsável');
      });

      // h) atribuição manual explícita continua valendo e é respeitada até a
      //    próxima resposta pública de OUTRO membro da equipe.
      await runInTenantContext(ds, tenantA, async (em) => {
        const a = await atribuirOperador(em, atorAdm, id10, operador);
        ok(a.ok, 'admin atribui manualmente ao operador — ok');
        ok((await responsavel(em)) === operador, 'atribuição manual aplicada');
      });

      // i) cross-tenant (regra 6): operador do tenant B não alcança o chamado de A
      //    — nem mensagem, nem atribuição; o responsável não muda.
      const opB = await runInTenantContext(ds, tenantB, (em) =>
        criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantB,
          email: `op.${sufixo}@b.dev`,
          nome: 'Operador B',
          papel: Papel.operador,
          senha: 'Dev@12345',
        }),
      );
      const atorOpB = { id: opB, tenant_id: tenantB, papel: Papel.operador };
      await runInTenantContext(ds, tenantB, async (em) => {
        const r = await criarMensagem(em, atorOpB, {
          chamado_id: id10,
          visibilidade: VisibilidadeMensagem.publica,
          corpo: 'Tentativa cross-tenant.',
        });
        ok(
          !r.ok && r.motivo === 'chamado_inexistente',
          'operador do tenant B não responde chamado do A (RLS → chamado_inexistente)',
        );
      });
      await runInTenantContext(ds, tenantB, async (em) => {
        // Ator forjado com tenant_id de A, mas a transação é do B: RLS esconde.
        const r = await criarMensagem(
          em,
          { ...atorOpB, tenant_id: tenantA },
          {
            chamado_id: id10,
            visibilidade: VisibilidadeMensagem.publica,
            corpo: 'Tentativa cross-tenant com tenant_id forjado.',
          },
        );
        ok(!r.ok, 'tenant_id forjado no ator não fura o RLS');
      });
      await runInTenantContext(ds, tenantA, async (em) => {
        ok(
          (await responsavel(em)) === operador,
          'responsável do chamado de A intacto após as tentativas do tenant B',
        );
        // O operador de B também não é alvo válido de atribuição em A.
        const a = await atribuirOperador(em, atorAdm, id10, opB);
        ok(!a.ok && a.motivo === 'operador_invalido', 'operador de B não é alvo em A');
      });
    }

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
