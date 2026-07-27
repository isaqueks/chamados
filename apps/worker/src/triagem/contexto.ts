import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import { obterObjeto } from '@chamados/storage';
import {
  Papel,
  corHexValida,
  type AIProviderInput,
  type ImagemContexto,
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
  type MarcaArtefatos,
} from './ferramentas';
import { logoSuportado } from './ferramentas/pdf';
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
  /** Artefatos entregáveis gerados pela IA (D-026) — anexados na aplicação. */
  artefatos: FerramentasReais['artefatos'];
  /** Encerra recursos das ferramentas (conexão de BD + cópia descartável). */
  encerrar: FerramentasReais['encerrar'];
  /** Metadados do gate de resolução (specs/05 §6). */
  resolucao: ResolucaoContexto;
  /** Sistema-alvo do chamado (ou null) — chave do mapa de conhecimento (D-013). */
  sistemaAlvoId: string | null;
  /**
   * Baixa do storage as imagens inline do chamado (#16) e as injeta em
   * `input.contexto.imagens` para envio multimodal. Chamar FORA da transação
   * (I/O de storage) e best-effort: nunca lança — falha vira log e a triagem
   * segue sem as imagens.
   */
  carregarImagens(): Promise<void>;
  /** Nº de imagens inline COLETADAS na Tx1 (#16) — espelhado em `entrada`. */
  refsImagens: number;
}

/** Limites do contexto multimodal (#16): nº de imagens e bytes por imagem. */
const MAX_IMAGENS_CONTEXTO = 8;
const MAX_IMAGEM_BYTES = 4 * 1024 * 1024; // limite prático da API (5MB) com folga

/** Referência de imagem inline coletada na Tx1 (download pós-transação). */
interface RefImagem {
  origem: 'descricao' | 'mensagem';
  nome: string;
  mediaType: string;
  storageKey: string;
}

/**
 * Coleta as REFERÊNCIAS das imagens inline do chamado (#16): as da DESCRIÇÃO
 * (anexo sem mensagem) e as de mensagens PÚBLICAS — nunca de notas internas.
 * Só metadados (o download acontece fora da transação); respeita o teto de
 * quantidade/tamanho.
 */
