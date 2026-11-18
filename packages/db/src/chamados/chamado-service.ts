import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  autorizar,
  transicaoValida,
  ehTerminal,
  ehReabertura,
  ehAprovacaoDoCliente,
  ehContestacao,
  calcularPrazoAprovacao,
  ATOR_SISTEMA,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  Papel,
  StatusUsuario,
  GatilhoIA,
  EstimativaCusto,
  ehEstimativaCusto,
  custoDoBanco,
  custoParaBanco,
  validarCustoFinal,
  ORIGEM_CUSTO_RESOLUCAO,
  serializarChamadoParaCliente,
  type Ator,
  type PapelTransicao,
  type MotivoNegacao,
  type TipoEvento,
  type ChamadoInterno,
  type ChamadoCliente,
} from '@chamados/shared';
import { ChamadoSchema, type Chamado } from '../entities/chamado';
import { TenantSchema } from '../entities/tenant';
import { UsuarioSchema } from '../entities/usuario';
import { SistemaAlvoSchema } from '../entities/sistema-alvo';
import { garantirCategoriaGeral, buscarCategoria } from '../categorias/categoria-service';
import {
  validarDocRico,
  materializarDoc,
  normalizarEntradaRich,
  LIMITE_CORPO_MAX,
  type DocRico,
  type MotivoRichText,
} from './rich-text';
import { auditorDe, type HooksChamado } from './auditoria';
import type { ArquivoUpload } from './anexo-service';
import { interpretarBusca, exprMatchFts } from './busca';

/**
 * Serviços de Chamado (specs/04). Rodam SEMPRE dentro de `runInTenantContext`
 * (transação + RLS) e decidem papel/ownership via `autorizar()` (specs/03). A
 * máquina de estados (specs/04 §1) é aplicada por `transicionarStatus`. Toda
 * mutação chama o seam de auditoria (M4 grava o EventoChamado — ver auditoria.ts).
 */

/** Limites de título (specs/02 CHECK 3..160). O limite de corpo (≤ 50k) vive no
 * pipeline de rich text (specs/04 §5) e é reexportado aqui por conveniência. */
export const LIMITE_TITULO_MIN = 3;
export const LIMITE_TITULO_MAX = 160;
export { LIMITE_CORPO_MAX };

// ---------------------------------------------------------------------------
// Atores
// ---------------------------------------------------------------------------

/** Ator de usuário (cliente/operador/admin/agente_ia). */
export interface AtorChamado {
  id: string;
  tenant_id: string;
  papel: Papel;
}

/** Ator de transição: usuário OU o `sistema` (jobs automáticos). */
export interface AtorTransicao {
  id: string | null;
  tenant_id: string;
  papel: PapelTransicao;
}

