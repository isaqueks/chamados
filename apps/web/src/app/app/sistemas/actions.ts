'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  obterAppDataSource,
  runInTenantContext,
  criarSecretStore,
  criarSistemaAlvo,
  atualizarSistemaAlvo,
  definirAtivoSistemaAlvo,
  permitirRepoLocal,
  type EntradaSistemaAlvo,
} from '@chamados/db';
import { autorizar, validarRepoSistema } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';

export interface EstadoSistema {
  erro?: string;
}

/** Extrai e valida os campos comuns do formulário de sistema-alvo. */
function lerEntrada(
  formData: FormData,
): { ok: true; entrada: EntradaSistemaAlvo } | { ok: false; erro: string } {
  const nome = String(formData.get('nome') ?? '').trim();
  if (nome.length < 2) return { ok: false, erro: 'Informe o nome do sistema.' };

  const git_repo_url = String(formData.get('git_repo_url') ?? '').trim();
  const permitirLocal = permitirRepoLocal();
  const repo = validarRepoSistema(git_repo_url, { permitirLocal });
  if (!repo.ok) {
    return {
      ok: false,
      erro:
        repo.motivo === 'local_desabilitado'
          ? 'Repositório local não permitido nesta instalação (SISTEMAS_PERMITIR_REPO_LOCAL desativada).'
          : 'URL de repositório inválida. Use https:// ou git@host:org/repo.git' +
            (permitirLocal ? ' ou um caminho absoluto local.' : '.'),
    };
  }

  const portaRaw = String(formData.get('bd_porta') ?? '').trim();
  let bd_porta: number | null = null;
  if (portaRaw !== '') {
    const n = Number(portaRaw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, erro: 'Porta do BD inválida (1–65535).' };
    }
    bd_porta = n;
  }

  const entrada: EntradaSistemaAlvo = {
    nome,
    descricao: String(formData.get('descricao') ?? '').trim() || null,
    git_repo_url,
    git_branch_padrao: String(formData.get('git_branch_padrao') ?? '').trim() || 'main',
    logs_tipo: String(formData.get('logs_tipo') ?? '').trim() || null,
    bd_tipo: String(formData.get('bd_tipo') ?? '').trim() || null,
    bd_host: String(formData.get('bd_host') ?? '').trim() || null,
    bd_porta,
    bd_nome: String(formData.get('bd_nome') ?? '').trim() || null,
    ativo: formData.get('ativo') === 'on',
    // Segredos (valores em claro; vazio = não altera).
    git_credencial: String(formData.get('git_credencial') ?? ''),
    git_credencial_limpar: formData.get('git_credencial_limpar') === 'on',
    logs_credencial: String(formData.get('logs_credencial') ?? ''),
    logs_credencial_limpar: formData.get('logs_credencial_limpar') === 'on',
    bd_credencial: String(formData.get('bd_credencial') ?? ''),
    bd_credencial_limpar: formData.get('bd_credencial_limpar') === 'on',
  };
  return { ok: true, entrada };
}

function ehNomeDuplicado(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/** Cria um sistema-alvo (admin). Segredos vão para o cofre. */
export async function acaoCriarSistema(
  _prev: EstadoSistema,
  formData: FormData,
): Promise<EstadoSistema> {
  const { tenant, usuario } = await exigirUsuario();
  if (!autorizar(usuario, 'sistema_alvo', 'criar')) {
    return { erro: 'Sem permissão.' };
  }

  const parsed = lerEntrada(formData);
  if (!parsed.ok) return { erro: parsed.erro };

  const ds = await obterAppDataSource();
  const store = criarSecretStore();
  try {
    await runInTenantContext(ds, tenant.id, (em) =>
      criarSistemaAlvo(em, store, tenant.id, parsed.entrada),
    );
  } catch (e: unknown) {
    if (ehNomeDuplicado(e)) {
      return { erro: 'Já existe um sistema-alvo com este nome.' };
    }
    throw e;
  }

  revalidatePath('/app/sistemas');
  redirect('/app/sistemas');
}

/** Atualiza um sistema-alvo (admin). Rotaciona/limpa segredos conforme entrada. */
export async function acaoAtualizarSistema(
  _prev: EstadoSistema,
  formData: FormData,
): Promise<EstadoSistema> {
  const { tenant, usuario } = await exigirUsuario();
  if (!autorizar(usuario, 'sistema_alvo', 'editar')) {
    return { erro: 'Sem permissão.' };
  }
  const id = String(formData.get('id') ?? '');
  if (!id) return { erro: 'Sistema-alvo inválido.' };

  const parsed = lerEntrada(formData);
  if (!parsed.ok) return { erro: parsed.erro };

  const ds = await obterAppDataSource();
  const store = criarSecretStore();
  try {
    const ok = await runInTenantContext(ds, tenant.id, (em) =>
      atualizarSistemaAlvo(em, store, tenant.id, id, parsed.entrada),
    );
    if (!ok) return { erro: 'Sistema-alvo não encontrado.' };
  } catch (e: unknown) {
    if (ehNomeDuplicado(e)) {
      return { erro: 'Já existe um sistema-alvo com este nome.' };
    }
    throw e;
  }

  revalidatePath('/app/sistemas');
  redirect('/app/sistemas');
}

/** Ativa/desativa um sistema-alvo (admin). */
export async function acaoDefinirAtivoSistema(formData: FormData): Promise<void> {
  const { tenant, usuario } = await exigirUsuario();
  if (!autorizar(usuario, 'sistema_alvo', 'editar')) return;
  const id = String(formData.get('id') ?? '');
  const ativo = formData.get('ativo') === 'true';
  if (!id) return;

  const ds = await obterAppDataSource();
  await runInTenantContext(ds, tenant.id, (em) => definirAtivoSistemaAlvo(em, id, ativo));
  revalidatePath('/app/sistemas');
}