async function coletarRefsImagens(em: EntityManager, chamadoId: string): Promise<RefImagem[]> {
  const linhas: Array<{
    nome_arquivo: string;
    content_type: string;
    tamanho_bytes: string;
    storage_key: string;
    origem: 'descricao' | 'mensagem';
  }> = await em.query(
    `SELECT a.nome_arquivo, a.content_type, a.tamanho_bytes, a.storage_key,
            CASE WHEN a.mensagem_id IS NULL THEN 'descricao' ELSE 'mensagem' END AS origem
       FROM anexo a
       LEFT JOIN mensagem m ON m.id = a.mensagem_id
      WHERE a.chamado_id = $1
        AND a.deleted_at IS NULL
        AND a.content_type LIKE 'image/%'
        AND (a.mensagem_id IS NULL OR (m.visibilidade = 'publica' AND m.deleted_at IS NULL))
      ORDER BY a.created_at ASC`,
    [chamadoId],
  );
  return linhas
    .filter((l) => Number(l.tamanho_bytes) <= MAX_IMAGEM_BYTES)
    .slice(0, MAX_IMAGENS_CONTEXTO)
    .map((l) => ({
      origem: l.origem,
      nome: l.nome_arquivo,
      mediaType: l.content_type,
      storageKey: l.storage_key,
    }));
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

/**
 * Identidade visual do tenant para os PDFs de artefato (D-027): nome de exibição,
 * cor primária (só se hex válida) e um loader LAZY do logo claro — o download do
 * storage só acontece se a IA de fato gerar um PDF, é best-effort (falha → sem
 * logo, nunca derruba a triagem) e aceita apenas PNG/JPEG (o que o pdfkit embute).
 */
function marcaDoTenant(
  tenant: Awaited<ReturnType<typeof carregarTenant>>,
): MarcaArtefatos | undefined {
  if (!tenant) return undefined;
  const branding = tenant.config_branding ?? {};
  const corPrimaria =
    branding.cor_primaria && corHexValida(branding.cor_primaria) ? branding.cor_primaria : null;
  const chaveLogo = branding.logo_light_url?.trim() ? branding.logo_light_url.trim() : null;
  return {
    nome: tenant.nome_exibicao ?? null,
    corPrimaria,
    carregarLogo: chaveLogo
      ? async (): Promise<Buffer | null> => {
          try {
            const obj = await obterObjeto(chaveLogo);
            if (!obj || !logoSuportado(obj.corpo)) return null;
            return obj.corpo;
          } catch {
            return null;
          }
        }
      : undefined,
  };
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

  // SEQUENCIAL de propósito: o `em` transacional usa UM único cliente pg —
  // `Promise.all` aqui dispararia queries concorrentes no mesmo cliente
  // (paralelismo ilusório: o driver serializa, warna no pg@8 e LANÇA no pg@9).
  const timeline = await timelineCompleta(em, chamadoId);
  const sistemaAlvo = await metadadosSistemaAlvo(em, chamado.sistema_alvo_id, chamado.categoria_id);
  const configFerramentas = await resolverConfigFerramentas(
    em,
    chamado.tenant_id,
    chamado.sistema_alvo_id,
  );
  const tenant = await carregarTenant(em, chamado.tenant_id);
  const solicitanteUsuario = await em.findOne(UsuarioSchema, {
    where: { id: chamado.cliente_id },
  });

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
    marca: marcaDoTenant(tenant),
  });

  // #16: coleta as REFERÊNCIAS das imagens inline ainda na Tx1 (só metadados);
  // o download real acontece em `carregarImagens()` (pós-transação).
  const refsImagens = await coletarRefsImagens(em, chamadoId);

  const preparacao: PreparacaoContexto = {
    input: {
      contexto: {
        titulo: chamado.titulo,
        descricao,
        naturezaDeclarada: chamado.natureza,
        prioridadeDeclarada: chamado.prioridade,
        solicitante,
        timeline,
        sistemaAlvo,
        imagens: [],
        // D-020: instruções do admin do tenant — entram no SYSTEM PROMPT da
        // triagem (seção demarcada, subordinada às regras da plataforma).
        instrucoesTenant: tenant?.ia_instrucoes ?? null,
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
    artefatos: reais.artefatos,
    encerrar: reais.encerrar,
    resolucao: {
      habilitadaPreCall,
      tenantHabilitado,
      repo: configFerramentas.repo,
      numeroChamado: String(chamado.numero),
    },
    sistemaAlvoId: chamado.sistema_alvo_id,
    refsImagens: refsImagens.length,
    // #16: download pós-transação (best-effort) das imagens coletadas na Tx1.
    async carregarImagens(): Promise<void> {
      if (refsImagens.length === 0) return;
      const carregadas: ImagemContexto[] = [];
      for (const ref of refsImagens) {
        try {
          const obj = await obterObjeto(ref.storageKey);
          if (!obj) continue;
          carregadas.push({
            origem: ref.origem,
            nome: ref.nome,
            mediaType: ref.mediaType,
            dadosBase64: obj.corpo.toString('base64'),
          });
        } catch (err) {
          deps.log('imagem do contexto não pôde ser baixada (ignorada)', {
            chamadoId,
            nome: ref.nome,
            erro: (err as Error).message,
          });
        }
      }
      preparacao.input.contexto.imagens = carregadas;
      if (carregadas.length > 0) {
        deps.log('imagens carregadas para o contexto multimodal', {
          chamadoId,
          quantidade: carregadas.length,
        });
      }
    },
  };
  return preparacao;
}