/** Constrói o ator `sistema` (job de triagem/auto-fechamento). */
export function atorSistema(tenantId: string): AtorTransicao {
  return { id: null, tenant_id: tenantId, papel: ATOR_SISTEMA };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function ehValorEnum<T extends Record<string, string>>(e: T, v: unknown): v is T[keyof T] {
  return typeof v === 'string' && (Object.values(e) as string[]).includes(v);
}

function carregar(em: EntityManager, id: string): Promise<Chamado | null> {
  return em.findOne(ChamadoSchema, { where: { id, deleted_at: IsNull() } });
}

/** Mapeia a linha do banco para a forma interna canônica (specs/02). */
export function toChamadoInterno(c: Chamado): ChamadoInterno {
  return {
    id: c.id,
    numero: c.numero,
    tenant_id: c.tenant_id,
    sistema_alvo_id: c.sistema_alvo_id,
    categoria_id: c.categoria_id,
    cliente_id: c.cliente_id,
    operador_id: c.operador_id,
    titulo: c.titulo,
    descricao_json: c.descricao_json,
    descricao_html: c.descricao_html,
    status: c.status,
    natureza: c.natureza,
    prioridade: c.prioridade,
    complexidade: c.complexidade,
    ia_silenciada: c.ia_silenciada,
    estimativa_custo: c.estimativa_custo ?? null,
    custo_final: custoDoBanco(c.custo_final),
    resolvido_em: c.resolvido_em,
    fechar_automaticamente_em: c.fechar_automaticamente_em,
    fechado_em: c.fechado_em,
    reaberto_count: c.reaberto_count,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

/** Projeção por papel: cliente recebe o serializer allowlist; equipe, o interno. */
export type ChamadoView = ChamadoInterno | ChamadoCliente;

function serializarPorPapel(papel: Papel, c: Chamado): ChamadoView {
  const interno = toChamadoInterno(c);
  return papel === Papel.cliente ? serializarChamadoParaCliente(interno) : interno;
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

export interface EntradaCriarChamado {
  titulo: string;
  /**
   * Descrição em rich text: TEXTO SIMPLES (convertido para doc mínimo) OU um
   * documento ProseMirror/TipTap. Em ambos os casos passa pelo pipeline real
   * (validação estrutural + extração de imagens + sanitização — specs/04 §5).
   */
  descricao: string | DocRico;
  natureza: Natureza;
  prioridade?: Prioridade;
  sistema_alvo_id?: string | null;
  categoria_id?: string | null;
  /** Solicitante quando operador/admin abre "em nome de" (specs/04 §2). */
  cliente_id?: string;
  /**
   * Estimativa de custo já na abertura (D-043) — só a EQUIPE (`chamado ·
   * definir_custo`); vinda de cliente é `sem_permissao`. Vai no evento
   * `chamado_criado` (o webhook `criado` já carrega o campo no objeto `chamado`).
   */
  estimativa_custo?: EstimativaCusto | null;
  /**
   * Imagens enviadas como ARQUIVO para a descrição (API multipart — D-046),
   * referenciadas no doc por `src = "anexo-enviado:<índice>"`. Mesmo pipeline das
   * imagens coladas no portal (anexos `inline`); a abertura não tem anexos à
   * parte — como no portal.
   */
  imagens_inline?: ArquivoUpload[];
}

export type MotivoCriar =
  | 'sem_permissao'
  | 'solicitante_obrigatorio'
  | 'solicitante_invalido'
  | 'titulo_invalido'
  | 'descricao_invalida'
  | 'descricao_obrigatoria'
  | 'descricao_muito_longa'
  | 'imagem_invalida'
  | 'imagens_demais'
  | 'natureza_invalida'
  | 'prioridade_invalida'
  | 'sistema_alvo_obrigatorio'
  | 'sistema_alvo_invalido'
  | 'categoria_invalida'
  | 'estimativa_invalida';

/** Mapeia o motivo do pipeline de rich text para o motivo de criação/mensagem. */
export function motivoRichParaCriar(m: MotivoRichText): MotivoCriar {
  switch (m) {
    case 'doc_invalido':
      return 'descricao_invalida';
    case 'corpo_vazio':
      return 'descricao_obrigatoria';
    case 'corpo_muito_longo':
      return 'descricao_muito_longa';
    case 'imagem_invalida':
      return 'imagem_invalida';
    case 'imagens_demais':
      return 'imagens_demais';
  }
}

export type ResultadoCriar =
  { ok: true; id: string; numero: string } | { ok: false; motivo: MotivoCriar };

/** Resolve o alvo (sistema-alvo XOR categoria) conforme specs/04 §2 e o CHECK. */
async function resolverAlvo(
  em: EntityManager,
  tenantId: string,
  entrada: EntradaCriarChamado,
): Promise<
  | { ok: true; sistema_alvo_id: string | null; categoria_id: string | null }
  | { ok: false; motivo: MotivoCriar }
> {
  if (entrada.sistema_alvo_id) {
    const s = await em.findOne(SistemaAlvoSchema, {
      where: { id: entrada.sistema_alvo_id, deleted_at: IsNull() },
    });
    if (!s) return { ok: false, motivo: 'sistema_alvo_invalido' };
    return { ok: true, sistema_alvo_id: s.id, categoria_id: null };
  }
  if (entrada.categoria_id) {
    const c = await buscarCategoria(em, entrada.categoria_id);
    if (!c) return { ok: false, motivo: 'categoria_invalida' };
    return { ok: true, sistema_alvo_id: null, categoria_id: c.id };
  }
  // Auto-resolução (specs/04 §2): 1 sistema → preenche; 0 → categoria geral;
  // >1 sem escolha → exige o sistema-alvo.
  const sistemas = await em.find(SistemaAlvoSchema, {
    where: { deleted_at: IsNull(), ativo: true },
  });
  if (sistemas.length === 1) {
    return { ok: true, sistema_alvo_id: sistemas[0]!.id, categoria_id: null };
  }
  if (sistemas.length === 0) {
    const geralId = await garantirCategoriaGeral(em, tenantId);
    return { ok: true, sistema_alvo_id: null, categoria_id: geralId };
  }
  return { ok: false, motivo: 'sistema_alvo_obrigatorio' };
}

/**
 * Cria um chamado com o formulário mínimo (specs/04 §2). Status inicial `novo`.
 * O `agente_ia` não cria (matriz §8.1). Cliente cria para si; operador/admin
 * criam "em nome de" um cliente (`cliente_id`). Numeração sequencial por tenant.
 */
export async function criarChamado(
  em: EntityManager,
  ator: AtorChamado,
  entrada: EntradaCriarChamado,
  hooks?: HooksChamado,
): Promise<ResultadoCriar> {
  if (!autorizar(ator, 'chamado', 'criar')) return { ok: false, motivo: 'sem_permissao' };

  // Solicitante (autor) do chamado.
  let cliente_id: string;
  if (ator.papel === Papel.cliente) {
    cliente_id = ator.id;
  } else {
    if (!entrada.cliente_id) return { ok: false, motivo: 'solicitante_obrigatorio' };
    // Solicitante = conta `cliente` ATIVA do tenant (RLS escopa o tenant: id de
    // outro tenant simplesmente não é encontrado). Suspenso/pendente → inválido
    // (D-040; mesmo universo do seletor do painel e do `solicitante_email` da API).
    const solicitante = await em.findOne(UsuarioSchema, {
      where: {
        id: entrada.cliente_id,
        papel: Papel.cliente,
        status: StatusUsuario.ativo,
        deleted_at: IsNull(),
      },
    });
    if (!solicitante) return { ok: false, motivo: 'solicitante_invalido' };
    cliente_id = solicitante.id;
  }

  const titulo = entrada.titulo.trim();
  if (titulo.length < LIMITE_TITULO_MIN || titulo.length > LIMITE_TITULO_MAX) {
    return { ok: false, motivo: 'titulo_invalido' };
  }

  // Pipeline de rich text — fase 1 (validação estrutural + extração de imagens),
  // sem efeitos colaterais: falha fecha antes de qualquer INSERT (specs/04 §5).
  const val = validarDocRico(normalizarEntradaRich(entrada.descricao), {
    imagensEnviadas: entrada.imagens_inline,
  });
  if (!val.ok) return { ok: false, motivo: motivoRichParaCriar(val.motivo) };

  if (!ehValorEnum(Natureza, entrada.natureza)) return { ok: false, motivo: 'natureza_invalida' };
  const prioridade = entrada.prioridade ?? Prioridade.media;
  if (!ehValorEnum(Prioridade, prioridade)) return { ok: false, motivo: 'prioridade_invalida' };

  // Estimativa de custo na abertura (D-043): decisão da equipe, nunca do cliente.
  let estimativa_custo: EstimativaCusto | null = null;
  if (entrada.estimativa_custo !== undefined && entrada.estimativa_custo !== null) {
    if (!autorizar(ator, 'chamado', 'definir_custo', { tenant_id: ator.tenant_id })) {
      return { ok: false, motivo: 'sem_permissao' };
    }
    if (!ehEstimativaCusto(entrada.estimativa_custo)) {
      return { ok: false, motivo: 'estimativa_invalida' };
    }
    estimativa_custo = entrada.estimativa_custo;
  }

  const alvo = await resolverAlvo(em, ator.tenant_id, entrada);
  if (!alvo.ok) return alvo;

  // Numeração sequencial por tenant, transacional e sem buracos (specs/02).
  const numero = await proximoNumero(em, ator.tenant_id);

  // Insere com descrição placeholder; a fase 2 (upload das imagens inline +
  // sanitização) precisa do chamado_id para vincular os anexos.
  const res = await em.insert(ChamadoSchema, {
    tenant_id: ator.tenant_id,
    numero,
    sistema_alvo_id: alvo.sistema_alvo_id,
    categoria_id: alvo.categoria_id,
    cliente_id,
    operador_id: null,
    titulo,
    descricao_json: { type: 'doc' },
    descricao_html: '',
    status: StatusChamado.novo,
    natureza: entrada.natureza,
    prioridade,
    estimativa_custo,
    reaberto_count: 0,
  });
  const id = res.identifiers[0]!.id as string;

  // Fase 2: materializa imagens coladas como Anexo (inline) e renderiza o HTML
  // sanitizado; grava a dupla representação final (JSON fonte + HTML seguro).
  const mat = await materializarDoc({
    em,
    tenantId: ator.tenant_id,
    chamadoId: id,
    mensagemId: null,
    atorId: ator.id,
    validado: val.validado,
    hooks,
  });
  await em.update(ChamadoSchema, { id }, { descricao_json: mat.json, descricao_html: mat.html });

  await auditorDe(hooks)(em, {
    tipo: 'chamado_criado',
    chamado_id: id,
    ator_id: ator.id,
    dados: {
      numero,
      natureza: entrada.natureza,
      prioridade,
      ...(estimativa_custo ? { estimativa_custo } : {}),
    },
  });

  // Gatilho de triagem (specs/05 §2 "Chamado criado → enfileira triagem"). A
  // transição novo→em_triagem (M7) ACOMPANHA o gatilho e é feita pelo `sistema`
  // (specs/04 §1.3/§2, specs/05 §3): só ocorre quando a triagem é DE FATO
  // solicitada — ou seja, quando um despachante REAL foi injetado (web/worker) E
  // o tenant tem triagem ativa. Sem despachante (seed/smokes/testes) o chamado
  // permanece `novo`: evita chamado "preso" em em_triagem sem job e preserva os
  // fluxos que transicionam explicitamente. O evento `status_alterado` é gravado
  // pela própria `transicionarStatus`. O enfileiramento do job é pós-commit e
  // best-effort (DespachanteFila.flush no site de chamada).
  const despachante = hooks?.despachante;
  if (despachante && (await triagemAtiva(em))) {
    await transicionarStatus(
      em,
      atorSistema(ator.tenant_id),
      id,
      StatusChamado.em_triagem,
      { motivo: 'triagem_automatica' },
      hooks,
    );
    despachante.publicar({
      tipo: 'triagem_solicitada',
      tenantId: ator.tenant_id,
      chamadoId: id,
      ultimaMensagemId: null,
      gatilho: GatilhoIA.chamado_criado,
    });
  }

  return { ok: true, id, numero };
}

/**
 * Triagem ativa para o tenant corrente? (specs/05 §2) Proxy SEM coluna dedicada
 * (nenhuma migration no M7): o tenant tem o service account `agente_ia` que
 * executa a triagem. Escopado por RLS — só enxerga usuários do tenant da
 * transação. Sem `agente_ia`, não há quem triar → mantém `novo`.
 */
async function triagemAtiva(em: EntityManager): Promise<boolean> {
  const agente = await em.findOne(UsuarioSchema, { where: { papel: Papel.agente_ia } });
  return agente !== null;
}

/** Incremento atômico do contador do tenant (upsert). Retorna o número usado. */
async function proximoNumero(em: EntityManager, tenantId: string): Promise<string> {
  const linhas: Array<{ numero: string }> = await em.query(
    `INSERT INTO tenant_contador (tenant_id, proximo_numero)
       VALUES ($1, 2)
       ON CONFLICT (tenant_id) DO UPDATE
         SET proximo_numero = tenant_contador.proximo_numero + 1
       RETURNING (proximo_numero - 1)::bigint AS numero`,
    [tenantId],
  );
  return String(linhas[0]!.numero);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Obtém um chamado com projeção por papel (cliente nunca vê campos internos). O
 * cliente lê qualquer chamado do tenant (D-037); agir continua exigindo ser o
 * solicitante (checado em cada mutação).
 */
export async function obterChamado(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
): Promise<ChamadoView | null> {
  const c = await carregar(em, id);
  if (!c) return null;
  if (!autorizar(ator, 'chamado', 'ler', { cliente_id: c.cliente_id, tenant_id: c.tenant_id })) {
    return null; // fora do escopo de leitura (ex.: outro tenant): trata como inexistente.
  }
  return serializarPorPapel(ator.papel, c);
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_NUMERO = /^#?(\d{1,18})$/;

/**
 * Resolve uma REFERÊNCIA de chamado — UUID interno ou número legível por tenant
 * (`12` ou `#12`, specs/02 "Numeração") — para o `id`. Existe para a API/MCP
 * (specs/11 §4), onde o humano fala em "#12" e não em UUID.
 *
 * NÃO autoriza nada: é só tradução de identificador. O escopo de tenant vem da
 * RLS (`UNIQUE (tenant_id, numero)` garante unicidade dentro do contexto) e a
 * autorização por papel continua sendo de `obterChamado`/`listarChamados`.
 * Referência sem formato válido → `null` (sem ida ao banco).
 */
export async function resolverIdChamado(em: EntityManager, ref: string): Promise<string | null> {
  const valor = ref.trim();
  if (RE_UUID.test(valor)) {
    const porId = await carregar(em, valor);
    return porId?.id ?? null;
  }
  const m = RE_NUMERO.exec(valor);
  if (!m) return null;
  const c = await em.findOne(ChamadoSchema, {
    where: { numero: m[1]!, deleted_at: IsNull() },
    select: { id: true },
  });
  return c?.id ?? null;
}

export type Atribuicao = 'atribuido' | 'nao_atribuido' | { operador_id: string };

export interface FiltrosChamado {
  status?: StatusChamado | StatusChamado[];
  natureza?: Natureza;
  prioridade?: Prioridade;
  atribuicao?: Atribuicao;
  sistema_alvo_id?: string;
  categoria_id?: string;
  /**
   * Complexidade INTERNA (specs/04 §10, D-036 L3). Só a equipe filtra por ela: o
   * conjunto do resultado revelaria o campo ao cliente (specs/04 §3.3). Para o
   * `cliente` é ignorada aqui como rede de segurança — a API recusa antes, com
   * `403`. Presente, chamados com complexidade `null` ficam de fora.
   */
  complexidade?: Complexidade | Complexidade[];
  /**
   * Filtra pelo solicitante (autor). Vale para qualquer papel: desde a D-037 o
   * cliente LÊ todo o tenant, então filtrar por autor não amplia nada.
   */
  cliente_id?: string;
  /**
   * Recorte "Meus chamados" (D-037): só os chamados em que o ATOR é o
   * solicitante. Tem precedência sobre `cliente_id`. É o padrão do portal; na
   * API é o parâmetro `meus=true` (specs/11 §4.1).
   */
  meus?: boolean;
  /**
   * Busca textual simples (specs/04 §10.4). Reutiliza a mesma interpretação da
   * fila (`busca.ts`): número → prefixo; texto → full-text sobre `busca_tsv`
   * (título + descrição, ambos públicos — nunca vaza nota interna). Como
   * `busca_tsv` cobre só campos públicos, é seguro no portal do cliente. Aqui é
   * FILTRO (mantém a ordenação por última atualização e o cursor keyset).
   */
  busca?: string;
  limite?: number;
  cursor?: string;
}

export interface PaginaChamados {
  itens: ChamadoView[];
  proximoCursor: string | null;
}

const LIMITE_PADRAO = 20;
const LIMITE_MAX = 100;

function encodeCursor(updated_at: Date | string, id: string): string {
  const iso = new Date(updated_at).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { updated_at: string; id: string } | null {
  try {
    const [updated_at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!updated_at || !id) return null;
    return { updated_at, id };
  } catch {
    return null;
  }
}

/**
 * Lista chamados com filtros (specs/04 §10) e keyset pagination por
 * `(updated_at DESC, id DESC)`. Todo papel enxerga os chamados do tenant (RLS
 * garante o isolamento) — o `cliente` também, desde a D-037, mas SEMPRE na
 * projeção pública (serializer allowlist: sem complexidade, operador, flag da
 * IA). O recorte "só os meus" é opcional (`filtros.meus`).
 */
export async function listarChamados(
  em: EntityManager,
  ator: AtorChamado,
  filtros: FiltrosChamado = {},
): Promise<PaginaChamados> {
  const limite = Math.min(Math.max(filtros.limite ?? LIMITE_PADRAO, 1), LIMITE_MAX);

  const qb = em.createQueryBuilder(ChamadoSchema, 'c').where('c.deleted_at IS NULL');

  // Recorte por solicitante (D-037): "meus" (o ator) ou um autor específico. Sem
  // recorte, todos os chamados do tenant — inclusive para o cliente.
  if (filtros.meus) {
    qb.andWhere('c.cliente_id = :autor', { autor: ator.id });
  } else if (filtros.cliente_id) {
    qb.andWhere('c.cliente_id = :autor', { autor: filtros.cliente_id });
  }

  const b = interpretarBusca(filtros.busca);
  if (b.modo === 'numero') {
    qb.andWhere('CAST(c.numero AS TEXT) LIKE :bnum', { bnum: `${b.numero}%` });
  } else if (b.modo === 'ilike') {
    qb.andWhere('c.titulo ILIKE :btermo', { btermo: `%${b.termo}%` });
  } else if (b.modo === 'fts') {
    qb.andWhere(exprMatchFts('c', 'btsq'), { btsq: b.tsq });
  }

  if (filtros.status) {
    const arr = Array.isArray(filtros.status) ? filtros.status : [filtros.status];
    if (arr.length > 0) qb.andWhere('c.status IN (:...status)', { status: arr });
  }
  if (filtros.natureza) qb.andWhere('c.natureza = :natureza', { natureza: filtros.natureza });
  if (filtros.prioridade)
    qb.andWhere('c.prioridade = :prioridade', { prioridade: filtros.prioridade });
  if (filtros.sistema_alvo_id)
    qb.andWhere('c.sistema_alvo_id = :sa', { sa: filtros.sistema_alvo_id });
  if (filtros.categoria_id) qb.andWhere('c.categoria_id = :cat', { cat: filtros.categoria_id });
  if (filtros.complexidade && ator.papel !== Papel.cliente) {
    const arr = Array.isArray(filtros.complexidade) ? filtros.complexidade : [filtros.complexidade];
    if (arr.length > 0) qb.andWhere('c.complexidade IN (:...cx)', { cx: arr });
  }

  // Atribuição é interna (specs/03 §7): com a leitura do tenant inteiro (D-037),
  // filtrar por ela revelaria ao cliente quais chamados têm responsável (e quem).
  // Mesmo tratamento de `complexidade`: ignorado para o cliente (a API recusa antes).
  const atribuicao = ator.papel === Papel.cliente ? undefined : filtros.atribuicao;
  if (atribuicao === 'nao_atribuido') {
    qb.andWhere('c.operador_id IS NULL');
  } else if (atribuicao === 'atribuido') {
    qb.andWhere('c.operador_id IS NOT NULL');
  } else if (typeof atribuicao === 'object' && atribuicao) {
    qb.andWhere('c.operador_id = :op', { op: atribuicao.operador_id });
  }

  if (filtros.cursor) {
    const cur = decodeCursor(filtros.cursor);
    if (cur) {
      qb.andWhere('(c.updated_at, c.id) < (:cu::timestamptz, :ci::uuid)', {
        cu: cur.updated_at,
        ci: cur.id,
      });
    }
  }

  qb.orderBy('c.updated_at', 'DESC')
    .addOrderBy('c.id', 'DESC')
    .take(limite + 1);

  const linhas = await qb.getMany();
  const temMais = linhas.length > limite;
  const pagina = temMais ? linhas.slice(0, limite) : linhas;
  const ultimo = pagina[pagina.length - 1];
  const proximoCursor = temMais && ultimo ? encodeCursor(ultimo.updated_at, ultimo.id) : null;

  return {
    itens: pagina.map((c) => serializarPorPapel(ator.papel, c)),
    proximoCursor,
  };
}

// ---------------------------------------------------------------------------
// Transição de status (máquina de estados)
// ---------------------------------------------------------------------------

/**
 * `motivo_obrigatorio` (D-042): o cliente tentou CONTESTAR (`resolvido →
 * em_atendimento`) sem uma mensagem pública na mesma transação — a contestação
 * exige o motivo (use `contestarResolucao` ou publique a mensagem).
 */
export type MotivoTransicionar =
  | 'inexistente'
  | 'sem_permissao'
  | 'motivo_obrigatorio'
  /** D-043: `custo_final` informado ao resolver é inválido (negativo, > 2 casas…). */
  | 'valor_invalido'
  | MotivoNegacao;

export type ResultadoTransicionar =
  { ok: true; chamado: ChamadoInterno } | { ok: false; motivo: MotivoTransicionar };

/**
 * Tipo de evento canônico (specs/02) associado a uma transição. As transições
 * notáveis têm evento próprio; as demais caem em `status_alterado`. Na janela de
 * aprovação (D-042) o papel do ator decide: cliente em `resolvido → fechado` =
 * `chamado_aprovado`; cliente em `resolvido → em_atendimento` =
 * `chamado_contestado` (no lugar de `chamado_reaberto`); `sistema` em
 * `resolvido → fechado` = `chamado_fechado_auto` (aprovação tácita).
 */
export function tipoEventoTransicao(
  ator: PapelTransicao,
  de: StatusChamado,
  para: StatusChamado,
): TipoEvento {
  if (para === StatusChamado.resolvido) return 'chamado_resolvido';
  if (para === StatusChamado.cancelado) return 'chamado_cancelado';
  if (ehContestacao(ator, de, para)) return 'chamado_contestado';
  // Reabertura de resolvido (pela equipe)/fechado/cancelado (specs/04 §8.2, D-038).
  if (ehReabertura(de, para)) return 'chamado_reaberto';
  if (ehAprovacaoDoCliente(ator, de, para)) return 'chamado_aprovado';
  if (para === StatusChamado.fechado)
    return ator === ATOR_SISTEMA ? 'chamado_fechado_auto' : 'chamado_fechado';
  return 'status_alterado';
}

/**
 * Mensagem pública do cliente gravada NESTA transação no chamado — o motivo da
 * contestação (D-042). `now()` é constante dentro da transação e é o default de
 * `mensagem.created_at`, então "criada agora" = "criada nesta transação" (o
 * `criarMensagem` insere a mensagem ANTES de reabrir). Todo serviço roda em
 * `runInTenantContext` (transação), condição desta checagem.
 */
async function mensagemDeContestacao(
  em: EntityManager,
  chamadoId: string,
  autorId: string | null,
): Promise<string | null> {
  if (!autorId) return null;
  const linhas: Array<{ id: string }> = await em.query(
    `SELECT id FROM mensagem
      WHERE chamado_id = $1 AND autor_id = $2 AND visibilidade = 'publica'
        AND deleted_at IS NULL AND created_at = now()
      ORDER BY id DESC LIMIT 1`,
    [chamadoId, autorId],
  );
  return linhas[0]?.id ?? null;
}

/**
 * Aplica uma transição de status (specs/04 §1): valida ownership/papel via
 * `autorizar()`, aplica a máquina de estados pura e registra os timestamps de
 * resolução/fechamento (agendando `fechar_automaticamente_em` — o PRAZO DE
 * APROVAÇÃO do cliente, D-042 — conforme `dias_fechamento_automatico` do
 * tenant). Transições inválidas são rejeitadas SEM tocar no banco (erro de
 * domínio). A contestação do cliente exige mensagem na mesma transação.
 *
 * `opts.custo_final` (D-043): ao RESOLVER, a equipe pode informar o custo final
 * no mesmo ato (`null` limpa; ausente = não mexe). Exige `chamado ·
 * definir_custo` — cliente/IA/sistema que o enviem recebem `sem_permissao` (sem
 * tocar no banco). Fora de `→ resolvido` é ignorado (a API recusa antes, 400).
 * Mudou o valor → evento `custo_final_definido` com `origem: 'resolucao'` (só
 * auditoria/timeline: não notifica nem dispara webhook próprio — o webhook
 * `resolvido` já leva `custo_final` no objeto `chamado`).
 */
export async function transicionarStatus(
  em: EntityManager,
  ator: AtorTransicao,
  id: string,
  novoStatus: StatusChamado,
  opts: { motivo?: string; custo_final?: number | null } = {},
  hooks?: HooksChamado,
): Promise<ResultadoTransicionar> {
  // Trava a linha (FOR UPDATE): duas transições concorrentes do mesmo chamado
  // (duplo clique em "Aprovar", cliente × job de aprovação tácita — D-042) são
  // serializadas; a segunda relê o status JÁ alterado e é recusada pela máquina
  // de estados, em vez de gravar por cima e duplicar evento/webhook.
  const c = await em.findOne(ChamadoSchema, {
    where: { id, deleted_at: IsNull() },
    lock: { mode: 'pessimistic_write' },
  });
  if (!c) return { ok: false, motivo: 'inexistente' };

  // Ownership/papel (coarse): o `sistema` é contexto confiável (jobs).
  if (ator.papel !== ATOR_SISTEMA) {
    const atorU: Ator = { id: ator.id ?? '', tenant_id: ator.tenant_id, papel: ator.papel };
    if (
      !autorizar(atorU, 'chamado', 'mudar_status', {
        cliente_id: c.cliente_id,
        tenant_id: c.tenant_id,
      })
    ) {
      return { ok: false, motivo: 'sem_permissao' };
    }
  }

  // Máquina de estados (fina): quem-pode-o-quê por transição.
  const val = transicaoValida(ator.papel, c.status, novoStatus);
  if (!val.ok) return { ok: false, motivo: val.motivo };

  // D-043: custo final no ato de resolver — só a equipe, valor validado ANTES
  // de qualquer escrita.
  let custoNovo: number | null | undefined;
  if (opts.custo_final !== undefined && novoStatus === StatusChamado.resolvido) {
    const atorU: Ator | null =
      ator.papel === ATOR_SISTEMA
        ? null
        : { id: ator.id ?? '', tenant_id: ator.tenant_id, papel: ator.papel };
    if (!atorU || !autorizar(atorU, 'chamado', 'definir_custo', { tenant_id: c.tenant_id })) {
      return { ok: false, motivo: 'sem_permissao' };
    }
    if (opts.custo_final === null) {
      custoNovo = null;
    } else {
      const v = validarCustoFinal(opts.custo_final);
      if (!v.ok) return { ok: false, motivo: 'valor_invalido' };
      custoNovo = v.valor;
    }
  }

  // D-042: contestar a resolução exige o motivo (mensagem pública do cliente).
  let mensagemContestacaoId: string | null = null;
  if (ehContestacao(ator.papel, c.status, novoStatus)) {
    mensagemContestacaoId = await mensagemDeContestacao(em, id, ator.id);
    if (!mensagemContestacaoId) return { ok: false, motivo: 'motivo_obrigatorio' };
  }

  const agora = new Date();
  const patch: Partial<Chamado> = { status: novoStatus };

  if (novoStatus === StatusChamado.resolvido) {
    // Abre a janela de aprovação do cliente (D-042): prazo materializado agora.
    const tenant = await em.findOne(TenantSchema, { where: { id: ator.tenant_id } });
    patch.resolvido_em = agora;
    patch.fechar_automaticamente_em = calcularPrazoAprovacao(
      agora,
      tenant?.dias_fechamento_automatico,
    );
    patch.fechado_em = null;
    if (custoNovo !== undefined) patch.custo_final = custoParaBanco(custoNovo);
  } else if (ehReabertura(c.status, novoStatus)) {
    // Reabertura (specs/04 §8.2, D-038) de resolvido/fechado/cancelado — inclui a
    // CONTESTAÇÃO do cliente (D-042): conta e limpa a janela de resolução e o
    // fechamento — o chamado volta a ser trabalho em aberto. NÃO dispara triagem
    // aqui; só a resposta pública do cliente re-enfileira (specs/05 §2).
    patch.reaberto_count = c.reaberto_count + 1;
    patch.resolvido_em = null;
    patch.fechar_automaticamente_em = null;
    patch.fechado_em = null;
  } else if (novoStatus === StatusChamado.fechado) {
    patch.fechado_em = agora;
    patch.fechar_automaticamente_em = null;
  }

  await em.update(ChamadoSchema, { id }, patch);

  const tipo = tipoEventoTransicao(ator.papel, c.status, novoStatus);
  await auditorDe(hooks)(em, {
    tipo,
    chamado_id: id,
    ator_id: ator.id,
    dados: {
      de: c.status,
      para: novoStatus,
      ...(opts.motivo ? { motivo: opts.motivo } : {}),
      // D-042: forma da aprovação (explícita pelo cliente / tácita pelo prazo) e
      // a mensagem que motivou a contestação — consumidos pelo webhook/timeline.
      ...(tipo === 'chamado_aprovado' ? { aprovacao: 'explicita' } : {}),
      ...(tipo === 'chamado_fechado_auto' ? { aprovacao: 'tacita' } : {}),
      ...(mensagemContestacaoId ? { mensagem_id: mensagemContestacaoId } : {}),
    },
  });

  // D-043: trilha do custo informado no ato de resolver (depois do evento de
  // resolução, para a timeline ler "resolveu → definiu o custo").
  const custoAnterior = custoDoBanco(c.custo_final);
  if (custoNovo !== undefined && custoNovo !== custoAnterior) {
    await auditorDe(hooks)(em, {
      tipo: 'custo_final_definido',
      chamado_id: id,
      ator_id: ator.id,
      dados: { de: custoAnterior, para: custoNovo, origem: ORIGEM_CUSTO_RESOLUCAO },
    });
  }

  const atualizado = (await carregar(em, id))!;
  return { ok: true, chamado: toChamadoInterno(atualizado) };
}

// ---------------------------------------------------------------------------
// Demais mutações
// ---------------------------------------------------------------------------

export type MotivoMutacao =
  'inexistente' | 'sem_permissao' | 'estado_terminal' | 'valor_invalido' | 'operador_invalido';

export type ResultadoMutacao = { ok: true } | { ok: false; motivo: MotivoMutacao };

/**
 * Atribui/reatribui o operador responsável (operador/admin — specs/04 §7). O alvo
 * precisa ser operador/admin ATIVO e não excluído — o mesmo universo que o
 * seletor do painel oferece (`listarOperadoresDoTenant`); fora disso o motivo é
 * `operador_invalido`. A busca do alvo roda sob RLS: um usuário de outro tenant
 * simplesmente não é encontrado (specs/11 §4.9, D-036 L4).
 *
 * `opts.motivo` (opcional) vai para `dados.motivo` do evento — a auto-atribuição
 * por resposta pública (D-039, `criarMensagem`) grava `resposta_publica`, para a
 * timeline dizer "assumiu o chamado ao responder".
 */
export async function atribuirOperador(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  operadorId: string,
  hooks?: HooksChamado,
  opts: { motivo?: string } = {},
): Promise<ResultadoMutacao> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (!autorizar(ator, 'chamado', 'atribuir')) return { ok: false, motivo: 'sem_permissao' };
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };

  const alvo = await em.findOne(UsuarioSchema, {
    where: { id: operadorId, deleted_at: IsNull() },
  });
  if (
    !alvo ||
    alvo.status !== StatusUsuario.ativo ||
    (alvo.papel !== Papel.operador && alvo.papel !== Papel.admin)
  ) {
    return { ok: false, motivo: 'operador_invalido' };
  }

  await em.update(ChamadoSchema, { id }, { operador_id: operadorId });
  await auditorDe(hooks)(em, {
    tipo: 'operador_atribuido',
    chamado_id: id,
    ator_id: ator.id,
    dados: {
      operador_anterior: c.operador_id,
      operador_novo: operadorId,
      ...(opts.motivo ? { motivo: opts.motivo } : {}),
    },
  });
  return { ok: true };
}

/** Remove a atribuição (volta a "não atribuído" — specs/04 §7). */
export async function desatribuirOperador(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  hooks?: HooksChamado,
): Promise<ResultadoMutacao> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (!autorizar(ator, 'chamado', 'atribuir')) return { ok: false, motivo: 'sem_permissao' };
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };

  await em.update(ChamadoSchema, { id }, { operador_id: null });
  await auditorDe(hooks)(em, {
    tipo: 'operador_desatribuido',
    chamado_id: id,
    ator_id: ator.id,
    dados: { operador_anterior: c.operador_id },
  });
  return { ok: true };
}

/** Altera a prioridade (specs/04 §3.2). Gera evento (M4). */
export async function alterarPrioridade(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  prioridade: Prioridade,
  hooks?: HooksChamado,
): Promise<ResultadoMutacao> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (
    !autorizar(ator, 'chamado', 'mudar_prioridade', {
      cliente_id: c.cliente_id,
      tenant_id: c.tenant_id,
    })
  ) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };
  if (!ehValorEnum(Prioridade, prioridade)) return { ok: false, motivo: 'valor_invalido' };

  await em.update(ChamadoSchema, { id }, { prioridade });
  await auditorDe(hooks)(em, {
    tipo: 'prioridade_alterada',
    chamado_id: id,
    ator_id: ator.id,
    dados: { de: c.prioridade, para: prioridade },
  });
  return { ok: true };
}

/**
 * Define/ajusta a complexidade INTERNA (só operador/admin/agente_ia — specs/04
 * §3.3). Nunca exposta ao cliente (serializer). `null` limpa a classificação.
 */
export async function definirComplexidade(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  complexidade: Complexidade | null,
  hooks?: HooksChamado,
): Promise<ResultadoMutacao> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (!autorizar(ator, 'chamado', 'classificar_complexidade')) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };
  if (complexidade !== null && !ehValorEnum(Complexidade, complexidade)) {
    return { ok: false, motivo: 'valor_invalido' };
  }

  await em.update(ChamadoSchema, { id }, { complexidade });
  await auditorDe(hooks)(em, {
    tipo: 'complexidade_alterada',
    chamado_id: id,
    ator_id: ator.id,
    dados: { de: c.complexidade, para: complexidade },
  });
  return { ok: true };
}

