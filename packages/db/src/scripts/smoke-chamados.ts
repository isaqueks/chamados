/**
 * Smoke test de Chamado (specs/02, specs/04).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) e prova:
 *  1. numeração sequencial por tenant (2 chamados → 1, 2 consecutivos) e
 *     sequências INDEPENDENTES entre tenants (tenant B recomeça em 1);
 *  2. máquina de estados: caminho válido (sistema→triagem, operador→atendimento→
 *     resolvido) com timestamps; guardrail (agente_ia NÃO resolve); cliente NÃO
 *     faz transição de operador; reabertura incrementa reaberto_count;
 *  3. escopo por papel: o cliente só enxerga os PRÓPRIOS chamados;
 *  4. isolamento RLS: o tenant B não enxerga chamados do tenant A;
 *  5. limites de título (3..160) violados → erro de domínio;
 *  6. complexidade nunca é serializada ao cliente.
 *
 * Sai com 0 se passa; 1 caso contrário.
 */
import { randomUUID } from 'node:crypto';
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource, criarAdminDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { provisionarTenant, criarUsuarioAtivoComSenha } = await import('../auth');
const {
  criarChamado,
  obterChamado,
  listarChamados,
  transicionarStatus,
  definirComplexidade,
  atorSistema,
} = await import('../chamados/chamado-service');
const { Papel, StatusTenant, StatusChamado, Natureza, Prioridade, Complexidade } =
  await import('@chamados/shared');

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FALHOU: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[smoke-chamados] conectado como role da aplicação (sem bypass).');

  const sufixo = randomUUID().slice(0, 8);
  let tenantA = '';
  let tenantB = '';

  try {
    const provA = await provisionarTenant(ds, {
      slug: `smoke-ch-a-${sufixo}`,
      nome: 'Chamados A',
      nomeExibicao: 'Chamados A',
      status: StatusTenant.ativo,
    });
    tenantA = provA.tenant_id;
    const provB = await provisionarTenant(ds, {
      slug: `smoke-ch-b-${sufixo}`,
      nome: 'Chamados B',
      nomeExibicao: 'Chamados B',
      status: StatusTenant.ativo,
    });
    tenantB = provB.tenant_id;

    // Usuários do tenant A.
    const { cliente1, cliente2, operador } = await runInTenantContext(ds, tenantA, async (em) => {
      const cliente1 = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `c1.${sufixo}@a.dev`,
        nome: 'Cliente Um',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      const cliente2 = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `c2.${sufixo}@a.dev`,
        nome: 'Cliente Dois',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      const operador = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `op.${sufixo}@a.dev`,
        nome: 'Olga Operadora',
        papel: Papel.operador,
        senha: 'Dev@12345',
      });
      return { cliente1, cliente2, operador };
    });

    const clienteB = await runInTenantContext(ds, tenantB, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantB,
        email: `c.${sufixo}@b.dev`,
        nome: 'Cliente B',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      }),
    );

    const atorC1 = { id: cliente1, tenant_id: tenantA, papel: Papel.cliente };
    const atorC2 = { id: cliente2, tenant_id: tenantA, papel: Papel.cliente };
    const atorOp = { id: operador, tenant_id: tenantA, papel: Papel.operador };
    const atorIA = { id: provA.agente_ia_id, tenant_id: tenantA, papel: Papel.agente_ia };
    const atorCB = { id: clienteB, tenant_id: tenantB, papel: Papel.cliente };

    // 1) Numeração sequencial por tenant --------------------------------------
    const ch1 = await runInTenantContext(ds, tenantA, (em) =>
      criarChamado(em, atorC1, {
        titulo: 'Erro ao salvar cadastro',
        descricao: 'Ao clicar em salvar, aparece um erro 500.',
        natureza: Natureza.problema,
        prioridade: Prioridade.alta,
      }),
    );
    ok(ch1.ok, 'criar chamado #1 (cliente1) — ok');
    const ch2 = await runInTenantContext(ds, tenantA, (em) =>
      criarChamado(em, atorC2, {
        titulo: 'Solicitar novo relatório',
        descricao: 'Gostaria de um relatório mensal de vendas.',
        natureza: Natureza.alteracao,
      }),
    );
    ok(ch2.ok, 'criar chamado #2 (cliente2) — ok');
    if (!ch1.ok || !ch2.ok) throw new Error('criação falhou');
    ok(ch1.numero === '1', `chamado #1 recebeu numero 1 (recebeu ${ch1.numero})`);
    ok(ch2.numero === '2', `chamado #2 recebeu numero 2 consecutivo (recebeu ${ch2.numero})`);

    const chB = await runInTenantContext(ds, tenantB, (em) =>
      criarChamado(em, atorCB, {
        titulo: 'Primeiro chamado do tenant B',
        descricao: 'Isolamento de numeração entre tenants.',
        natureza: Natureza.problema,
      }),
    );
    ok(chB.ok && chB.numero === '1', 'tenant B tem sequência independente (numero 1)');

    // 2) Máquina de estados ---------------------------------------------------
    // Caminho válido: sistema→em_triagem, operador→em_atendimento.
    await runInTenantContext(ds, tenantA, async (em) => {
      const t1 = await transicionarStatus(
        em,
        atorSistema(tenantA),
        ch1.id,
        StatusChamado.em_triagem,
      );
      ok(t1.ok, 'sistema: novo → em_triagem — ok');
      const t2 = await transicionarStatus(em, atorOp, ch1.id, StatusChamado.em_atendimento);
      ok(t2.ok, 'operador: em_triagem → em_atendimento — ok');
    });

    // Guardrail: agente_ia NUNCA marca resolvido.
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorIA, ch1.id, StatusChamado.resolvido);
      ok(!r.ok, 'agente_ia: em_atendimento → resolvido — NEGADO (guardrail humano)');
      if (!r.ok) ok(r.motivo === 'papel_nao_autorizado', 'motivo = papel_nao_autorizado');
    });

    // Cliente NÃO faz transição de operador (em_atendimento → resolvido).
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorC1, ch1.id, StatusChamado.resolvido);
      ok(!r.ok, 'cliente: em_atendimento → resolvido — NEGADO');
    });

    // Operador resolve; timestamps de resolução/auto-fechamento preenchidos.
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorOp, ch1.id, StatusChamado.resolvido);
      ok(r.ok, 'operador: em_atendimento → resolvido — ok');
      if (r.ok) {
        ok(r.chamado.resolvido_em != null, 'resolvido_em preenchido');
        ok(r.chamado.fechar_automaticamente_em != null, 'fechar_automaticamente_em agendado');
      }
    });

    // Cliente não fecha (resolvido → fechado é de sistema/operador).
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorC1, ch1.id, StatusChamado.fechado);
      ok(!r.ok, 'cliente: resolvido → fechado — NEGADO');
    });

    // Reabertura pelo cliente: resolvido → em_atendimento, reaberto_count++.
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorC1, ch1.id, StatusChamado.em_atendimento);
      ok(r.ok, 'cliente: reabre resolvido → em_atendimento — ok');
      if (r.ok) {
        ok(r.chamado.reaberto_count === 1, 'reaberto_count incrementado para 1');
        ok(r.chamado.resolvido_em == null, 'resolvido_em limpo na reabertura');
        ok(r.chamado.fechar_automaticamente_em == null, 'auto-fechamento cancelado na reabertura');
      }
    });

    // Transição inexistente na tabela: operador novo → resolvido.
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorOp, ch2.id, StatusChamado.resolvido);
      ok(!r.ok, 'operador: novo → resolvido — NEGADO (transição inexistente)');
      if (!r.ok) ok(r.motivo === 'transicao_inexistente', 'motivo = transicao_inexistente');
    });

    // Cliente cancela o PRÓPRIO chamado novo; cliente2 NÃO cancela o de cliente1.
    await runInTenantContext(ds, tenantA, async (em) => {
      const alheio = await transicionarStatus(em, atorC2, ch2.id, StatusChamado.cancelado);
      // ch2 é do cliente2 — cliente2 PODE cancelá-lo (novo → cancelado).
      ok(alheio.ok, 'cliente2: cancela o próprio chamado novo — ok');
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      // cliente1 tentando cancelar um chamado de cliente2 é bloqueado por ownership.
      const outro = await criarChamado(em, atorC2, {
        titulo: 'Outro do cliente2',
        descricao: 'para testar ownership',
        natureza: Natureza.problema,
      });
      if (!outro.ok) throw new Error('criação auxiliar falhou');
      const r = await transicionarStatus(em, atorC1, outro.id, StatusChamado.cancelado);
      ok(!r.ok, 'cliente1: cancelar chamado de cliente2 — NEGADO (ownership)');
      if (!r.ok) ok(r.motivo === 'sem_permissao', 'motivo = sem_permissao');
    });

    // 3) Escopo por papel: cliente só vê os próprios -------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const pag = await listarChamados(em, atorC1, {});
      ok(
        pag.itens.every((c) => c.cliente_id === cliente1),
        'cliente1 só enxerga chamados próprios',
      );
      ok(
        !pag.itens.some((c) => c.cliente_id === cliente2),
        'cliente1 NÃO enxerga chamados do cliente2',
      );
      // Operador vê todos do tenant.
      const pagOp = await listarChamados(em, atorOp, {});
      ok(pagOp.itens.length >= 3, 'operador vê todos os chamados do tenant A');
    });

    // 4) Isolamento RLS entre tenants ----------------------------------------
    await runInTenantContext(ds, tenantB, async (em) => {
      const pag = await listarChamados(em, atorCB, {});
      ok(
        !pag.itens.some((c) => c.id === ch1.id || c.id === ch2.id),
        'tenant B não enxerga chamados do tenant A (RLS)',
      );
      const alvo = await obterChamado(em, atorCB, ch1.id);
      ok(alvo === null, 'obterChamado do tenant A a partir do tenant B → null (RLS)');
    });

    // 5) Limites de título ----------------------------------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const curto = await criarChamado(em, atorC1, {
        titulo: 'ab',
        descricao: 'título curto demais',
        natureza: Natureza.problema,
      });
      ok(!curto.ok, 'título com 2 caracteres → NEGADO');
      if (!curto.ok) ok(curto.motivo === 'titulo_invalido', 'motivo = titulo_invalido (curto)');

      const longo = await criarChamado(em, atorC1, {
        titulo: 'x'.repeat(161),
        descricao: 'título longo demais',
        natureza: Natureza.problema,
      });
      ok(!longo.ok, 'título com 161 caracteres → NEGADO');
      if (!longo.ok) ok(longo.motivo === 'titulo_invalido', 'motivo = titulo_invalido (longo)');
    });

    // 6) Complexidade nunca vai ao cliente -----------------------------------
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await definirComplexidade(em, atorOp, ch1.id, Complexidade.facil);
      ok(r.ok, 'operador define complexidade — ok');
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      const comoCliente = await obterChamado(em, atorC1, ch1.id);
      ok(comoCliente != null, 'cliente obtém o próprio chamado');
      ok(
        comoCliente != null && !('complexidade' in comoCliente),
        'projeção do cliente NÃO contém complexidade',
      );
      ok(
        comoCliente != null && !('operador_id' in comoCliente),
        'projeção do cliente NÃO contém operador_id',
      );
      const comoOperador = await obterChamado(em, atorOp, ch1.id);
      ok(
        comoOperador != null &&
          'complexidade' in comoOperador &&
          comoOperador.complexidade === Complexidade.facil,
        'projeção do operador contém complexidade = facil',
      );
    });

    console.log(
      '\n[smoke-chamados] RESULTADO: PASSOU — Chamado/numeração/máquina de estados confirmados.',
    );
  } finally {
    const admin = criarAdminDataSource();
    await admin.initialize();
    try {
      for (const id of [tenantA, tenantB].filter(Boolean)) {
        await admin.query(`DELETE FROM "chamado" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant_contador" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "categoria" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "usuario" WHERE tenant_id = $1`, [id]);
        await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.warn('[smoke-chamados] aviso: limpeza parcial:', e);
    } finally {
      await admin.destroy();
    }
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('\n[smoke-chamados] RESULTADO: FALHOU —', err.message ?? err);
  process.exit(1);
});
