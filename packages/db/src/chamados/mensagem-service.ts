import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  autorizar,
  ehTerminal,
  StatusChamado,
  VisibilidadeMensagem,
  Papel,
  GatilhoIA,
  serializarMensagemParaCliente,
  type MensagemInterna,
  type MensagemCliente,
} from '@chamados/shared';
import { MensagemSchema, type Mensagem } from '../entities/mensagem';
import { ChamadoSchema } from '../entities/chamado';
import { auditorDe, despacharDe, type HooksChamado } from './auditoria';
import {
  validarDocRico,
  materializarDoc,
  normalizarEntradaRich,
  type DocRico,
  type MotivoRichText,
} from './rich-text';
import { detectarTipo, MAX_ANEXOS_POR_MENSAGEM, type TipoDetectado } from './validacao-arquivo';
import { gravarAnexo, type ArquivoUpload } from './anexo-service';
import { transicionarStatus, atorSistema, type AtorChamado } from './chamado-service';

/**
 * Mensagens da timeline (specs/04 §4, §6). Rodam em `runInTenantContext` + RLS e
 * decidem papel/visibilidade via `autorizar()`. São IMUTÁVEIS (sem edição/exclusão
 * — specs/04 §4.2): não há função de update/delete aqui. Notas internas nunca são
 * retornadas ao cliente (filtro NO REPOSITÓRIO + serializer).
 */

export interface EntradaMensagem {
  chamado_id: string;
  visibilidade: VisibilidadeMensagem;
  /** Texto simples ou doc ProseMirror — ambos passam pelo pipeline real. */
  corpo: string | DocRico;
  /** Arquivos anexados à parte (não-inline). */
  anexos?: ArquivoUpload[];
  /**
   * Referência à `ExecucaoIA` que originou a mensagem (M7 — mensagens/notas do
   * `agente_ia`). Campo INTERNO/CONFIÁVEL: só o worker o define; NUNCA vem de
   * entrada do cliente (a camada web constrói a `EntradaMensagem` sem ele).
   */
  execucao_ia_id?: string | null;
  /**
   * Sobrescreve o `created_at` da mensagem (D-015). Campo INTERNO/CONFIÁVEL: só o
   * worker o define. O default do banco é `now()` — CONSTANTE dentro de uma
   * transação —, então várias mensagens criadas na MESMA Tx empatariam no
   * timestamp e a ordem cairia no `id` (UUID aleatório). O aplicador usa este
   * override para SEQUENCIAR de forma determinística as mensagens que a IA publica
   * numa única transação (ex.: resposta pública ANTES da nota interna). Ausente na
   * camada web (usa o default do banco).
   */
  created_at?: Date;
}

export type MotivoMensagem =
  | 'chamado_inexistente'
  | 'sem_permissao'
  | 'estado_terminal'
  | 'visibilidade_invalida'
  | 'corpo_invalido'
  | 'corpo_vazio'
  | 'corpo_muito_longo'
  | 'imagem_invalida'
  | 'imagens_demais'
  | 'muitos_anexos'
  | 'anexo_invalido';

export type ResultadoMensagem =
  { ok: true; id: string } | { ok: false; motivo: MotivoMensagem; indice?: number };

function motivoRich(m: MotivoRichText): MotivoMensagem {
  switch (m) {
    case 'doc_invalido':
      return 'corpo_invalido';
    case 'corpo_vazio':
      return 'corpo_vazio';
    case 'corpo_muito_longo':
      return 'corpo_muito_longo';
    case 'imagem_invalida':
      return 'imagem_invalida';
    case 'imagens_demais':
      return 'imagens_demais';
  }
}

/**
 * Cria uma mensagem (specs/04 §6). Cliente só escreve mensagem `publica` no
 * PRÓPRIO chamado; nota `interna` é de operador/admin/agente_ia. Estados terminais
 * não aceitam novas mensagens. Aplica o pipeline de rich text (imagens coladas →
 * anexos inline + sanitização). Se um cliente responde em `aguardando_cliente`, o
 * `sistema` re-enfileira a triagem (`→ em_triagem`, com evento) — specs/04 §1.3/§4.2.
 */