/**
 * Silencia/reativa a IA no chamado (D-024, specs/05 §2). Com `ia_silenciada`,
 * NENHUMA triagem roda (o worker descarta o job e o reprocessamento manual é
 * recusado) — usado quando a equipe quer conduzir o chamado sem interferência
 * da IA (ex.: análise fora de contexto). Só operador/admin (a agente_ia nunca
 * silencia/reativa a si mesma). Idempotente: repetir o mesmo valor é no-op sem
 * evento. Auditado como `ia_silenciada`/`ia_reativada` (interno — o cliente
 * não vê).
 *
 * D-041: silenciar também CANCELA a triagem em curso — publica no despachante o
 * evento `triagem_cancelamento_solicitado`, que pós-commit grava o sinal Redis
 * (o worker aborta a execução) e remove os jobs pendentes do chamado. Devolve
 * `triagemEmAndamento` (havia `ExecucaoIA` `na_fila`/`executando`) para a UI
 * avisar que ela foi cancelada.
 */
export async function definirSilencioIa(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  silenciada: boolean,
  hooks?: HooksChamado,
): Promise<ResultadoMutacao & { triagemEmAndamento?: boolean }> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (!autorizar(ator, 'chamado', 'silenciar_ia', { tenant_id: c.tenant_id })) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };
  if (c.ia_silenciada === silenciada) return { ok: true };

  await em.update(ChamadoSchema, { id }, { ia_silenciada: silenciada });
  await auditorDe(hooks)(em, {
    tipo: silenciada ? 'ia_silenciada' : 'ia_reativada',
    chamado_id: id,
    ator_id: ator.id,
    dados: { de: c.ia_silenciada, para: silenciada },
  });
  if (!silenciada) return { ok: true };
  hooks?.despachante?.publicar({
    tipo: 'triagem_cancelamento_solicitado',
    tenantId: c.tenant_id,
    chamadoId: id,
  });
  // Mesma consulta de `existeTriagemEmAndamento` (execucao-ia-service), inline
  // para não acoplar este serviço ao de ExecucaoIA.
  const ativas: Array<{ existe: boolean }> = await em.query(
    `SELECT EXISTS (SELECT 1 FROM execucao_ia
       WHERE chamado_id = $1 AND status IN ('na_fila', 'executando')) AS existe`,
    [id],
  );
  return { ok: true, triagemEmAndamento: ativas[0]?.existe === true };
}

