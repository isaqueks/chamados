import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import {
  StatusChamado,
  Natureza,
  Complexidade,
  VisibilidadeMensagem,
  Papel,
  formatarPerguntasCliente,
  montarNotaDiagnostico,
  montarNotaEscalonamento,
  montarTemplateSpec,
  type AIProviderResult,
  type Prioridade,
} from '@chamados/shared';
import {
  ChamadoSchema,
  UsuarioSchema,
  criarMensagem,
  transicionarStatus,
  definirComplexidade,
  alterarNatureza,
  alterarPrioridade,
  gravarEvento,
  type Chamado,
  type AtorChamado,
  type Despachante,
  type HooksChamado,
} from '@chamados/db';

/**
 * APLICADOR do `AIProviderResult` ao chamado (M7 — specs/05 §3.1 passo 6, §5-§8).
 * Traduz a DECISÃO do provider em AÇÕES de domínio usando os services de
 * `@chamados/db`, com o `agente_ia` do tenant como ator. TODA mensagem/evento
 * gerado carrega `execucao_ia_id`. Roda DENTRO da transação de conclusão
 * (`runInTenantContext`): se qualquer passo falhar, a transação inteira faz
 * rollback e o pipeline escalona (`escalarParaHumano`) numa transação limpa —
 * o chamado nunca fica preso em `em_triagem` sem responsável (specs/05 §8).
 *
 * Guardrails de negócio (specs/04 §3, specs/05 §5):
 *  - complexidade SEMPRE gravada quando compreendido;
 *  - natureza só é reclassificada quando a IA diverge da declarada;
 *  - prioridade sugerida só é APLICADA se o chamado ainda não foi tocado por
 *    operador; caso contrário vira apenas sugestão na nota interna;
 *  - o `agente_ia` nunca marca `resolvido` (garantido pela máquina de estados).
 */

export interface DepsAplicador {
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * Despachante de NOTIFICAÇÕES (M9): quando presente, é injetado nas mutações que
   * o aplicador faz (mensagens PÚBLICAS + transições de status), fazendo o seam de
   * auditoria traduzir os `EventoChamado` → jobs de notificação (buffer). O flush
   * (enfileiramento) é POS-COMMIT, no processador. Notas INTERNAS, complexidade e
   * eventos `ia_*` não notificam — o dispatcher do M9 filtra. Ausente (ex.: alguns
   * testes) → nenhuma notificação, só a auditoria default.
   */
  despachante?: Despachante;
}

/** Resolve o ator `agente_ia` do tenant corrente (RLS). `null` se não existir. */
async function atorAgenteIa(em: EntityManager, tenantId: string): Promise<AtorChamado | null> {
  const u = await em.findOne(UsuarioSchema, { where: { papel: Papel.agente_ia } });
  return u ? { id: u.id, tenant_id: tenantId, papel: Papel.agente_ia } : null;
}

/** O chamado já foi tocado por um operador/admin? (specs/04 §3.2) */
async function tocadoPorOperador(em: EntityManager, chamado: Chamado): Promise<boolean> {
  if (chamado.operador_id) return true;
  const linhas: Array<{ existe: boolean }> = await em.query(
    `SELECT EXISTS (
       SELECT 1 FROM evento_chamado e
       JOIN usuario u ON u.id = e.ator_id
       WHERE e.chamado_id = $1 AND u.papel IN ('operador', 'admin')
     ) AS existe`,
    [chamado.id],
  );
  return linhas[0]?.existe === true;
}

function exigir(ok: boolean, etapa: string): void {
  if (!ok) throw new Error(`aplicacao_falhou:${etapa}`);
}

/**
 * Aplica o resultado ao chamado. Lança em caso de falha de qualquer etapa (o
 * processador captura e escalona). O `execucaoId` amarra todas as ações à
 * `ExecucaoIA` que as originou.
 */
export async function aplicarResultado(
  em: EntityManager,
  args: { tenantId: string; chamadoId: string; execucaoId: string; resultado: AIProviderResult },
  deps: DepsAplicador,
): Promise<void> {
  const { tenantId, chamadoId, execucaoId, resultado } = args;

  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) throw new Error('aplicacao_falhou:chamado_inexistente');

  const ator = await atorAgenteIa(em, tenantId);
  if (!ator) throw new Error('aplicacao_falhou:agente_ia_ausente');

  if (!resultado.compreendido) {
    await aplicarNaoEntendeu(em, { ator, chamado, execucaoId, resultado }, deps);
  } else {
    await aplicarEntendeu(em, { ator, chamado, execucaoId, resultado }, deps);
  }
}