export async function criarMensagem(
  em: EntityManager,
  ator: AtorChamado,
  entrada: EntradaMensagem,
  hooks?: HooksChamado,
): Promise<ResultadoMensagem> {
  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: entrada.chamado_id, deleted_at: IsNull() },
  });
  if (!chamado) return { ok: false, motivo: 'chamado_inexistente' };

  if (
    entrada.visibilidade !== VisibilidadeMensagem.publica &&
    entrada.visibilidade !== VisibilidadeMensagem.interna
  ) {
    return { ok: false, motivo: 'visibilidade_invalida' };
  }

  // Autorização por visibilidade (fronteira inegociável: cliente ❌ interna).
  const recurso =
    entrada.visibilidade === VisibilidadeMensagem.interna ? 'mensagem_interna' : 'mensagem_publica';
  if (
    !autorizar(ator, recurso, 'escrever', {
      cliente_id: chamado.cliente_id,
      tenant_id: chamado.tenant_id,
    })
  ) {
    return { ok: false, motivo: 'sem_permissao' };
  }

  // Estados terminais não recebem novas mensagens (specs/04 §1.1). Verificado
  // DEPOIS da autorização para não vazar existência a quem não pode ler.
  if (ehTerminal(chamado.status)) return { ok: false, motivo: 'estado_terminal' };

  // Pipeline de rich text — fase 1 (validação/extração, sem efeitos colaterais).
  const val = validarDocRico(normalizarEntradaRich(entrada.corpo));
  if (!val.ok) return { ok: false, motivo: motivoRich(val.motivo) };

  // Pré-valida anexos (magic bytes) ANTES de qualquer INSERT (falha fecha limpo).
  const anexosValidados: Array<{ nome_arquivo: string; buffer: Buffer; tipo: TipoDetectado }> = [];
  if (entrada.anexos && entrada.anexos.length > 0) {
    if (entrada.anexos.length > MAX_ANEXOS_POR_MENSAGEM) {
      return { ok: false, motivo: 'muitos_anexos' };
    }
    for (let i = 0; i < entrada.anexos.length; i++) {
      const arq = entrada.anexos[i]!;
      const det = detectarTipo(arq.buffer, arq.nome_arquivo);
      if (!det.ok) return { ok: false, motivo: 'anexo_invalido', indice: i };
      anexosValidados.push({ nome_arquivo: arq.nome_arquivo, buffer: arq.buffer, tipo: det.tipo });
    }
  }

  // Insere a mensagem com corpo placeholder; a fase 2 vincula anexos inline a ela.
  const res = await em.insert(MensagemSchema, {
    tenant_id: chamado.tenant_id,
    chamado_id: chamado.id,
    autor_id: ator.id,
    visibilidade: entrada.visibilidade,
    corpo_json: { type: 'doc' },
    corpo_html: '',
    execucao_ia_id: entrada.execucao_ia_id ?? null,
    // Override de ordenação (D-015, worker-only). Omitido → default do banco (now()).
    ...(entrada.created_at ? { created_at: entrada.created_at } : {}),
  });
  const id = res.identifiers[0]!.id as string;

  const mat = await materializarDoc({
    em,
    tenantId: chamado.tenant_id,
    chamadoId: chamado.id,
    mensagemId: id,
    atorId: ator.id,
    validado: val.validado,
    hooks,
  });
  await em.update(MensagemSchema, { id }, { corpo_json: mat.json, corpo_html: mat.html });

  // Anexos à parte (não-inline).
  for (const arq of anexosValidados) {
    await gravarAnexo(
      em,
      { chamado_id: chamado.id, mensagem_id: id },
      arq,
      ator.id,
      chamado.tenant_id,
      hooks,
    );
  }

  // Evento da timeline (publica vs. interna).
  await auditorDe(hooks)(em, {
    tipo:
      entrada.visibilidade === VisibilidadeMensagem.interna
        ? 'nota_interna_publicada'
        : 'mensagem_publicada',
    chamado_id: chamado.id,
    ator_id: ator.id,
    dados: { mensagem_id: id, visibilidade: entrada.visibilidade },
  });

  // Resposta pública do cliente re-enfileira a triagem (specs/04 §1.3/§4.2,
  // specs/05 §2): vale para chamado em `aguardando_cliente` E em `em_triagem`
  // (M7). Vindo de `aguardando_cliente`, o SISTEMA transiciona → em_triagem
  // (gera status_alterado); em `em_triagem` o chamado já está no estado certo —
  // apenas reenfileira. O despachante emite `resposta_cliente` sobre a ÚLTIMA
  // mensagem (`id`); enfileiramento real é pós-commit/best-effort (no-op sem
  // despachante injetado).
  const respostaCliente =
    entrada.visibilidade === VisibilidadeMensagem.publica &&
    ator.papel === Papel.cliente &&
    (chamado.status === StatusChamado.aguardando_cliente ||
      chamado.status === StatusChamado.em_triagem);
  if (respostaCliente) {
    if (chamado.status === StatusChamado.aguardando_cliente) {
      await transicionarStatus(
        em,
        atorSistema(chamado.tenant_id),
        chamado.id,
        StatusChamado.em_triagem,
        { motivo: 'resposta_do_cliente' },
        hooks,
      );
    }
    despacharDe(hooks).publicar({
      tipo: 'triagem_solicitada',
      tenantId: chamado.tenant_id,
      chamadoId: chamado.id,
      ultimaMensagemId: id,
      gatilho: GatilhoIA.resposta_cliente,
    });
  }

  return { ok: true, id };
}

