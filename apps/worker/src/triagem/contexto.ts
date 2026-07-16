import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import {
  Papel,
  type AIProviderInput,
  type MensagemTimeline,
  type MetadadosSistemaAlvo,
} from '@chamados/shared';
import {
  ChamadoSchema,
  MensagemSchema,
  UsuarioSchema,
  SistemaAlvoSchema,
  CategoriaSchema,
  carregarTenant,
} from '@chamados/db';
import type { Registrar } from './ferramentas/config';
import {
  resolverConfigFerramentas,
  montarFerramentasReais,
  type FerramentasReais,
} from './ferramentas';
import type { ConfigRepo } from './ferramentas/repo';
import { portaResolucaoAberta } from './resolucao';

/**
 * Monta o `AIProviderInput` (specs/05 §3.1 passo 3, §4.1): metadados do chamado +
 * timeline PÚBLICA sanitizada + metadados do sistema-alvo SEM credenciais (nem
 * DSN, nem caminho de repo cru). Roda dentro de `runInTenantContext` (RLS).
 *
 * M7: as FERRAMENTAS agora são REAIS (repo/logs/BD read-only) — as credenciais
 * são decifradas do cofre AQUI (no worker, RLS ativa) e capturadas em closures;
 * o provider recebe só handles. Além do `input`, devolve `sincronizar()` (git
 * clone/pull antes do provider — specs/05 §3.1 passo 2) e `encerrar()` (libera o
 * pool de BD ao fim do job).
 */

export interface DepsContexto {
  /** Trilha de ações (preenchida pelos handles de ferramenta). */
  acoes: unknown[];
  log: (msg: string, extra?: Record<string, unknown>) => void;
  limites: { timeoutMs: number; budgetUsd: number; maxTurnos: number };
}

/**
 * Metadados de RESOLUÇÃO (specs/05 §6) que o pipeline usa após o provider: o
 * resultado do gate PRÉ-call e a config do repo (repoUrl/credencial/branchPadrao)
 * — que vive SÓ no worker, nunca no provider — necessária para branch/push/PR.
 */
export interface ResolucaoContexto {
  /** Gate PRÉ-call: as ferramentas de escrita foram injetadas nesta triagem? */
  habilitadaPreCall: boolean;
  /** Guardrail do tenant (`ia_resolucao_automatica_habilitada`). */
  tenantHabilitado: boolean;
  /** Config do repo (worker-only): usada pelo push/PR. `null` se não há repo. */
  repo: ConfigRepo | null;
  /** Número legível do chamado (para nomear a branch / referenciar no PR). */
  numeroChamado: string;
}

export interface PreparacaoContexto {
  input: AIProviderInput;
  /** Sincroniza a working copy do sistema-alvo (specs/05 §3.2). */
  sincronizar: FerramentasReais['sincronizar'];
  /** Prepara a working copy descartável da resolução (specs/05 §6). */
  prepararResolucao: FerramentasReais['prepararResolucao'];
  /** Cópia descartável preparada (ou null). */
  copiaResolucao: FerramentasReais['copiaResolucao'];
  /** Diretório do checkout sincronizado (ou null) — usado pelo mapeamento (D-013). */
  checkout: FerramentasReais['checkout'];
  /** Encerra recursos das ferramentas (conexão de BD + cópia descartável). */
  encerrar: FerramentasReais['encerrar'];
  /** Metadados do gate de resolução (specs/05 §6). */
  resolucao: ResolucaoContexto;
  /** Sistema-alvo do chamado (ou null) — chave do mapa de conhecimento (D-013). */
  sistemaAlvoId: string | null;
}