/** Altera a natureza (specs/04 §3.1). Gera evento (M4). */
export async function alterarNatureza(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  natureza: Natureza,
  hooks?: HooksChamado,
): Promise<ResultadoMutacao> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (
    !autorizar(ator, 'chamado', 'mudar_natureza', {
      cliente_id: c.cliente_id,
      tenant_id: c.tenant_id,
    })
  ) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };
  if (!ehValorEnum(Natureza, natureza)) return { ok: false, motivo: 'valor_invalido' };

  await em.update(ChamadoSchema, { id }, { natureza });
  await auditorDe(hooks)(em, {
    tipo: 'natureza_alterada',
    chamado_id: id,
    ator_id: ator.id,
    dados: { de: c.natureza, para: natureza },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Custo (D-043): estimativa e custo final
// ---------------------------------------------------------------------------

/**
 * `custo_fora_da_resolucao`: o custo FINAL só é informado/corrigido com o
 * chamado em `resolvido` (ou no próprio ato de resolver — `transicionarStatus`).
 */
export type MotivoCusto = MotivoMutacao | 'custo_fora_da_resolucao';

export type ResultadoCusto = { ok: true; alterado: boolean } | { ok: false; motivo: MotivoCusto };

/**
 * Define/altera/limpa (`null`) a ESTIMATIVA DE CUSTO (D-043, specs/04 §3.4). Só
 * operador/admin (`chamado · definir_custo`); vale em qualquer status não
 * encerrado — inclusive `resolvido` —, recusada em fechado/cancelado
 * (`estado_terminal`, como as demais propriedades). Idempotente: o mesmo valor
 * não grava evento (`alterado: false`). Mudou → `estimativa_custo_alterada`
 * `{ de, para }` (visível ao cliente; notifica opt-in e dispara o webhook
 * `estimativa_custo_alterada`).
 */
export async function definirEstimativaCusto(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  estimativa: EstimativaCusto | null,
  hooks?: HooksChamado,
): Promise<ResultadoCusto> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (!autorizar(ator, 'chamado', 'definir_custo', { tenant_id: c.tenant_id })) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };
  if (estimativa !== null && !ehEstimativaCusto(estimativa)) {
    return { ok: false, motivo: 'valor_invalido' };
  }
  const anterior = c.estimativa_custo ?? null;
  if (anterior === estimativa) return { ok: true, alterado: false };

  await em.update(ChamadoSchema, { id }, { estimativa_custo: estimativa });
  await auditorDe(hooks)(em, {
    tipo: 'estimativa_custo_alterada',
    chamado_id: id,
    ator_id: ator.id,
    dados: { de: anterior, para: estimativa },
  });
  return { ok: true, alterado: true };
}

