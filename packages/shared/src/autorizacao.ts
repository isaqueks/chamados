/**
 * Ponto ÚNICO de decisão de autorização (specs/03 §8 e §9).
 *
 * Implementa a matriz papel × recurso × ação. Toda rota, route handler e server
 * action DEVE chamar `autorizar(...)` antes de agir — a UI apenas esconde; a
 * fronteira real é o servidor. As checagens de `tenant_id` continuam garantidas
 * em profundidade pela RLS do PostgreSQL (specs/02); aqui decidimos papel +
 * ownership.
 *
 * Convenções da matriz da spec: ✅ permitido · ⚠️ condicional · ❌ negado.
 * `admin` inclui tudo de `operador` (admin ⊇ operador).
 */
import { Papel } from './enums';
import type { VisibilidadeMensagem } from './enums';

/** Recursos protegidos (specs/03 §8.1 e §8.2). */
export type Recurso =
  | 'chamado'
  | 'mensagem_publica'
  | 'mensagem_interna'
  | 'anexo'
  | 'evento_chamado'
  | 'execucao_ia'
  | 'usuario'
  | 'sistema_alvo'
  | 'categoria'
  | 'branding'
  | 'config_notificacoes'
  | 'preferencia_notificacao'
  | 'guardrail_ia'
  | 'pr_ia'
  | 'sessao';

/** Ações possíveis sobre um recurso. Nem toda ação vale para todo recurso. */
export type Acao =
  | 'criar'
  | 'ler'
  | 'escrever'
  | 'mudar_status'
  | 'mudar_prioridade'
  | 'mudar_natureza'
  | 'atribuir'
  | 'classificar_complexidade'
  | 'fechar'
  | 'cancelar'
  | 'enviar'
  | 'baixar'
  | 'convidar'
  | 'listar'
  | 'editar'
  | 'desativar'
  | 'aprovar'
  | 'gerenciar'
  | 'encerrar_terceiros';

/**
 * O ator que tenta a ação (derivado da sessão + tenant resolvido). Estrutural:
 * qualquer objeto com `id`/`tenant_id`/`papel` serve (ex.: `UsuarioAutenticado`).
 */
export interface Ator {
  id: string;
  tenant_id: string;
  papel: Papel;
}

/**
 * Alvo opcional da ação, para checagens de ownership/condição.
 * Campos ausentes = "não informado" (a condição que depender deles falha fechado
 * quando a informação é obrigatória).
 */
export interface Alvo {
  /** tenant dono do recurso (operador/admin exigem == ator.tenant_id). */
  tenant_id?: string;
  /** autor do recurso (mensagem/anexo); usado no ownership do cliente. */
  autor_id?: string;
  /** solicitante do chamado; usado no ownership do cliente. */
  cliente_id?: string;
  /** visibilidade da mensagem-alvo, quando aplicável. */
  visibilidade?: VisibilidadeMensagem;
  /** papel que um convite concederia (specs/03 §4.2). */
  papel_convidado?: Papel;
  /** flag de tenant: operador pode convidar cliente (specs/07 §4). */
  operador_pode_convidar_cliente?: boolean;
}

/** Decisão: `true`/`false` fixos ou uma condição avaliada com ator+alvo. */
type Decisao = boolean | ((ator: Ator, alvo: Alvo) => boolean);
type RegraPorPapel = Partial<Record<Papel, Decisao>>;
type Matriz = Record<Recurso, Partial<Record<Acao, RegraPorPapel>>>;

/** Cliente só age sobre o que é dele (autor da mensagem ou solicitante do chamado). */
function clienteDono(ator: Ator, alvo: Alvo): boolean {
  if (alvo.autor_id !== undefined) return alvo.autor_id === ator.id;
  if (alvo.cliente_id !== undefined) return alvo.cliente_id === ator.id;
  // Sem alvo de ownership informado: nega (fail-closed). Criação do próprio
  // recurso é tratada com regra específica (ver `chamado.criar`).
  return false;
}

/** Operador/admin agem dentro do próprio tenant (RLS é a rede de segurança). */
function mesmoTenant(ator: Ator, alvo: Alvo): boolean {
  return alvo.tenant_id === undefined || alvo.tenant_id === ator.tenant_id;
}

const { admin, operador, cliente, agente_ia } = Papel;