/** Converte HTML sanitizado numa projeção de texto puro (para o contexto do modelo). */
function htmlParaTexto(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Deriva um resumo de stack (SEM credenciais) a partir dos tipos configurados. */
function stackDe(bdTipo: string | null, logsTipo: string | null): string | null {
  const partes: string[] = [];
  if (bdTipo) partes.push(`bd: ${bdTipo}`);
  if (logsTipo) partes.push(`logs: ${logsTipo}`);
  return partes.length > 0 ? partes.join(' · ') : null;
}

async function metadadosSistemaAlvo(
  em: EntityManager,
  sistemaAlvoId: string | null,
  categoriaId: string | null,
): Promise<MetadadosSistemaAlvo> {
  if (sistemaAlvoId) {
    const s = await em.findOne(SistemaAlvoSchema, { where: { id: sistemaAlvoId } });
    if (s) {
      return { nome: s.nome, descricao: s.descricao, stack: stackDe(s.bd_tipo, s.logs_tipo) };
    }
  }
  if (categoriaId) {
    const c = await em.findOne(CategoriaSchema, { where: { id: categoriaId } });
    if (c) return { nome: c.nome, descricao: c.descricao, stack: null };
  }
  return { nome: 'Sistema não especificado', descricao: null, stack: null };
}

/**
 * Timeline COMPLETA do chamado (D-015): TODAS as mensagens — públicas E internas —,
 * cada uma com visibilidade, autor (nome/papel) e momento. O papel `agente_ia` tem
 * permissão de leitura pela matriz (specs/03), então a IA passa a ver o próprio
 * diagnóstico anterior (continuidade) e as orientações internas da equipe. A ordem
 * segue (created_at ASC, id ASC) — a mesma do painel — para o modelo ler os eventos
 * na sequência real. A demarcação por visibilidade é feita no prompt.
 */
async function timelineCompleta(em: EntityManager, chamadoId: string): Promise<MensagemTimeline[]> {
  const msgs = await em.find(MensagemSchema, {
    where: {
      chamado_id: chamadoId,
      deleted_at: IsNull(),
    },
    order: { created_at: 'ASC', id: 'ASC' },
  });
  const autorIds = Array.from(new Set(msgs.map((m) => m.autor_id)));
  const autores = new Map<string, { nome: string; papel: Papel }>();
  if (autorIds.length > 0) {
    const usuarios = await em.find(UsuarioSchema, { where: autorIds.map((id) => ({ id })) });
    for (const u of usuarios) autores.set(u.id, { nome: u.nome, papel: u.papel });
  }
  return msgs.map((m) => {
    const autor = autores.get(m.autor_id);
    return {
      id: m.id,
      autorPapel: autor?.papel ?? Papel.cliente,
      autorNome: autor?.nome ?? 'Desconhecido',
      visibilidade: m.visibilidade,
      corpo: htmlParaTexto(m.corpo_html),
      criadaEm: new Date(m.created_at).toISOString(),
    };
  });
}

/** Registrador da trilha de ações: loga a chamada da ferramenta (SEM segredos). */
function registradorDe(deps: DepsContexto): Registrar {
  return (ferramenta, args) => {
    deps.acoes.push({ ferramenta, args, em: new Date().toISOString() });
    deps.log('ferramenta chamada', { ferramenta });
  };
}

/**
 * Constrói a preparação do contexto do chamado (input + sincronizar + encerrar).
 * Retorna `null` se o chamado não existir (rollback/soft delete) — o processador
 * então ignora o job.
 */
export async function montarInput(
  em: EntityManager,
  chamadoId: string,
  deps: DepsContexto,
): Promise<PreparacaoContexto | null> {
  const chamado = await em.findOne(ChamadoSchema, {
    where: { id: chamadoId, deleted_at: IsNull() },
  });
  if (!chamado) return null;

  const [timeline, sistemaAlvo, configFerramentas, tenant, solicitanteUsuario] = await Promise.all([
    timelineCompleta(em, chamadoId),
    metadadosSistemaAlvo(em, chamado.sistema_alvo_id, chamado.categoria_id),
    resolverConfigFerramentas(em, chamado.tenant_id, chamado.sistema_alvo_id),
    carregarTenant(em, chamado.tenant_id),
    em.findOne(UsuarioSchema, { where: { id: chamado.cliente_id } }),
  ]);

  // D-014: a DESCRIÇÃO do chamado (o pedido do cliente) — projeção de texto puro
  // do HTML sanitizado — passa a integrar o contexto (antes omitida: o bug do M6).
  const descricao = htmlParaTexto(chamado.descricao_html);
  const solicitante = {
    nome: solicitanteUsuario?.nome ?? 'Solicitante',
    papel: solicitanteUsuario?.papel ?? Papel.cliente,
  };
  // Um ÚNICO registrador alimenta a trilha `acoes`: usado pelos handles MCP e,
  // via `exploracao.auditar`, pelas ferramentas NATIVAS (Read/Grep/Glob — D-014).
  const registrar = registradorDe(deps);

  // Gate PRÉ-call da resolução automática (specs/05 §6): decide se as ferramentas
  // de escrita são sequer injetadas. O gate PÓS-call (natureza efetiva/complexidade/
  // confiança) é reavaliado no processador com o resultado real do provider.
  const tenantHabilitado = tenant?.ia_resolucao_automatica_habilitada === true;
  const habilitadaPreCall = portaResolucaoAberta({
    tenantHabilitado,
    naturezaDeclarada: chamado.natureza,
    repoConfigurado: configFerramentas.repo !== null,
  });

  const reais = montarFerramentasReais(configFerramentas, registrar, {
    resolucaoHabilitada: habilitadaPreCall,
  });

  return {
    input: {
      contexto: {
        titulo: chamado.titulo,
        descricao,
        naturezaDeclarada: chamado.natureza,
        prioridadeDeclarada: chamado.prioridade,
        solicitante,
        timeline,
        sistemaAlvo,
      },
      ferramentas: reais.ferramentas,
      limites: deps.limites,
      // D-014: exploração NATIVA (Read/Grep/Glob). `checkoutDir` é preenchido pelo
      // processador APÓS o git sync (aqui a working copy ainda não existe); a
      // `auditar` é o mesmo registrador da trilha `acoes`.
      exploracao: { checkoutDir: null, auditar: registrar },
    },
    sincronizar: reais.sincronizar,
    prepararResolucao: reais.prepararResolucao,
    copiaResolucao: reais.copiaResolucao,
    checkout: reais.checkout,
    encerrar: reais.encerrar,
    resolucao: {
      habilitadaPreCall,
      tenantHabilitado,
      repo: configFerramentas.repo,
      numeroChamado: String(chamado.numero),
    },
    sistemaAlvoId: chamado.sistema_alvo_id,
  };
}