/**
 * Informa/corrige/limpa (`null`) o CUSTO FINAL em BRL (D-043) de um chamado em
 * `resolvido` — o valor que o cliente vê ao aprovar ou contestar. No ato de
 * resolver, use `transicionarStatus(..., { custo_final })`. Só operador/admin;
 * fechado/cancelado → `estado_terminal`; outros status →
 * `custo_fora_da_resolucao`. Valor negativo, com mais de 2 casas ou acima do
 * `numeric(12,2)` → `valor_invalido`. Idempotente (mesmo valor → sem evento).
 * Mudou → `custo_final_definido` `{ de, para }` (números em BRL), que notifica o
 * cliente e dispara o webhook `custo_final_definido`.
 */
export async function definirCustoFinal(
  em: EntityManager,
  ator: AtorChamado,
  id: string,
  valor: number | null,
  hooks?: HooksChamado,
): Promise<ResultadoCusto> {
  const c = await carregar(em, id);
  if (!c) return { ok: false, motivo: 'inexistente' };
  if (!autorizar(ator, 'chamado', 'definir_custo', { tenant_id: c.tenant_id })) {
    return { ok: false, motivo: 'sem_permissao' };
  }
  if (ehTerminal(c.status)) return { ok: false, motivo: 'estado_terminal' };
  if (c.status !== StatusChamado.resolvido) {
    return { ok: false, motivo: 'custo_fora_da_resolucao' };
  }
  let novo: number | null = null;
  if (valor !== null) {
    const v = validarCustoFinal(valor);
    if (!v.ok) return { ok: false, motivo: 'valor_invalido' };
    novo = v.valor;
  }
  const anterior = custoDoBanco(c.custo_final);
  if (anterior === novo) return { ok: true, alterado: false };

  await em.update(ChamadoSchema, { id }, { custo_final: custoParaBanco(novo) });
  await auditorDe(hooks)(em, {
    tipo: 'custo_final_definido',
    chamado_id: id,
    ator_id: ator.id,
    dados: { de: anterior, para: novo },
  });
  return { ok: true, alterado: true };
}
