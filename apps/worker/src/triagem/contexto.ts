import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import {
  VisibilidadeMensagem,
  Papel,
  type AIProviderInput,
  type MensagemPublica,
  type MetadadosSistemaAlvo,
} from '@chamados/shared';
import {
  ChamadoSchema,
  MensagemSchema,
  UsuarioSchema,
  SistemaAlvoSchema,
  CategoriaSchema,
} from '@chamados/db';
import type { Registrar } from './ferramentas/config';
import {
  resolverConfigFerramentas,
  montarFerramentasReais,
  type FerramentasReais,
} from './ferramentas';

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

export interface PreparacaoContexto {
  input: AIProviderInput;
  /** Sincroniza a working copy do sistema-alvo (specs/05 §3.2). */
  sincronizar: FerramentasReais['sincronizar'];
  /** Encerra recursos das ferramentas (conexão de BD). */
  encerrar: FerramentasReais['encerrar'];
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

async function timelinePublica(em: EntityManager, chamadoId: string): Promise<MensagemPublica[]> {
  const msgs = await em.find(MensagemSchema, {
    where: {
      chamado_id: chamadoId,
      visibilidade: VisibilidadeMensagem.publica,
      deleted_at: IsNull(),
    },
    order: { created_at: 'ASC' },
  });
  const autorIds = Array.from(new Set(msgs.map((m) => m.autor_id)));
  const papeis = new Map<string, Papel>();
  if (autorIds.length > 0) {
    const usuarios = await em.find(UsuarioSchema, { where: autorIds.map((id) => ({ id })) });
    for (const u of usuarios) papeis.set(u.id, u.papel);
  }
  return msgs.map((m) => ({
    id: m.id,
    autorPapel: papeis.get(m.autor_id) ?? Papel.cliente,
    corpo: htmlParaTexto(m.corpo_html),
    criadaEm: new Date(m.created_at).toISOString(),
  }));
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

  const [timeline, sistemaAlvo, configFerramentas] = await Promise.all([
    timelinePublica(em, chamadoId),
    metadadosSistemaAlvo(em, chamado.sistema_alvo_id, chamado.categoria_id),
    resolverConfigFerramentas(em, chamado.tenant_id, chamado.sistema_alvo_id),
  ]);

  const reais = montarFerramentasReais(configFerramentas, registradorDe(deps));

  return {
    input: {
      contexto: {
        titulo: chamado.titulo,
        naturezaDeclarada: chamado.natureza,
        timeline,
        sistemaAlvo,
      },
      ferramentas: reais.ferramentas,
      limites: deps.limites,
    },
    sincronizar: reais.sincronizar,
    encerrar: reais.encerrar,
  };
}
