/**
 * Smoke test de Chamado (specs/02, specs/04).
 *
 * Usa o ROLE DA APLICAÇÃO (SEM BYPASSRLS) e prova:
 *  1. numeração sequencial por tenant (2 chamados → 1, 2 consecutivos) e
 *     sequências INDEPENDENTES entre tenants (tenant B recomeça em 1);
 *  2. máquina de estados: caminho válido (sistema→triagem, operador→atendimento→
 *     resolvido) com timestamps; guardrail (agente_ia NÃO resolve); cliente NÃO
 *     faz transição de operador; reabertura incrementa reaberto_count;
 *  3. escopo por papel (D-037): o cliente LISTA/LÊ todos os chamados do seu
 *     tenant (visão pública) e o recorte `meus` traz só os dele; ler ≠ agir —
 *     ele não transiciona chamado alheio;
 *  4. isolamento RLS: o tenant B não enxerga chamados do tenant A;
 *  5. limites de título (3..160) violados → erro de domínio;
 *  6. complexidade nunca é serializada ao cliente — nem no chamado de OUTRO
 *     cliente do tenant que ele agora consegue ler (D-037);
 *  7. filtros rápidos de situação da fila (D-030): abertos/encerrados/todos,
 *     interseção com status, contadores que ignoram o próprio filtro e RLS;
 *  8. reabertura de encerrado (D-038): `fechado`/`cancelado` → `em_atendimento`
 *     pelo operador e pelo cliente DONO (evento `chamado_reaberto`,
 *     `reaberto_count++`, `fechado_em`/`resolvido_em`/prazo limpos); cliente
 *     NÃO-dono, `agente_ia` e `sistema` negados; nenhuma outra saída do
 *     encerrado; reabrir chamado de OUTRO tenant é impossível (RLS → inexistente).
 *  9. "Novo chamado" do painel (D-040): o seletor de solicitante lista só os
 *     clientes ATIVOS do próprio tenant (nem equipe, nem suspenso, nem cliente
 *     de outro tenant; papel cliente recebe lista vazia); operador abre em nome
 *     de cliente do tenant; cliente de OUTRO tenant, suspenso, não-cliente ou
 *     ausente é recusado (também com tenant_id forjado no ator).
 * 10. janela de aprovação (D-042): prazo padrão 7 dias; colega/IA/operador não
 *     aprovam nem contestam; o solicitante aprova (`chamado_aprovado`, também
 *     pelo caminho da API) ou contesta com motivo (`chamado_contestado`, sem
 *     motivo → recusado); aprovação tácita fecha UMA vez e notifica; tenant B
 *     não aprova/contesta/varre chamados do A (RLS).
 * 11. custo (D-043): estimativa definida/alterada/limpa pela equipe grava
 *     `estimativa_custo_alterada` (idempotente) e gera notificação/webhook;
 *     custo final no ATO de resolver (evento com `origem: 'resolucao'`, sem
 *     notificação própria) e corrigido depois (`custo_final_definido` com
 *     webhook); custo fora de `resolvido` recusado; valor inválido recusado;
 *     cliente LÊ os dois (serializer) mas não define (nem ao resolver); IA não
 *     define; encerrado recusa; tenant B não alcança o chamado do A (RLS) e ator
 *     com tenant forjado é negado; filtro/projeção da fila.
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
  definirEstimativaCusto,
  definirCustoFinal,
  atribuirOperador,
  atorSistema,
} = await import('../chamados/chamado-service');
const {
  listarFilaChamados,
  contarFila,
  listarClientesAtivosDoTenant,
  exportarFilaChamados,
  exportarChamadosVisaoPublica,
} = await import('../chamados/consulta-service');
const { listarEventos } = await import('../chamados/evento-service');
const { aprovarResolucao, contestarResolucao } = await import('../chamados/aprovacao-service');
const { fecharChamadosResolvidosVencidos } = await import('../chamados/manutencao-service');
const { Papel, StatusTenant, StatusChamado, Natureza, Prioridade, Complexidade, EstimativaCusto } =
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

    // D-042: cliente2 (NÃO-dono) não aprova o resolvido do cliente1 (ler ≠ agir).
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorC2, ch1.id, StatusChamado.fechado);
      ok(!r.ok && r.motivo === 'sem_permissao', 'cliente2: aprova chamado alheio — NEGADO');
    });

    // D-042: contestar sem motivo (sem mensagem pública na transação) é recusado.
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorC1, ch1.id, StatusChamado.em_atendimento);
      ok(
        !r.ok && r.motivo === 'motivo_obrigatorio',
        'cliente: resolvido → em_atendimento SEM motivo — NEGADO (motivo_obrigatorio)',
      );
    });

    // Contestação pelo cliente (D-042): motivo → em_atendimento, reaberto_count++.
    await runInTenantContext(ds, tenantA, async (em) => {
      const c = await contestarResolucao(em, atorC1, ch1.id, 'Ainda acontece o erro.');
      ok(c.ok, 'cliente: contesta resolvido com motivo — ok');
      const r = await transicionarStatus(em, atorOp, ch1.id, StatusChamado.em_atendimento);
      ok(!r.ok && r.motivo === 'mesmo_status', 'após contestar, o chamado já está em atendimento');
      const visto = await obterChamado(em, atorOp, ch1.id);
      ok(visto !== null, 'chamado contestado legível');
      if (visto) {
        ok(visto.reaberto_count === 1, 'reaberto_count incrementado para 1 (contestação conta)');
        ok(visto.resolvido_em == null, 'resolvido_em limpo na contestação');
        ok(visto.fechar_automaticamente_em == null, 'prazo de aprovação limpo na contestação');
      }
      const evs = await listarEventos(em, atorOp, ch1.id);
      ok(
        evs.some((e) => e.tipo === 'chamado_contestado') &&
          !evs.some((e) => e.tipo === 'chamado_reaberto'),
        'evento chamado_contestado registrado (sem chamado_reaberto duplicado)',
      );
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
    const chOutro = await runInTenantContext(ds, tenantA, async (em) => {
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
      return outro.id;
    });

    // 3) Escopo por papel (D-037): cliente LÊ o tenant; recorte `meus` ------
    await runInTenantContext(ds, tenantA, async (em) => {
      const pag = await listarChamados(em, atorC1, {});
      ok(
        pag.itens.some((c) => c.cliente_id === cliente1) &&
          pag.itens.some((c) => c.cliente_id === cliente2),
        'cliente1 lista os chamados do tenant — os próprios E os do cliente2 (D-037)',
      );
      ok(
        pag.itens.every((c) => !('complexidade' in c) && !('operador_id' in c)),
        'listagem do cliente segue na projeção pública (sem complexidade/operador_id)',
      );
      const meus = await listarChamados(em, atorC1, { meus: true });
      ok(
        meus.itens.length > 0 && meus.itens.every((c) => c.cliente_id === cliente1),
        'recorte `meus` do cliente1 traz só os chamados de que ele é solicitante',
      );
      // Operador vê todos do tenant.
      const pagOp = await listarChamados(em, atorOp, {});
      ok(pagOp.itens.length >= 3, 'operador vê todos os chamados do tenant A');
    });
    // Ler ≠ agir: cliente1 NÃO reabre/cancela chamado do cliente2 mesmo podendo lê-lo.
    await runInTenantContext(ds, tenantA, async (em) => {
      const visto = await obterChamado(em, atorC1, chOutro);
      ok(visto !== null, 'cliente1 abre (lê) o chamado do cliente2 do mesmo tenant');
      const r = await transicionarStatus(em, atorC1, chOutro, StatusChamado.cancelado);
      ok(!r.ok && r.motivo === 'sem_permissao', 'cliente1 NÃO transiciona chamado alheio');
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
      // D-037: cliente2 lê o chamado do cliente1 — e a projeção é a mesma
      // allowlist: nada interno vaza pelo caminho novo.
      const alheio = await obterChamado(em, atorC2, ch1.id);
      ok(alheio != null, 'cliente2 obtém o chamado do cliente1 (mesmo tenant — D-037)');
      ok(
        alheio != null &&
          !('complexidade' in alheio) &&
          !('operador_id' in alheio) &&
          !('ia_silenciada' in alheio) &&
          !('tenant_id' in alheio),
        'projeção do chamado ALHEIO ao cliente NÃO contém complexidade/operador_id/ia_silenciada',
      );
      const comoOperador = await obterChamado(em, atorOp, ch1.id);
      ok(
        comoOperador != null &&
          'complexidade' in comoOperador &&
          comoOperador.complexidade === Complexidade.facil,
        'projeção do operador contém complexidade = facil',
      );
    });

    // 7) Filtros rápidos de situação na fila (D-030) --------------------------
    // Estado do tenant A: ch1 em_atendimento (aberto), chOutro novo (aberto),
    // ch2 cancelado (encerrado).
    await runInTenantContext(ds, tenantA, async (em) => {
      const abertos = await listarFilaChamados(em, atorOp, { situacao: 'abertos' });
      const ids = abertos.itens.map((c) => c.id);
      ok(ids.includes(ch1.id) && ids.includes(chOutro), 'situação "abertos" traz os dois abertos');
      ok(!ids.includes(ch2.id), 'situação "abertos" NÃO traz o cancelado');

      const encerrados = await listarFilaChamados(em, atorOp, { situacao: 'encerrados' });
      const idsEnc = encerrados.itens.map((c) => c.id);
      ok(idsEnc.includes(ch2.id), 'situação "encerrados" traz o cancelado');
      ok(!idsEnc.includes(ch1.id), 'situação "encerrados" NÃO traz o em_atendimento');

      const todos = await listarFilaChamados(em, atorOp, { situacao: 'todos' });
      ok(todos.itens.length === 3, `situação "todos" traz os 3 (traz ${todos.itens.length})`);

      // Situação combina com status por interseção: aberto + cancelado = vazio.
      const vazio = await listarFilaChamados(em, atorOp, {
        situacao: 'abertos',
        status: StatusChamado.cancelado,
      });
      ok(vazio.itens.length === 0, 'situação "abertos" + status cancelado → vazio (interseção)');

      // Contadores ignoram o PRÓPRIO filtro de situação: os chips somam igual
      // esteja o operador em qual aba estiver.
      for (const situacao of ['abertos', 'encerrados', 'todos'] as const) {
        const c = await contarFila(em, atorOp, { situacao });
        ok(
          c.porSituacao.abertos === 2 && c.porSituacao.encerrados === 1,
          `contadores em "${situacao}": 2 abertos / 1 encerrado`,
        );
        ok(
          c.porSituacao.total === c.porSituacao.abertos + c.porSituacao.encerrados,
          `total = abertos + encerrados em "${situacao}" (partição dos 7 status)`,
        );
      }

      // A fila é área de equipe: cliente não lê nem contando.
      const filaCliente = await listarFilaChamados(em, atorC1, { situacao: 'todos' });
      ok(filaCliente.itens.length === 0, 'cliente não enxerga a fila (área de equipe)');
    });

    // A fila também respeita RLS: do tenant B não se conta o tenant A.
    await runInTenantContext(ds, tenantB, async (em) => {
      const atorOpB = { id: clienteB, tenant_id: tenantB, papel: Papel.operador };
      const c = await contarFila(em, atorOpB, { situacao: 'todos' });
      ok(c.porSituacao.total === 1, 'contadores do tenant B não somam chamados do tenant A (RLS)');
    });

    // 8) Reabertura de encerrado (D-038) --------------------------------------
    // 8a) FECHADO: cliente1 abre; sistema/operador levam até resolvido → fechado.
    const chF = await runInTenantContext(ds, tenantA, async (em) => {
      const c = await criarChamado(em, atorC1, {
        titulo: 'Reabrir depois de fechado',
        descricao: 'O problema voltou depois do fechamento.',
        natureza: Natureza.problema,
      });
      if (!c.ok) throw new Error('criação (fechado) falhou');
      ok(
        (await transicionarStatus(em, atorSistema(tenantA), c.id, StatusChamado.em_triagem)).ok &&
          (await transicionarStatus(em, atorOp, c.id, StatusChamado.em_atendimento)).ok &&
          (await transicionarStatus(em, atorOp, c.id, StatusChamado.resolvido)).ok,
        'D-038: chamado do cliente1 levado a resolvido',
      );
      const f = await transicionarStatus(em, atorSistema(tenantA), c.id, StatusChamado.fechado);
      ok(f.ok && f.chamado.fechado_em != null, 'D-038: sistema fecha (fechado_em preenchido)');
      return c.id;
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      for (const [nome, ator] of [
        ['agente_ia', atorIA],
        ['sistema', atorSistema(tenantA)],
      ] as const) {
        const r = await transicionarStatus(em, ator, chF, StatusChamado.em_atendimento);
        ok(
          !r.ok && r.motivo === 'estado_terminal',
          `D-038: ${nome} NÃO reabre fechado (estado_terminal)`,
        );
      }
      const alheio = await transicionarStatus(em, atorC2, chF, StatusChamado.em_atendimento);
      ok(
        !alheio.ok && alheio.motivo === 'sem_permissao',
        'D-038: cliente2 (não-dono) NÃO reabre o fechado do cliente1 (sem_permissao)',
      );
      for (const para of [
        StatusChamado.resolvido,
        StatusChamado.aguardando_cliente,
        StatusChamado.em_triagem,
        StatusChamado.cancelado,
        StatusChamado.novo,
      ]) {
        const r = await transicionarStatus(em, atorOp, chF, para);
        ok(
          !r.ok && r.motivo === 'estado_terminal',
          `D-038: fechado → ${para} NEGADO (só a reabertura sai do encerrado)`,
        );
      }

      const r = await transicionarStatus(em, atorC1, chF, StatusChamado.em_atendimento);
      ok(r.ok, 'D-038: cliente1 (dono) reabre fechado → em_atendimento');
      if (r.ok) {
        ok(r.chamado.status === StatusChamado.em_atendimento, 'status = em_atendimento');
        ok(r.chamado.reaberto_count === 1, 'reaberto_count = 1');
        ok(r.chamado.fechado_em == null, 'fechado_em limpo na reabertura');
        ok(r.chamado.resolvido_em == null, 'resolvido_em limpo na reabertura');
        ok(r.chamado.fechar_automaticamente_em == null, 'prazo de auto-fechamento limpo');
      }
      const evs = await listarEventos(em, atorOp, chF);
      ok(
        evs.some(
          (e) =>
            e.tipo === 'chamado_reaberto' &&
            (e.dados as { de?: string }).de === StatusChamado.fechado,
        ),
        'evento chamado_reaberto registrado (de = fechado)',
      );

      // Operador reabre de novo após outro ciclo resolvido → fechado (manual).
      ok(
        (await transicionarStatus(em, atorOp, chF, StatusChamado.resolvido)).ok &&
          (await transicionarStatus(em, atorOp, chF, StatusChamado.fechado)).ok,
        'D-038: operador resolve e fecha manualmente',
      );
      const rOp = await transicionarStatus(em, atorOp, chF, StatusChamado.em_atendimento);
      ok(rOp.ok && rOp.chamado.reaberto_count === 2, 'D-038: operador reabre fechado (count = 2)');
    });

    // 8b) CANCELADO: cliente1 cancela o próprio chamado novo.
    const chX = await runInTenantContext(ds, tenantA, async (em) => {
      const c = await criarChamado(em, atorC1, {
        titulo: 'Reabrir depois de cancelado',
        descricao: 'Cancelei por engano.',
        natureza: Natureza.problema,
      });
      if (!c.ok) throw new Error('criação (cancelado) falhou');
      const x = await transicionarStatus(em, atorC1, c.id, StatusChamado.cancelado);
      ok(x.ok, 'D-038: cliente1 cancela o próprio chamado novo');
      return c.id;
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      const ia = await transicionarStatus(em, atorIA, chX, StatusChamado.em_atendimento);
      ok(!ia.ok && ia.motivo === 'estado_terminal', 'D-038: agente_ia NÃO reabre cancelado');
      const alheio = await transicionarStatus(em, atorC2, chX, StatusChamado.em_atendimento);
      ok(
        !alheio.ok && alheio.motivo === 'sem_permissao',
        'D-038: cliente2 (não-dono) NÃO reabre o cancelado do cliente1',
      );
      const triagem = await transicionarStatus(
        em,
        atorSistema(tenantA),
        chX,
        StatusChamado.em_triagem,
      );
      ok(!triagem.ok, 'D-038: cancelado → em_triagem NEGADO (triagem não volta sozinha)');

      const rOp = await transicionarStatus(em, atorOp, chX, StatusChamado.em_atendimento);
      ok(
        rOp.ok && rOp.chamado.status === StatusChamado.em_atendimento,
        'D-038: operador reabre cancelado → em_atendimento',
      );
      if (rOp.ok) ok(rOp.chamado.reaberto_count === 1, 'reaberto_count = 1 (cancelado)');

      ok(
        (await transicionarStatus(em, atorOp, chX, StatusChamado.cancelado)).ok,
        'D-038: operador cancela de novo',
      );
      const rC = await transicionarStatus(em, atorC1, chX, StatusChamado.em_atendimento);
      ok(rC.ok && rC.chamado.reaberto_count === 2, 'D-038: cliente1 (dono) reabre cancelado');
      const evs = await listarEventos(em, atorOp, chX);
      ok(
        evs.filter((e) => e.tipo === 'chamado_reaberto').length === 2,
        'dois eventos chamado_reaberto no cancelado reaberto duas vezes',
      );
    });

    // 8c) Cross-tenant (regra 6): ninguém do tenant A reabre um chamado do B.
    const chBX = await runInTenantContext(ds, tenantB, async (em) => {
      const c = await criarChamado(em, atorCB, {
        titulo: 'Cancelado do tenant B',
        descricao: 'Não pode ser reaberto de fora.',
        natureza: Natureza.problema,
      });
      if (!c.ok) throw new Error('criação (tenant B) falhou');
      ok(
        (await transicionarStatus(em, atorCB, c.id, StatusChamado.cancelado)).ok,
        'D-038: clienteB cancela o próprio chamado no tenant B',
      );
      return c.id;
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorOp, chBX, StatusChamado.em_atendimento);
      ok(
        !r.ok && r.motivo === 'inexistente',
        'D-038: operador do tenant A NÃO reabre cancelado do tenant B (RLS → inexistente)',
      );
      // Mesmo forjando o tenant no ator, o contexto RLS é o do A.
      const forjado = { id: operador, tenant_id: tenantB, papel: Papel.operador };
      const r2 = await transicionarStatus(em, forjado, chBX, StatusChamado.em_atendimento);
      ok(!r2.ok, 'D-038: ator com tenant_id forjado também é negado');
    });
    await runInTenantContext(ds, tenantB, async (em) => {
      const visto = await obterChamado(em, atorCB, chBX);
      ok(visto?.status === StatusChamado.cancelado, 'D-038: chamado do tenant B segue cancelado');
      const r = await transicionarStatus(em, atorCB, chBX, StatusChamado.em_atendimento);
      ok(r.ok, 'D-038: clienteB (dono, no próprio tenant) reabre o cancelado');
    });

    // 9) "Novo chamado" do painel — D-040 (bloco próprio; regra 6) ----------
    console.log('\n[9] D-040: solicitante do "Novo chamado" (seletor + criação em nome de)');
    const { clienteSuspenso } = await runInTenantContext(ds, tenantA, async (em) => {
      const clienteSuspenso = await criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantA,
        email: `susp.${sufixo}@a.dev`,
        nome: 'Cliente Suspenso',
        papel: Papel.cliente,
        senha: 'Dev@12345',
      });
      await em.query(`UPDATE usuario SET status = 'suspenso' WHERE id = $1`, [clienteSuspenso]);
      return { clienteSuspenso };
    });
    const operadorB = await runInTenantContext(ds, tenantB, (em) =>
      criarUsuarioAtivoComSenha(em, {
        tenant_id: tenantB,
        email: `op.${sufixo}@b.dev`,
        nome: 'Operador B',
        papel: Papel.operador,
        senha: 'Dev@12345',
      }),
    );
    const atorOpB = { id: operadorB, tenant_id: tenantB, papel: Papel.operador };

    await runInTenantContext(ds, tenantA, async (em) => {
      const lista = await listarClientesAtivosDoTenant(em, atorOp);
      const ids = new Set(lista.map((c) => c.id));
      ok(
        ids.has(cliente1) && ids.has(cliente2),
        'D-040: seletor do tenant A traz os clientes ativos do A',
      );
      ok(!ids.has(clienteB), 'D-040: seletor do tenant A NÃO traz cliente do tenant B');
      ok(!ids.has(clienteSuspenso), 'D-040: seletor NÃO traz cliente suspenso');
      ok(
        !ids.has(operador) && !ids.has(provA.agente_ia_id),
        'D-040: seletor NÃO traz equipe nem o agente_ia',
      );
      ok(
        lista.every((c) => typeof c.nome === 'string' && c.email.includes('@')),
        'D-040: cada opção traz nome e e-mail',
      );
      ok(
        (await listarClientesAtivosDoTenant(em, atorC1)).length === 0,
        'D-040: papel cliente recebe lista vazia (fail-closed)',
      );
      ok(
        (await listarClientesAtivosDoTenant(em, atorIA)).length === 0,
        'D-040: agente_ia recebe lista vazia',
      );
    });

    await runInTenantContext(ds, tenantB, async (em) => {
      const ids = (await listarClientesAtivosDoTenant(em, atorOpB)).map((c) => c.id);
      ok(
        ids.includes(clienteB) && !ids.includes(cliente1) && !ids.includes(cliente2),
        'D-040: seletor do tenant B traz só os clientes do B',
      );
    });

    await runInTenantContext(ds, tenantA, async (em) => {
      const base = {
        titulo: 'Aberto pelo painel',
        descricao: 'Cliente ligou relatando erro.',
        natureza: Natureza.problema,
      };
      const r = await criarChamado(em, atorOp, { ...base, cliente_id: cliente1 });
      ok(r.ok, 'D-040: operador abre chamado em nome de cliente1 (mesmo tenant)');
      if (r.ok) {
        const visto = await obterChamado(em, atorOp, r.id);
        ok(
          visto !== null && 'cliente_id' in visto && visto.cliente_id === cliente1,
          'D-040: o solicitante gravado é o cliente1 (não o operador)',
        );
        const evs = await listarEventos(em, atorOp, r.id);
        ok(
          evs.some((e) => e.tipo === 'chamado_criado'),
          'D-040: evento chamado_criado registrado',
        );
      }

      const outroTenant = await criarChamado(em, atorOp, { ...base, cliente_id: clienteB });
      ok(
        !outroTenant.ok && outroTenant.motivo === 'solicitante_invalido',
        'D-040: cliente de OUTRO tenant como solicitante → solicitante_invalido',
      );
      const forjado = { id: operador, tenant_id: tenantB, papel: Papel.operador };
      const rForjado = await criarChamado(em, forjado, { ...base, cliente_id: clienteB });
      ok(
        !rForjado.ok,
        'D-040: tenant_id forjado no ator não abre em nome de cliente do B (RLS do A)',
      );
      const suspenso = await criarChamado(em, atorOp, { ...base, cliente_id: clienteSuspenso });
      ok(
        !suspenso.ok && suspenso.motivo === 'solicitante_invalido',
        'D-040: cliente suspenso como solicitante → solicitante_invalido',
      );
      const naoCliente = await criarChamado(em, atorOp, { ...base, cliente_id: operador });
      ok(
        !naoCliente.ok && naoCliente.motivo === 'solicitante_invalido',
        'D-040: operador como solicitante → solicitante_invalido',
      );
      const semSolicitante = await criarChamado(em, atorOp, base);
      ok(
        !semSolicitante.ok && semSolicitante.motivo === 'solicitante_obrigatorio',
        'D-040: sem solicitante → solicitante_obrigatorio',
      );
    });

    await runInTenantContext(ds, tenantB, async (em) => {
      const { itens } = await listarChamados(em, atorCB, {});
      ok(
        itens.every((c) => c.titulo !== 'Aberto pelo painel'),
        'D-040: nenhum chamado aberto pelo painel do A aparece no tenant B',
      );
    });

    // 10) Janela de aprovação do cliente (D-042) ------------------------------
    // Leva um chamado do cliente1 até `resolvido` (operador) e devolve o id.
    const resolverPara = async (titulo: string): Promise<string> =>
      runInTenantContext(ds, tenantA, async (em) => {
        const c = await criarChamado(em, atorC1, {
          titulo,
          descricao: 'Janela de aprovação (D-042).',
          natureza: Natureza.problema,
        });
        if (!c.ok) throw new Error(`criação (${titulo}) falhou`);
        ok(
          (await transicionarStatus(em, atorSistema(tenantA), c.id, StatusChamado.em_triagem)).ok &&
            (await transicionarStatus(em, atorOp, c.id, StatusChamado.em_atendimento)).ok &&
            (await transicionarStatus(em, atorOp, c.id, StatusChamado.resolvido)).ok,
          `D-042: "${titulo}" levado a resolvido`,
        );
        return c.id;
      });

    // 10a) Prazo padrão de 7 dias (migration 0013: DEFAULT 7).
    const chAp = await resolverPara('Aprovar explicitamente');
    await runInTenantContext(ds, tenantA, async (em) => {
      const [t] = (await em.query(
        `SELECT dias_fechamento_automatico AS dias FROM tenant WHERE id = $1`,
        [tenantA],
      )) as Array<{ dias: number }>;
      ok(t?.dias === 7, 'D-042: tenant novo nasce com prazo de aprovação = 7 dias');
      const v = await obterChamado(em, atorOp, chAp);
      ok(
        !!v &&
          !!v.resolvido_em &&
          !!v.fechar_automaticamente_em &&
          new Date(v.fechar_automaticamente_em).getTime() - new Date(v.resolvido_em).getTime() ===
            7 * 86_400_000,
        'D-042: prazo = resolvido_em + 7 dias',
      );
      // O cliente também enxerga o prazo (projeção pública).
      const doCliente = await obterChamado(em, atorC1, chAp);
      ok(
        !!doCliente && doCliente.fechar_automaticamente_em != null,
        'D-042: o prazo aparece na projeção do cliente',
      );
    });

    // 10b) Colega do tenant LÊ, mas não aprova nem contesta; IA e operador não "aprovam".
    await runInTenantContext(ds, tenantA, async (em) => {
      ok((await obterChamado(em, atorC2, chAp)) !== null, 'D-042: cliente2 lê o resolvido alheio');
      const ap = await aprovarResolucao(em, atorC2, chAp);
      ok(!ap.ok && ap.motivo === 'sem_permissao', 'D-042: cliente2 NÃO aprova o alheio');
      const ct = await contestarResolucao(em, atorC2, chAp, 'Não concordo.');
      ok(!ct.ok && ct.motivo === 'sem_permissao', 'D-042: cliente2 NÃO contesta o alheio');
      const ia = await transicionarStatus(em, atorIA, chAp, StatusChamado.fechado);
      ok(!ia.ok && ia.motivo === 'papel_nao_autorizado', 'D-042: agente_ia NÃO aprova');
      const op = await aprovarResolucao(em, atorOp, chAp);
      ok(!op.ok && op.motivo === 'sem_permissao', 'D-042: aprovar é do cliente (operador fecha)');
      const msgs = (await em.query(
        `SELECT count(*)::int AS n FROM mensagem WHERE chamado_id = $1`,
        [chAp],
      )) as Array<{ n: number }>;
      ok(msgs[0]?.n === 0, 'D-042: a contestação negada não deixou mensagem');
    });

    // 10c) O solicitante APROVA: fechado, fechado_em, evento chamado_aprovado (explícita).
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await aprovarResolucao(em, atorC1, chAp);
      ok(r.ok, 'D-042: cliente1 (dono) aprova');
      const v = await obterChamado(em, atorOp, chAp);
      ok(v?.status === StatusChamado.fechado, 'D-042: aprovado → fechado');
      ok(
        v?.fechado_em != null && v?.fechar_automaticamente_em == null,
        'D-042: fechado_em gravado',
      );
      const evs = await listarEventos(em, atorC1, chAp);
      const ev = evs.find((e) => e.tipo === 'chamado_aprovado');
      ok(
        !!ev &&
          (ev.dados as { aprovacao?: string }).aprovacao === 'explicita' &&
          ev.ator_id === cliente1,
        'D-042: evento chamado_aprovado (aprovacao = explicita, ator = cliente) visível ao cliente',
      );
      ok(!evs.some((e) => e.tipo === 'chamado_fechado'), 'D-042: sem chamado_fechado duplicado');
      const de2 = await aprovarResolucao(em, atorC1, chAp);
      ok(!de2.ok && de2.motivo === 'fora_da_janela', 'D-042: aprovar de novo → fora_da_janela');
    });

    // 10d) Aprovação pela máquina (caminho da API: POST /status {status:'fechado'}).
    const chApi = await resolverPara('Aprovar pela API');
    await runInTenantContext(ds, tenantA, async (em) => {
      const r = await transicionarStatus(em, atorC1, chApi, StatusChamado.fechado);
      ok(r.ok, 'D-042: cliente dono aprova via transicionarStatus (API)');
      const evs = await listarEventos(em, atorOp, chApi);
      ok(
        evs.some((e) => e.tipo === 'chamado_aprovado'),
        'D-042: API também grava chamado_aprovado',
      );
    });

    // 10e) Aprovação TÁCITA: varredura com relógio adiantado fecha uma única vez.
    const chTac = await resolverPara('Aprovar tacitamente');
    const capturados: Array<{
      tipo: string;
      job?: { evento: string; contexto: { aprovacao?: string | null } };
    }> = [];
    const desp = {
      capturaNotificacoes: true as const,
      publicar: (e: { tipo: string }) => void capturados.push(e as (typeof capturados)[number]),
    };
    const daqui8Dias = new Date(Date.now() + 8 * 86_400_000);
    // Cross-tenant: a varredura do tenant B nunca fecha resolvido do A.
    await runInTenantContext(ds, tenantB, (em) =>
      fecharChamadosResolvidosVencidos(em, tenantB, undefined, daqui8Dias),
    );
    await runInTenantContext(ds, tenantA, async (em) => {
      const v = await obterChamado(em, atorOp, chTac);
      ok(v?.status === StatusChamado.resolvido, 'D-042: varredura do tenant B não toca o tenant A');
    });
    const r1 = await runInTenantContext(ds, tenantA, (em) =>
      fecharChamadosResolvidosVencidos(em, tenantA, { despachante: desp }, daqui8Dias),
    );
    ok(r1.fechados.includes(chTac), 'D-042: prazo vencido → fechado (aprovação tácita)');
    const r2 = await runInTenantContext(ds, tenantA, (em) =>
      fecharChamadosResolvidosVencidos(em, tenantA, { despachante: desp }, daqui8Dias),
    );
    ok(!r2.fechados.includes(chTac), 'D-042: segunda varredura não fecha de novo (idempotente)');
    await runInTenantContext(ds, tenantA, async (em) => {
      const evs = await listarEventos(em, atorC1, chTac);
      const tacitos = evs.filter((e) => e.tipo === 'chamado_fechado_auto');
      ok(
        tacitos.length === 1 &&
          (tacitos[0]!.dados as { aprovacao?: string }).aprovacao === 'tacita',
        'D-042: UM evento chamado_fechado_auto com aprovacao = tacita',
      );
    });
    ok(
      capturados.some(
        (e) =>
          e.tipo === 'notificacao' &&
          e.job?.evento === 'aprovado' &&
          e.job.contexto.aprovacao === 'tacita',
      ),
      'D-042: aprovação tácita gera notificação `aprovado` (forma tácita)',
    );

    // 10f) Contestar exige motivo e reabre; cross-tenant não alcança o chamado.
    const chCt = await resolverPara('Contestar');
    await runInTenantContext(ds, tenantA, async (em) => {
      const vazio = await contestarResolucao(em, atorC1, chCt, '   ');
      ok(
        !vazio.ok && vazio.motivo === 'motivo_obrigatorio',
        'D-042: contestar sem motivo → recusado',
      );
    });
    await runInTenantContext(ds, tenantB, async (em) => {
      const a = await aprovarResolucao(em, atorCB, chCt);
      ok(
        !a.ok && a.motivo === 'inexistente',
        'D-042: cliente do tenant B não aprova (RLS → inexistente)',
      );
      const c = await contestarResolucao(em, atorCB, chCt, 'Forjado');
      ok(
        !c.ok && c.motivo === 'inexistente',
        'D-042: cliente do tenant B não contesta (inexistente)',
      );
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      // Ator do tenant B com o contexto do A (tenant_id forjado): ownership nega.
      const forjado = { id: clienteB, tenant_id: tenantA, papel: Papel.cliente };
      const a = await aprovarResolucao(em, forjado, chCt);
      ok(!a.ok && a.motivo === 'sem_permissao', 'D-042: ator forjado não aprova chamado do A');
      const c = await contestarResolucao(em, atorC1, chCt, 'O relatório ainda sai vazio.');
      ok(c.ok, 'D-042: cliente1 contesta com motivo');
      const v = await obterChamado(em, atorOp, chCt);
      ok(v?.status === StatusChamado.em_atendimento, 'D-042: contestado → em_atendimento');
      const evs = await listarEventos(em, atorOp, chCt);
      const ev = evs.find((e) => e.tipo === 'chamado_contestado');
      ok(
        !!ev && c.ok && (ev.dados as { mensagem_id?: string }).mensagem_id === c.mensagem_id,
        'D-042: chamado_contestado aponta para a mensagem do motivo',
      );
    });

    // 11) Custo do chamado (D-043) ----------------------------------------------
    const capCusto: Array<{
      tipo: string;
      job?: { evento: string; canal: string; contexto: Record<string, unknown> };
    }> = [];
    const despCusto = {
      capturaNotificacoes: true as const,
      publicar: (e: { tipo: string }) => void capCusto.push(e as (typeof capCusto)[number]),
    };
    const chCusto = await runInTenantContext(ds, tenantA, async (em) => {
      const c = await criarChamado(em, atorC1, {
        titulo: 'Custo do chamado',
        descricao: 'Estimativa e custo final (D-043).',
        natureza: Natureza.alteracao,
      });
      if (!c.ok) throw new Error('criação (custo) falhou');
      return c.id;
    });

    // 11a) Estimativa: operador define/altera/limpa; idempotente; cliente/IA não.
    await runInTenantContext(ds, tenantA, async (em) => {
      const cli = await definirEstimativaCusto(em, atorC1, chCusto, EstimativaCusto.B);
      ok(!cli.ok && cli.motivo === 'sem_permissao', 'D-043: cliente dono NÃO define estimativa');
      const ia = await definirEstimativaCusto(em, atorIA, chCusto, EstimativaCusto.B);
      ok(!ia.ok && ia.motivo === 'sem_permissao', 'D-043: agente_ia NÃO define estimativa');
      const inval = await definirEstimativaCusto(
        em,
        atorOp,
        chCusto,
        'Z' as unknown as typeof EstimativaCusto.A,
      );
      ok(!inval.ok && inval.motivo === 'valor_invalido', 'D-043: código inválido recusado');

      const a = await definirEstimativaCusto(em, atorOp, chCusto, EstimativaCusto.A, {
        despachante: despCusto,
      });
      ok(a.ok && a.alterado, 'D-043: operador define estimativa A');
      const b = await definirEstimativaCusto(em, atorOp, chCusto, EstimativaCusto.B, {
        despachante: despCusto,
      });
      ok(b.ok && b.alterado, 'D-043: operador altera para B');
      const mesmo = await definirEstimativaCusto(em, atorOp, chCusto, EstimativaCusto.B, {
        despachante: despCusto,
      });
      ok(mesmo.ok && !mesmo.alterado, 'D-043: mesmo valor → sem evento (idempotente)');

      const evs = await listarEventos(em, atorC1, chCusto);
      const est = evs.filter((e) => e.tipo === 'estimativa_custo_alterada');
      ok(
        est.length === 2 &&
          (est[0]!.dados as { de: unknown; para: unknown }).de === null &&
          (est[1]!.dados as { de: unknown; para: unknown }).para === 'B',
        'D-043: dois eventos estimativa_custo_alterada (null→A, A→B), visíveis ao cliente',
      );
      const v = await obterChamado(em, atorC1, chCusto);
      ok(
        !!v && v.estimativa_custo === 'B' && !('complexidade' in v),
        'D-043: cliente LÊ a estimativa (e continua sem complexidade)',
      );
      // Colega do tenant (D-037) também lê.
      const v2 = await obterChamado(em, atorC2, chCusto);
      ok(v2?.estimativa_custo === 'B', 'D-043: colega do tenant lê a estimativa');
    });
    ok(
      !capCusto.some(
        (e) =>
          e.tipo === 'notificacao' &&
          e.job?.evento === 'estimativa_custo' &&
          e.job.canal === 'email',
      ),
      'D-043: estimativa é opt-in — sem preferência ligada, nenhum e-mail (anti-flood)',
    );

    // 11b) Fila: projeção e filtro por estimativa.
    await runInTenantContext(ds, tenantA, async (em) => {
      const fila = await listarFilaChamados(em, atorOp, {
        estimativa_custo: EstimativaCusto.B,
        situacao: 'todos',
      });
      ok(
        fila.itens.some((i) => i.id === chCusto && i.estimativa_custo === 'B') &&
          fila.itens.every((i) => i.estimativa_custo === 'B'),
        'D-043: fila filtra por estimativa B e projeta o campo',
      );
      const sem = await listarFilaChamados(em, atorOp, {
        estimativa_custo: 'sem_estimativa',
        situacao: 'todos',
      });
      ok(
        !sem.itens.some((i) => i.id === chCusto) && sem.itens.every((i) => !i.estimativa_custo),
        'D-043: filtro sem_estimativa exclui o chamado estimado',
      );
    });

    // 11c) Custo final: fora de resolvido recusado; no ato de resolver (equipe).
    await runInTenantContext(ds, tenantA, async (em) => {
      const fora = await definirCustoFinal(em, atorOp, chCusto, 100);
      ok(
        !fora.ok && fora.motivo === 'custo_fora_da_resolucao',
        'D-043: custo final antes de resolver → custo_fora_da_resolucao',
      );
      ok(
        (await transicionarStatus(em, atorSistema(tenantA), chCusto, StatusChamado.em_triagem))
          .ok && (await transicionarStatus(em, atorOp, chCusto, StatusChamado.em_atendimento)).ok,
        'D-043: chamado levado a em_atendimento',
      );
      const neg = await transicionarStatus(em, atorOp, chCusto, StatusChamado.resolvido, {
        custo_final: -10,
      });
      ok(
        !neg.ok && neg.motivo === 'valor_invalido',
        'D-043: custo negativo ao resolver → recusado',
      );
      const v = await obterChamado(em, atorOp, chCusto);
      ok(v?.status === StatusChamado.em_atendimento, 'D-043: recusa não tocou o status');

      const r = await transicionarStatus(
        em,
        atorOp,
        chCusto,
        StatusChamado.resolvido,
        { custo_final: 150.5 },
        { despachante: despCusto },
      );
      ok(r.ok && r.chamado.custo_final === 150.5, 'D-043: resolvido com custo final R$ 150,50');
      const evs = await listarEventos(em, atorC1, chCusto);
      const cf = evs.filter((e) => e.tipo === 'custo_final_definido');
      ok(
        cf.length === 1 && (cf[0]!.dados as { origem?: string }).origem === 'resolucao',
        'D-043: custo no ato de resolver grava custo_final_definido (origem = resolucao)',
      );
    });
    ok(
      !capCusto.some((e) => e.tipo === 'notificacao' && e.job?.evento === 'custo_final'),
      'D-043: custo no ato de resolver NÃO gera notificação/webhook próprios',
    );
    ok(
      capCusto.some((e) => e.tipo === 'notificacao' && e.job?.evento === 'resolvido'),
      'D-043: o `resolvido` notifica (o payload carrega custo_final)',
    );

    // 11c') A agente_ia pode resolver dúvida (em_triagem → resolvido), mas NUNCA
    // com custo: a transição inteira é negada antes de escrever.
    await runInTenantContext(ds, tenantA, async (em) => {
      const c = await criarChamado(em, atorC1, {
        titulo: 'Dúvida com custo',
        descricao: 'IA não informa custo (D-043).',
        natureza: Natureza.duvida,
      });
      if (!c.ok) throw new Error('criação (dúvida) falhou');
      await transicionarStatus(em, atorSistema(tenantA), c.id, StatusChamado.em_triagem);
      const r = await transicionarStatus(em, atorIA, c.id, StatusChamado.resolvido, {
        custo_final: 10,
      });
      ok(!r.ok && r.motivo === 'sem_permissao', 'D-043: agente_ia resolvendo COM custo → negado');
      const v = await obterChamado(em, atorOp, c.id);
      ok(
        v?.status === StatusChamado.em_triagem && v.custo_final === null,
        'D-043: nada foi gravado',
      );
    });

    // 11d) Correção depois de resolvido; cliente lê mas não define; cross-tenant.
    await runInTenantContext(ds, tenantA, async (em) => {
      const v = await obterChamado(em, atorC1, chCusto);
      ok(v?.custo_final === 150.5, 'D-043: cliente LÊ o custo final');
      const cli = await definirCustoFinal(em, atorC1, chCusto, 1);
      ok(!cli.ok && cli.motivo === 'sem_permissao', 'D-043: cliente NÃO define custo final');
      const tresCasas = await definirCustoFinal(em, atorOp, chCusto, 10.555);
      ok(
        !tresCasas.ok && tresCasas.motivo === 'valor_invalido',
        'D-043: 3 casas decimais → valor_invalido',
      );
      const corr = await definirCustoFinal(em, atorOp, chCusto, 180, { despachante: despCusto });
      ok(corr.ok && corr.alterado, 'D-043: operador corrige o custo final para R$ 180,00');
      const igual = await definirCustoFinal(em, atorOp, chCusto, 180, { despachante: despCusto });
      ok(igual.ok && !igual.alterado, 'D-043: mesmo custo → sem evento (idempotente)');
      const evs = await listarEventos(em, atorOp, chCusto);
      const ult = evs.filter((e) => e.tipo === 'custo_final_definido').pop();
      ok(
        !!ult &&
          (ult.dados as { de?: unknown }).de === 150.5 &&
          (ult.dados as { para?: unknown }).para === 180 &&
          (ult.dados as { origem?: unknown }).origem === undefined,
        'D-043: correção grava custo_final_definido { de: 150.5, para: 180 }',
      );
    });
    ok(
      capCusto.some(
        (e) =>
          e.tipo === 'notificacao' &&
          e.job?.evento === 'custo_final' &&
          (e.job.contexto.custo as { para?: unknown } | undefined)?.para === 180,
      ),
      'D-043: correção do custo gera notificação `custo_final` com valores numéricos',
    );
    await runInTenantContext(ds, tenantB, async (em) => {
      const opB = { id: clienteB, tenant_id: tenantB, papel: Papel.operador };
      const e = await definirEstimativaCusto(em, opB, chCusto, EstimativaCusto.E);
      ok(!e.ok && e.motivo === 'inexistente', 'D-043: tenant B não define estimativa no A (RLS)');
      const c = await definirCustoFinal(em, opB, chCusto, 1);
      ok(!c.ok && c.motivo === 'inexistente', 'D-043: tenant B não define custo no A (RLS)');
      const v = await obterChamado(em, atorCB, chCusto);
      ok(v === null, 'D-043: tenant B não lê o custo do A');
    });

    // 11e) `custo_final` só vale em → resolvido: no aprovar do cliente é IGNORADO
    // (a aprovação segue e o custo não muda); depois, encerrado recusa tudo.
    await runInTenantContext(ds, tenantA, async (em) => {
      const ap = await transicionarStatus(em, atorC1, chCusto, StatusChamado.fechado, {
        custo_final: 0,
      });
      ok(ap.ok && ap.chamado.custo_final === 180, 'D-043: aprovação ignora custo_final do cliente');
    });
    await runInTenantContext(ds, tenantA, async (em) => {
      const e = await definirEstimativaCusto(em, atorOp, chCusto, EstimativaCusto.C);
      ok(!e.ok && e.motivo === 'estado_terminal', 'D-043: estimativa em fechado → estado_terminal');
      const c = await definirCustoFinal(em, atorOp, chCusto, 200);
      ok(!c.ok && c.motivo === 'estado_terminal', 'D-043: custo em fechado → estado_terminal');
    });

    // 12) Fila D-045: filtros novos, ordenação/paginação e exportações ----------
    // Bloco próprio (regra 6): responsável específico, solicitante, período,
    // ordenação + offset sem repetir/pular, exportação da equipe = recorte da
    // tela, exportação pública sem campos internos e tudo isolado por RLS.
    console.log('\n[12] D-045: filtros novos, ordenação/paginação e exportação');
    const PRIOS_D045 = [Prioridade.baixa, Prioridade.urgente, Prioridade.media];
    const idsD045 = await runInTenantContext(ds, tenantA, async (em) => {
      const ids: string[] = [];
      for (const [i, prioridade] of PRIOS_D045.entries()) {
        const c = await criarChamado(em, atorC2, {
          titulo: `D-045 fila ${i}`,
          descricao: 'Chamado do bloco 12 (fila/exportação).',
          natureza: Natureza.duvida,
          prioridade,
        });
        if (!c.ok) throw new Error('criação (D-045) falhou');
        ids.push(c.id);
      }
      const at = await atribuirOperador(em, atorOp, ids[1]!, operador);
      ok(at.ok, 'D-045: operador assume o chamado urgente do bloco');
      return ids;
    });
    const [d045Baixa, d045Urgente, d045Media] = idsD045 as [string, string, string];
    const hojeSp = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const RANK_PRIO: Record<string, number> = { baixa: 0, media: 1, alta: 2, urgente: 3 };

    await runInTenantContext(ds, tenantA, async (em) => {
      // 12a) Responsável específico (+ contadores por operador e "filtrados").
      const doOp = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        operador_id: operador,
        limite: 100,
      });
      ok(
        doOp.itens.some((i) => i.id === d045Urgente) &&
          doOp.itens.every((i) => i.operador_id === operador),
        'D-045: filtro por responsável específico traz só os chamados dele',
      );
      const cont = await contarFila(em, atorOp, { situacao: 'todos', operador_id: operador });
      ok(
        cont.porOperador[operador] === doOp.itens.length && cont.filtrados === doOp.itens.length,
        `D-045: porOperador/filtrados batem com a listagem (${doOp.itens.length})`,
      );
      ok(
        cont.total ===
          cont.naoAtribuidos + Object.values(cont.porOperador).reduce((a, b) => a + b, 0),
        'D-045: total = não atribuídos + soma por operador (contagem ignora o próprio filtro)',
      );
      const lixo = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        operador_id: "x' OR 1=1 --",
      });
      ok(lixo.itens.length === 0, 'D-045: UUID malformado no responsável → nenhum resultado');

      // 12b) Solicitante.
      const doC2 = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        cliente_id: cliente2,
        limite: 100,
      });
      ok(
        idsD045.every((id) => doC2.itens.some((i) => i.id === id)) &&
          !doC2.itens.some((i) => i.id === ch1.id),
        'D-045: filtro por solicitante traz os do cliente2 e não os do cliente1',
      );

      // 12c) Período (datas no fuso de São Paulo, inclusivas).
      const hoje = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        cliente_id: cliente2,
        periodo: { campo: 'criado', de: hojeSp, ate: hojeSp },
        limite: 100,
      });
      ok(
        idsD045.every((id) => hoje.itens.some((i) => i.id === id)),
        'D-045: período "criado hoje" inclui os chamados recém-criados',
      );
      const passado = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        periodo: { campo: 'atualizado', ate: '2000-01-01' },
      });
      ok(passado.itens.length === 0, 'D-045: período no passado distante → vazio');
      const dataRuim = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        periodo: { campo: 'criado', de: '2026-02-30' },
      });
      ok(dataRuim.itens.length === 0, 'D-045: data inexistente → nenhum resultado (fail-closed)');

      // 12d) Ordenação por prioridade (desc) é monotônica.
      const porPrio = await listarFilaChamados(em, atorOp, {
        situacao: 'todos',
        cliente_id: cliente2,
        ordenacao: { campo: 'prioridade', direcao: 'desc' },
        limite: 100,
      });
      const ranks = porPrio.itens.map((i) => RANK_PRIO[i.prioridade]!);
      ok(
        ranks.every((r, i) => i === 0 || ranks[i - 1]! >= r),
        'D-045: ordenação por prioridade desc (urgente → baixa)',
      );
      const posU = porPrio.itens.findIndex((i) => i.id === d045Urgente);
      const posM = porPrio.itens.findIndex((i) => i.id === d045Media);
      const posB = porPrio.itens.findIndex((i) => i.id === d045Baixa);
      ok(posU < posM && posM < posB, 'D-045: urgente antes de média antes de baixa');

      // 12e) Offset: páginas de 1 item, número asc, sem repetir nem pular.
      const base = {
        situacao: 'todos' as const,
        cliente_id: cliente2,
        ordenacao: { campo: 'numero' as const, direcao: 'asc' as const },
      };
      const inteira = await listarFilaChamados(em, atorOp, { ...base, limite: 100 });
      const paginado: string[] = [];
      for (let pagina = 1; pagina <= 100; pagina++) {
        const p = await listarFilaChamados(em, atorOp, { ...base, limite: 1, pagina });
        paginado.push(...p.itens.map((i) => i.id));
        if (!p.temMais) break;
      }
      ok(
        paginado.length === inteira.itens.length &&
          paginado.every((id, i) => id === inteira.itens[i]!.id),
        `D-045: paginação por offset cobre o recorte sem repetir/pular (${paginado.length} itens)`,
      );
      const nums = inteira.itens.map((i) => Number(i.numero));
      ok(
        nums.every((n, i) => i === 0 || nums[i - 1]! < n),
        'D-045: ordenação por número asc é estritamente crescente',
      );

      // 12f) Exportação da equipe = o MESMO recorte e a MESMA ordem da tela.
      const exp = await exportarFilaChamados(em, atorOp, base);
      ok(
        !exp.truncado &&
          exp.itens.length === inteira.itens.length &&
          exp.itens.every((i, k) => i.id === inteira.itens[k]!.id),
        'D-045: exportação traz exatamente o recorte/ordem da fila',
      );
      ok(
        exp.itens.every((i) => i.solicitante_email !== undefined && 'resolvido_em' in i),
        'D-045: exportação da equipe traz e-mail do solicitante e datas de ciclo',
      );
      const curta = await exportarFilaChamados(em, atorOp, base, 2);
      ok(curta.truncado && curta.itens.length === 2, 'D-045: teto da exportação → truncado');
      const expCliente = await exportarFilaChamados(em, atorC1, base);
      ok(expCliente.itens.length === 0, 'D-045: cliente NÃO exporta a fila da equipe');

      // 12g) Exportação PÚBLICA (portal): sem campos internos; recorte Meus/Todos.
      const pubTodos = await exportarChamadosVisaoPublica(em, atorC1, {});
      ok(
        idsD045.length > 0 &&
          pubTodos.itens.some((i) => i.titulo === 'D-045 fila 0') &&
          pubTodos.itens.every(
            (i) =>
              !('complexidade' in i) &&
              !('operador_id' in i) &&
              !('operador_nome' in i) &&
              !('solicitante_email' in i) &&
              !('ia_silenciada' in i),
          ),
        'D-045: exportação do portal (Todos) traz os do colega, sem nenhum campo interno',
      );
      const pubMeus = await exportarChamadosVisaoPublica(em, atorC1, { meus: true });
      ok(
        pubMeus.itens.length > 0 &&
          pubMeus.itens.every((i) => i.solicitante_eh_voce) &&
          !pubMeus.itens.some((i) => i.titulo.startsWith('D-045 fila')),
        'D-045: exportação do portal (Meus) só traz os do próprio cliente',
      );
      const pubCancelados = await exportarChamadosVisaoPublica(em, atorC1, {
        status: [StatusChamado.cancelado],
      });
      ok(
        pubCancelados.itens.every((i) => i.status === StatusChamado.cancelado),
        'D-045: exportação do portal respeita o grupo/status da aba',
      );
    });

    // 12h) Cross-tenant: nada do A aparece em B — nem filtrando pelo operador do A.
    await runInTenantContext(ds, tenantB, async (em) => {
      const expB = await exportarFilaChamados(em, atorOpB, { situacao: 'todos' });
      ok(
        !expB.itens.some((i) => idsD045.includes(i.id)),
        'D-045: exportação do tenant B não traz chamados do A (RLS)',
      );
      const filtroOpA = await listarFilaChamados(em, atorOpB, {
        situacao: 'todos',
        operador_id: operador,
      });
      ok(filtroOpA.itens.length === 0, 'D-045: filtrar pelo operador do A, em B, → vazio (RLS)');
      const contB = await contarFila(em, atorOpB, { situacao: 'todos' });
      ok(
        contB.porOperador[operador] === undefined,
        'D-045: contadores por operador do B não enxergam o operador do A',
      );
      const pubB = await exportarChamadosVisaoPublica(em, atorCB, {});
      ok(
        !pubB.itens.some((i) => i.titulo.startsWith('D-045 fila')),
        'D-045: exportação do portal no tenant B não traz chamados do A (RLS)',
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