interface CtxAplicar {
  ator: AtorChamado;
  chamado: Chamado;
  execucaoId: string;
  resultado: AIProviderResult;
}

/** Fluxo "não entendeu" (specs/05 §5.3): pergunta pública + aguardando_cliente. */
async function aplicarNaoEntendeu(
  em: EntityManager,
  ctx: CtxAplicar,
  deps: DepsAplicador,
): Promise<void> {
  const { ator, chamado, execucaoId, resultado } = ctx;
  const hooks: HooksChamado = { despachante: deps.despachante };

  const corpo = formatarPerguntasCliente(resultado.perguntasAoCliente ?? []);
  const msg = await criarMensagem(
    em,
    ator,
    {
      chamado_id: chamado.id,
      visibilidade: VisibilidadeMensagem.publica,
      corpo,
      execucao_ia_id: execucaoId,
    },
    hooks,
  );
  exigir(msg.ok, 'mensagem_perguntas');

  // Move para aguardando_cliente (de em_triagem ou, em reprocesso, em_atendimento).
  if (
    chamado.status === StatusChamado.em_triagem ||
    chamado.status === StatusChamado.em_atendimento
  ) {
    const t = await transicionarStatus(
      em,
      ator,
      chamado.id,
      StatusChamado.aguardando_cliente,
      { motivo: 'ia_pediu_info' },
      hooks,
    );
    exigir(t.ok, 'transicao_aguardando_cliente');
  }

  await gravarEvento(em, {
    tipo: 'ia_pediu_info',
    chamado_id: chamado.id,
    ator_id: ator.id,
    execucao_ia_id: execucaoId,
    dados: {
      perguntas: (resultado.perguntasAoCliente ?? []).length,
      confianca: resultado.confianca,
    },
  });
  deps.log('ia pediu informações', { chamadoId: chamado.id });
}

/** Fluxo "entendeu" (specs/05 §5.2/§7): diagnóstico + classificação + em_atendimento. */
async function aplicarEntendeu(
  em: EntityManager,
  ctx: CtxAplicar,
  deps: DepsAplicador,
): Promise<void> {
  const { ator, chamado, execucaoId, resultado } = ctx;
  const hooks: HooksChamado = { despachante: deps.despachante };

  // Complexidade SEMPRE gravada quando compreendido (default medio se ausente).
  const complexidade = resultado.complexidade ?? Complexidade.medio;
  const tocado = await tocadoPorOperador(em, chamado);
  const naturezaEfetiva = resultado.naturezaAjustada ?? chamado.natureza;

  const prioridadeAplicada: Prioridade | null =
    resultado.prioridadeSugerida && !tocado ? resultado.prioridadeSugerida : null;
  const prioridadeSugerida: Prioridade | null =
    resultado.prioridadeSugerida && tocado ? resultado.prioridadeSugerida : null;

  // 1) Nota interna de diagnóstico (template curto + registro de classificação).
  const nota = montarNotaDiagnostico({
    diagnostico: resultado.diagnostico ?? '',
    confianca: resultado.confianca,
    complexidade,
    naturezaAtual: chamado.natureza,
    naturezaAjustada: resultado.naturezaAjustada,
    prioridadeAplicada,
    prioridadeSugerida,
  });
  const msgDiag = await criarMensagem(
    em,
    ator,
    {
      chamado_id: chamado.id,
      visibilidade: VisibilidadeMensagem.interna,
      corpo: nota,
      execucao_ia_id: execucaoId,
    },
    hooks,
  );
  exigir(msgDiag.ok, 'nota_diagnostico');

  // 2) Classificações: complexidade, natureza (se divergir) e prioridade (se aplicável).
  exigir((await definirComplexidade(em, ator, chamado.id, complexidade, hooks)).ok, 'complexidade');
  if (resultado.naturezaAjustada && resultado.naturezaAjustada !== chamado.natureza) {
    exigir(
      (await alterarNatureza(em, ator, chamado.id, resultado.naturezaAjustada, hooks)).ok,
      'natureza',
    );
  }
  if (prioridadeAplicada) {
    exigir(
      (await alterarPrioridade(em, ator, chamado.id, prioridadeAplicada, hooks)).ok,
      'prioridade',
    );
  }

  // 3) Evento de diagnóstico.
  await gravarEvento(em, {
    tipo: 'ia_diagnosticou',
    chamado_id: chamado.id,
    ator_id: ator.id,
    execucao_ia_id: execucaoId,
    dados: {
      complexidade,
      confianca: resultado.confianca,
      natureza: naturezaEfetiva,
      prioridade_aplicada: prioridadeAplicada,
      prioridade_sugerida: prioridadeSugerida,
    },
  });

  // 4) SPEC de alteração (specs/05 §7): quando a natureza EFETIVA é alteracao.
  if (naturezaEfetiva === Natureza.alteracao) {
    const spec =
      resultado.spec && resultado.spec.trim().length > 0
        ? resultado.spec
        : montarTemplateSpec({
            titulo: chamado.titulo,
            sistemaAlvoNome: 'Sistema-alvo',
            sistemaAlvoStack: null,
            chamadoNumero: chamado.numero,
            complexidade,
            pedidoResumo: chamado.titulo,
            analise: resultado.diagnostico,
          });
    const msgSpec = await criarMensagem(
      em,
      ator,
      {
        chamado_id: chamado.id,
        visibilidade: VisibilidadeMensagem.interna,
        corpo: spec,
        execucao_ia_id: execucaoId,
      },
      hooks,
    );
    exigir(msgSpec.ok, 'nota_spec');
    await gravarEvento(em, {
      tipo: 'ia_gerou_spec',
      chamado_id: chamado.id,
      ator_id: ator.id,
      execucao_ia_id: execucaoId,
      dados: { natureza: naturezaEfetiva },
    });
  }

  // 5) Transição para em_atendimento (só a partir de em_triagem; reprocesso a
  //    partir de em_atendimento não precisa transicionar).
  if (chamado.status === StatusChamado.em_triagem) {
    const t = await transicionarStatus(
      em,
      ator,
      chamado.id,
      StatusChamado.em_atendimento,
      { motivo: 'ia_diagnosticou' },
      hooks,
    );
    exigir(t.ok, 'transicao_em_atendimento');
  }
  deps.log('ia diagnosticou', { chamadoId: chamado.id, complexidade, natureza: naturezaEfetiva });
}