/**
 * Matriz canônica. Onde `admin` não tem regra explícita, herda a de `operador`
 * (admin ⊇ operador) — resolvido em `regraParaPapel`.
 */
const MATRIZ: Matriz = {
  chamado: {
    // Cliente sempre pode criar o PRÓPRIO chamado (será o solicitante).
    criar: { [operador]: true, [cliente]: true, [agente_ia]: false },
    ler: {
      [operador]: mesmoTenant,
      [cliente]: clienteDono,
      [agente_ia]: mesmoTenant,
    },
    mudar_status: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
    mudar_prioridade: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
    mudar_natureza: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
    atribuir: { [operador]: true, [cliente]: false, [agente_ia]: false },
    classificar_complexidade: {
      [operador]: true,
      [cliente]: false,
      [agente_ia]: true,
    },
    fechar: { [operador]: true, [cliente]: false, [agente_ia]: false },
    cancelar: { [operador]: true, [cliente]: false, [agente_ia]: false },
  },
  mensagem_publica: {
    escrever: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
    ler: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
  },
  mensagem_interna: {
    // Fronteira inegociável: cliente NUNCA lê/escreve nota interna (specs/03 §7).
    escrever: { [operador]: true, [cliente]: false, [agente_ia]: true },
    ler: { [operador]: true, [cliente]: false, [agente_ia]: true },
  },
  anexo: {
    enviar: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
    baixar: { [operador]: true, [cliente]: clienteDono, [agente_ia]: true },
  },
  evento_chamado: {
    ler: { [operador]: true, [cliente]: clienteDono, [agente_ia]: mesmoTenant },
  },
  execucao_ia: {
    // Cliente nunca vê ExecucaoIA (nem existência). agente_ia só as próprias.
    ler: { [operador]: true, [cliente]: false, [agente_ia]: mesmoTenant },
  },
  usuario: {
    // admin convida QUALQUER papel; operador só cliente (se o tenant habilitar).
    convidar: {
      [admin]: true,
      [operador]: (_ator, alvo) =>
        alvo.papel_convidado === cliente &&
        alvo.operador_pode_convidar_cliente === true,
      [cliente]: false,
      [agente_ia]: false,
    },
    listar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
    editar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
    desativar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
  },
  sistema_alvo: {
    ler: { [operador]: true, [cliente]: false, [agente_ia]: false },
    criar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
    editar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
  },
  categoria: {
    ler: { [operador]: true, [cliente]: false, [agente_ia]: false },
    criar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
    editar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
  },
  branding: {
    gerenciar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
  },
  config_notificacoes: {
    ler: { [operador]: true, [cliente]: false, [agente_ia]: false },
    editar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
  },
  preferencia_notificacao: {
    // A PRÓPRIA preferência do usuário (humano). agente_ia não tem preferências.
    gerenciar: { [operador]: true, [cliente]: true, [agente_ia]: false },
  },
  guardrail_ia: {
    gerenciar: { [admin]: true, [operador]: false, [cliente]: false, [agente_ia]: false },
  },
  pr_ia: {
    // Aprovar merge/deploy do PR da IA: humano operador/admin. agente_ia NUNCA
    // aprova as próprias ações (guardrail — specs/03 §6, specs/05).
    aprovar: { [operador]: true, [cliente]: false, [agente_ia]: false },
  },
  sessao: {
    encerrar_terceiros: {
      [admin]: true,
      [operador]: false,
      [cliente]: false,
      [agente_ia]: false,
    },
  },
};

/** Resolve a decisão bruta de um papel, aplicando a herança admin ⊇ operador. */
function regraParaPapel(
  regras: RegraPorPapel | undefined,
  papel: Papel,
): Decisao | undefined {
  if (!regras) return undefined;
  if (papel === admin) {
    // admin usa a regra própria se existir; senão herda a do operador.
    return regras[admin] ?? regras[operador];
  }
  return regras[papel];
}

/**
 * Decide se `ator` pode executar `acao` sobre `recurso` (opcionalmente sobre um
 * `alvo` específico). Default: NEGAR (allowlist, não denylist).
 */
export function autorizar(
  ator: Ator,
  recurso: Recurso,
  acao: Acao,
  alvo: Alvo = {},
): boolean {
  const decisao = regraParaPapel(MATRIZ[recurso]?.[acao], ator.papel);
  if (decisao === undefined) return false;
  if (typeof decisao === 'boolean') return decisao;
  return decisao(ator, alvo);
}
