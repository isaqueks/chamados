import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { validarRepoSistema } from '@chamados/shared';
import { SistemaAlvoSchema, type SistemaAlvo, type LogsConfig } from '../entities/sistema-alvo';
import type { SecretStore } from '../secrets/secret-store';
import { permitirRepoLocal } from '../config';

/**
 * CRUD de SistemaAlvo (specs/07 §5). Regras de ouro:
 *  - Segredos (credencial git/logs/BD) NUNCA saem em claro: as leituras
 *    retornam apenas a PRESENÇA da credencial (`tem_*_credencial`), nunca o valor.
 *  - Ao gravar, o valor em claro é enviado ao SecretStore e só a referência
 *    (`*_ref`) é persistida na tabela de negócio.
 *  - Rotação: substitui o valor sob a MESMA referência (não recadastra).
 */

/** Projeção de leitura de um SistemaAlvo — sem segredos, só presença. */
export interface SistemaAlvoResumo {
  id: string;
  nome: string;
  descricao: string | null;
  git_repo_url: string;
  git_branch_padrao: string;
  logs_tipo: string | null;
  logs_config: LogsConfig;
  bd_tipo: string | null;
  bd_host: string | null;
  bd_porta: number | null;
  bd_nome: string | null;
  ativo: boolean;
  tem_git_credencial: boolean;
  tem_logs_credencial: boolean;
  tem_bd_credencial: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Converte a linha do banco na projeção segura (sem valores de segredo). */
export function toResumoSistemaAlvo(s: SistemaAlvo): SistemaAlvoResumo {
  return {
    id: s.id,
    nome: s.nome,
    descricao: s.descricao,
    git_repo_url: s.git_repo_url,
    git_branch_padrao: s.git_branch_padrao,
    logs_tipo: s.logs_tipo,
    logs_config: s.logs_config,
    bd_tipo: s.bd_tipo,
    bd_host: s.bd_host,
    bd_porta: s.bd_porta,
    bd_nome: s.bd_nome,
    ativo: s.ativo,
    tem_git_credencial: !!s.git_credencial_ref,
    tem_logs_credencial: !!s.logs_credencial_ref,
    tem_bd_credencial: !!s.bd_credencial_ref,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

/** Campos de segredo em claro. `undefined`/'' = não altera; `limpar` remove. */
export interface EntradaSegredos {
  git_credencial?: string;
  git_credencial_limpar?: boolean;
  logs_credencial?: string;
  logs_credencial_limpar?: boolean;
  bd_credencial?: string;
  bd_credencial_limpar?: boolean;
}

export interface EntradaSistemaAlvo extends EntradaSegredos {
  nome: string;
  descricao?: string | null;
  git_repo_url: string;
  git_branch_padrao?: string;
  logs_tipo?: string | null;
  logs_config?: LogsConfig;
  bd_tipo?: string | null;
  bd_host?: string | null;
  bd_porta?: number | null;
  bd_nome?: string | null;
  ativo?: boolean;
}

/** Lista os sistemas-alvo do tenant (sem segredos). */
export async function listarSistemasAlvo(
  em: EntityManager,
  opts: { incluirInativos?: boolean } = {},
): Promise<SistemaAlvoResumo[]> {
  const where = opts.incluirInativos
    ? { deleted_at: IsNull() }
    : { deleted_at: IsNull(), ativo: true };
  const linhas = await em.find(SistemaAlvoSchema, {
    where,
    order: { nome: 'ASC' },
  });
  return linhas.map(toResumoSistemaAlvo);
}

/** Busca um sistema-alvo por id (sem segredos). `null` se não existir. */
export async function buscarSistemaAlvo(
  em: EntityManager,
  id: string,
): Promise<SistemaAlvoResumo | null> {
  const s = await em.findOne(SistemaAlvoSchema, { where: { id, deleted_at: IsNull() } });
  return s ? toResumoSistemaAlvo(s) : null;
}

/**
 * Aplica a mudança de um segredo: limpar remove; valor novo substitui (rotação)
 * ou cria; ausência mantém a referência atual. Retorna a nova referência.
 */
async function aplicarSegredo(
  em: EntityManager,
  store: SecretStore,
  tenantId: string,
  refAtual: string | null,
  valor: string | undefined,
  limpar: boolean | undefined,
): Promise<string | null> {
  if (limpar) {
    if (refAtual) await store.remover(em, refAtual);
    return null;
  }
  const v = valor?.trim();
  if (v === undefined || v === '') return refAtual;
  if (refAtual) {
    await store.substituir(em, refAtual, v);
    return refAtual;
  }
  return store.guardar(em, tenantId, v);
}

/**
 * Valida o `git_repo_url` (D-011). Repo REMOTO é sempre aceito; caminho LOCAL só
 * quando `SISTEMAS_PERMITIR_REPO_LOCAL=true`. Lança erro de validação com
 * mensagem clara (mencionando a flag) caso contrário. Retorna se o repo é local
 * — o chamador então DISPENSA a credencial git (repo local não a usa).
 */
function validarRepoOuFalhar(gitRepoUrl: string): { local: boolean } {
  const permitir = permitirRepoLocal();
  const r = validarRepoSistema(gitRepoUrl, { permitirLocal: permitir });
  if (r.ok) return { local: r.local };
  if (r.motivo === 'local_desabilitado') {
    throw new Error(
      'Repositório local não permitido: o caminho informado aponta para um diretório local ' +
        'do servidor, mas a flag SISTEMAS_PERMITIR_REPO_LOCAL não está ativa. Defina ' +
        'SISTEMAS_PERMITIR_REPO_LOCAL=true para habilitar repositórios locais (D-011).',
    );
  }
  throw new Error(
    'URL de repositório inválida. Use https:// ou git@host:org/repo.git' +
      (permitir ? ' ou um caminho absoluto local (ex.: C:\\repos\\meu-sistema).' : '.'),
  );
}

/**
 * Ajusta a entrada de segredos para repo LOCAL: a credencial git é dispensável
 * (D-011) — ignora qualquer valor enviado e limpa uma eventual credencial já
 * gravada (o worker nunca injeta credencial numa origem local).
 */
function dispensarCredencialSeLocal(
  entrada: EntradaSegredos,
  local: boolean,
): EntradaSegredos & { git_credencial?: string; git_credencial_limpar?: boolean } {
  if (!local) return entrada;
  return { ...entrada, git_credencial: undefined, git_credencial_limpar: true };
}

/** Cria um sistema-alvo, gravando eventuais segredos no cofre. Retorna o id. */
export async function criarSistemaAlvo(
  em: EntityManager,
  store: SecretStore,
  tenantId: string,
  entrada: EntradaSistemaAlvo,
): Promise<string> {
  const { local } = validarRepoOuFalhar(entrada.git_repo_url);
  const segredos = dispensarCredencialSeLocal(entrada, local);

  const git_credencial_ref = await aplicarSegredo(
    em,
    store,
    tenantId,
    null,
    segredos.git_credencial,
    false,
  );
  const logs_credencial_ref = await aplicarSegredo(
    em,
    store,
    tenantId,
    null,
    entrada.logs_credencial,
    false,
  );
  const bd_credencial_ref = await aplicarSegredo(
    em,
    store,
    tenantId,
    null,
    entrada.bd_credencial,
    false,
  );

  const res = await em.insert(SistemaAlvoSchema, {
    tenant_id: tenantId,
    nome: entrada.nome.trim(),
    descricao: entrada.descricao?.trim() || null,
    git_repo_url: entrada.git_repo_url.trim(),
    git_credencial_ref,
    git_branch_padrao: entrada.git_branch_padrao?.trim() || 'main',
    logs_tipo: entrada.logs_tipo?.trim() || null,
    logs_config: entrada.logs_config ?? {},
    logs_credencial_ref,
    bd_tipo: entrada.bd_tipo?.trim() || null,
    bd_host: entrada.bd_host?.trim() || null,
    bd_porta: entrada.bd_porta ?? null,
    bd_nome: entrada.bd_nome?.trim() || null,
    bd_credencial_ref,
    ativo: entrada.ativo ?? true,
  });
  return res.identifiers[0]!.id as string;
}

/** Atualiza um sistema-alvo; rotaciona/limpa segredos conforme a entrada. */
export async function atualizarSistemaAlvo(
  em: EntityManager,
  store: SecretStore,
  tenantId: string,
  id: string,
  entrada: EntradaSistemaAlvo,
): Promise<boolean> {
  const atual = await em.findOne(SistemaAlvoSchema, {
    where: { id, deleted_at: IsNull() },
  });
  if (!atual) return false;

  const { local } = validarRepoOuFalhar(entrada.git_repo_url);
  const segredos = dispensarCredencialSeLocal(entrada, local);

  const git_credencial_ref = await aplicarSegredo(
    em,
    store,
    tenantId,
    atual.git_credencial_ref,
    segredos.git_credencial,
    segredos.git_credencial_limpar,
  );
  const logs_credencial_ref = await aplicarSegredo(
    em,
    store,
    tenantId,
    atual.logs_credencial_ref,
    entrada.logs_credencial,
    entrada.logs_credencial_limpar,
  );
  const bd_credencial_ref = await aplicarSegredo(
    em,
    store,
    tenantId,
    atual.bd_credencial_ref,
    entrada.bd_credencial,
    entrada.bd_credencial_limpar,
  );

  await em.update(
    SistemaAlvoSchema,
    { id },
    {
      nome: entrada.nome.trim(),
      descricao: entrada.descricao?.trim() || null,
      git_repo_url: entrada.git_repo_url.trim(),
      git_credencial_ref,
      git_branch_padrao: entrada.git_branch_padrao?.trim() || 'main',
      logs_tipo: entrada.logs_tipo?.trim() || null,
      logs_config: entrada.logs_config ?? atual.logs_config,
      logs_credencial_ref,
      bd_tipo: entrada.bd_tipo?.trim() || null,
      bd_host: entrada.bd_host?.trim() || null,
      bd_porta: entrada.bd_porta ?? null,
      bd_nome: entrada.bd_nome?.trim() || null,
      bd_credencial_ref,
      ativo: entrada.ativo ?? atual.ativo,
    },
  );
  return true;
}

/** Ativa/desativa um sistema-alvo (inativos não aparecem para abrir chamados). */
export async function definirAtivoSistemaAlvo(
  em: EntityManager,
  id: string,
  ativo: boolean,
): Promise<void> {
  await em.update(SistemaAlvoSchema, { id }, { ativo });
}