/**
 * Escalonamento por falha (specs/05 §8): garante que o chamado não fique preso em
 * `em_triagem` sem responsável. Move `em_triagem → em_atendimento` (sem
 * classificação) para um humano assumir, publica nota interna com o motivo e
 * grava o evento `ia_falhou`. Best-effort e defensivo: cada etapa é isolada para
 * que a falha de uma NÃO impeça a garantia mínima (status consistente + evento).
 */
export async function escalarParaHumano(
  em: EntityManager,
  args: { tenantId: string; chamadoId: string; execucaoId: string; erro: string },
  deps: DepsAplicador,
): Promise<void> {
  const { tenantId, chamadoId, execucaoId, erro } = args;
  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) return;

  const ator = await atorAgenteIa(em, tenantId);

  // Nota interna explicando a falha (só se houver agente_ia como autor).
  if (ator) {
    const msg = await criarMensagem(em, ator, {
      chamado_id: chamadoId,
      visibilidade: VisibilidadeMensagem.interna,
      corpo: montarNotaEscalonamento(erro),
      execucao_ia_id: execucaoId,
    });
    if (!msg.ok) deps.log('escalonamento: nota interna falhou', { chamadoId, motivo: msg.motivo });
  }

  // Move em_triagem → em_atendimento para um humano assumir. Usa o agente_ia (a
  // máquina de estados só permite agente_ia/operador nessa aresta); sem agente,
  // o sistema não pode transicionar aqui — deixa como está (nunca terminal).
  if (chamado.status === StatusChamado.em_triagem && ator) {
    const t = await transicionarStatus(
      em,
      ator,
      chamadoId,
      StatusChamado.em_atendimento,
      { motivo: `falha_triagem:${erro}` },
      undefined,
    );
    if (!t.ok) deps.log('escalonamento: transição falhou', { chamadoId, motivo: t.motivo });
  }

  await gravarEvento(em, {
    tipo: 'ia_falhou',
    chamado_id: chamadoId,
    ator_id: ator?.id ?? null,
    execucao_ia_id: execucaoId,
    dados: { erro },
  });
  deps.log('triagem escalada para humano', { chamadoId, erro });
}