/** Item de timeline exposto à camada web (equipe vê `visibilidade`; cliente não). */
export type MensagemTimeline = MensagemInterna | MensagemCliente;

/**
 * Lista a timeline de mensagens de um chamado (specs/04 §4). O FILTRO de
 * visibilidade é feito NO REPOSITÓRIO: para o cliente, a query só traz
 * `visibilidade='publica'` (nunca confia no cliente para ocultar); ainda assim o
 * serializer remove `visibilidade`/`execucao_ia_id` como segunda barreira.
 */
export async function listarMensagens(
  em: EntityManager,
  ator: AtorChamado,
  chamadoId: string,
): Promise<MensagemTimeline[]> {
  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) return [];
  if (
    !autorizar(ator, 'chamado', 'ler', {
      cliente_id: chamado.cliente_id,
      tenant_id: chamado.tenant_id,
    })
  ) {
    return [];
  }

  const qb = em
    .createQueryBuilder(MensagemSchema, 'm')
    .where('m.chamado_id = :cid', { cid: chamadoId })
    .andWhere('m.deleted_at IS NULL');

  // Filtro NO REPOSITÓRIO: cliente só enxerga mensagens públicas.
  if (ator.papel === Papel.cliente) {
    qb.andWhere('m.visibilidade = :vis', { vis: VisibilidadeMensagem.publica });
  }
  qb.orderBy('m.created_at', 'ASC').addOrderBy('m.id', 'ASC');

  const linhas = await qb.getMany();
  if (ator.papel === Papel.cliente) {
    return linhas
      .map((m) => serializarMensagemParaCliente(toMensagemInterna(m)))
      .filter((m): m is MensagemCliente => m !== null);
  }
  return linhas.map(toMensagemInterna);
}

function toMensagemInterna(m: Mensagem): MensagemInterna {
  return {
    id: m.id,
    chamado_id: m.chamado_id,
    autor_id: m.autor_id,
    visibilidade: m.visibilidade,
    corpo_json: m.corpo_json,
    corpo_html: m.corpo_html,
    execucao_ia_id: m.execucao_ia_id,
    created_at: m.created_at,
  };
}
