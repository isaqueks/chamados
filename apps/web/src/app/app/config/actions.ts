'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  obterAppDataSource,
  runInTenantContext,
  carregarTenant,
  atualizarBranding,
  atualizarNomeExibicao,
  atualizarConfigGeral,
  definirDominioProprio,
  type ConfigBranding,
} from '@chamados/db';
import {
  autorizar,
  avaliarCorMarca,
  corHexValida,
  normalizarHex,
  dominioProprioValido,
  normalizarDominio,
} from '@chamados/shared';
import { enviarObjeto, removerObjeto, chaveBranding } from '@chamados/storage';
import { exigirUsuario } from '@/lib/sessao';
import { chaveLogo, type VarianteLogo } from '@/lib/branding';
import { validarImagemLogo } from '@/lib/upload-imagem';

export interface EstadoConfig {
  erro?: string;
  sucesso?: string;
}

/** Garante admin + permissão de branding; retorna tenant/usuario ou lança. */
async function exigirAdminBranding() {
  const ctx = await exigirUsuario();
  if (!autorizar(ctx.usuario, 'branding', 'gerenciar')) {
    throw new Error('Sem permissão.');
  }
  return ctx;
}

/** Avalia uma cor de branding: '' limpa (null); inválida/reprova AA = erro. */
function resolverCor(
  ativa: boolean,
  valor: string,
): { ok: true; cor: string | null } | { ok: false; erro: string } {
  if (!ativa) return { ok: true, cor: null };
  if (!corHexValida(valor)) {
    return { ok: false, erro: 'Cor inválida. Use um valor hexadecimal (ex.: #2563eb).' };
  }
  const aval = avaliarCorMarca(valor);
  if (!aval.ok) {
    return {
      ok: false,
      erro: `A cor ${valor} não atinge o contraste mínimo AA sobre fundo claro (${aval.razao.toFixed(
        2,
      )}:1 < 4.5:1). Escolha um tom mais escuro.`,
    };
  }
  return { ok: true, cor: normalizarHex(valor) };
}

/** Salva identidade (nome de exibição, nome da IA, remetente) e cores. */
export async function acaoSalvarBranding(
  _prev: EstadoConfig,
  formData: FormData,
): Promise<EstadoConfig> {
  const { tenant } = await exigirAdminBranding();

  const nomeExibicao = String(formData.get('nome_exibicao') ?? '').trim();
  if (nomeExibicao.length < 2) {
    return { erro: 'Informe o nome de exibição (mín. 2 caracteres).' };
  }

  const primaria = resolverCor(
    formData.get('cor_primaria_ativa') === 'on',
    String(formData.get('cor_primaria') ?? ''),
  );
  if (!primaria.ok) return { erro: primaria.erro };

  const secundaria = resolverCor(
    formData.get('cor_secundaria_ativa') === 'on',
    String(formData.get('cor_secundaria') ?? ''),
  );
  if (!secundaria.ok) return { erro: secundaria.erro };

  const parcial: Partial<ConfigBranding> = {
    cor_primaria: primaria.cor,
    cor_secundaria: secundaria.cor,
    agente_ia_nome: String(formData.get('agente_ia_nome') ?? '').trim() || 'Assistente',
    email_remetente_nome: String(formData.get('email_remetente_nome') ?? '').trim() || null,
    email_remetente_endereco: String(formData.get('email_remetente_endereco') ?? '').trim() || null,
  };

  const ds = await obterAppDataSource();
  await runInTenantContext(ds, tenant.id, async (em) => {
    await atualizarNomeExibicao(em, tenant.id, nomeExibicao);
    await atualizarBranding(em, tenant.id, parcial);
  });

  revalidatePath('/app/config');
  revalidatePath('/app', 'layout');
  return { sucesso: 'Identidade e cores salvas.' };
}

/** Envia/substitui um logo (variante clara/escura) no storage do tenant. */
export async function acaoEnviarLogo(
  _prev: EstadoConfig,
  formData: FormData,
): Promise<EstadoConfig> {
  const { tenant } = await exigirAdminBranding();

  const variante = String(formData.get('variante') ?? '') as VarianteLogo;
  if (variante !== 'light' && variante !== 'dark') {
    return { erro: 'Variante de logo inválida.' };
  }
  const arquivo = formData.get('arquivo');
  if (!(arquivo instanceof File)) {
    return { erro: 'Selecione um arquivo de imagem.' };
  }

  const val = await validarImagemLogo(arquivo);
  if (!val.ok) return { erro: val.erro };

  const novaChave = chaveBranding(tenant.id, `logo-${variante}-${randomUUID()}.${val.ext}`);
  await enviarObjeto(novaChave, val.buffer, val.contentType);

  const ds = await obterAppDataSource();
  const chaveAntiga = await runInTenantContext(ds, tenant.id, async (em) => {
    const t = await carregarTenant(em, tenant.id);
    const antiga = chaveLogo(t?.config_branding, variante);
    const parcial: Partial<ConfigBranding> =
      variante === 'light' ? { logo_light_url: novaChave } : { logo_dark_url: novaChave };
    await atualizarBranding(em, tenant.id, parcial);
    return antiga;
  });
  // Remove o objeto antigo (best-effort) após trocar a referência.
  if (chaveAntiga && chaveAntiga !== novaChave) {
    try {
      await removerObjeto(chaveAntiga);
    } catch {
      /* GC assíncrono cobrirá; não falha a troca */
    }
  }

  revalidatePath('/app/config');
  revalidatePath('/app', 'layout');
  return { sucesso: `Logo (${variante === 'light' ? 'claro' : 'escuro'}) atualizado.` };
}

/** Remove um logo do tenant. */
export async function acaoRemoverLogo(formData: FormData): Promise<void> {
  const { tenant } = await exigirAdminBranding();
  const variante = String(formData.get('variante') ?? '') as VarianteLogo;
  if (variante !== 'light' && variante !== 'dark') return;

  const ds = await obterAppDataSource();
  const chave = await runInTenantContext(ds, tenant.id, async (em) => {
    const t = await carregarTenant(em, tenant.id);
    const atual = chaveLogo(t?.config_branding, variante);
    const parcial: Partial<ConfigBranding> =
      variante === 'light' ? { logo_light_url: null } : { logo_dark_url: null };
    await atualizarBranding(em, tenant.id, parcial);
    return atual;
  });
  if (chave) {
    try {
      await removerObjeto(chave);
    } catch {
      /* ignore */
    }
  }
  revalidatePath('/app/config');
  revalidatePath('/app', 'layout');
}

/** Salva as configurações gerais do tenant (auto-fechamento, IA). */
export async function acaoSalvarGeral(
  _prev: EstadoConfig,
  formData: FormData,
): Promise<EstadoConfig> {
  const ctx = await exigirUsuario();
  if (!autorizar(ctx.usuario, 'config_notificacoes', 'editar')) {
    return { erro: 'Sem permissão.' };
  }

  const dias = Number(formData.get('dias_fechamento_automatico'));
  if (!Number.isFinite(dias) || dias < 1 || dias > 365) {
    return { erro: 'O prazo de fechamento deve estar entre 1 e 365 dias.' };
  }
  const iaAuto = formData.get('ia_resolucao_automatica_habilitada') === 'on';

  const ds = await obterAppDataSource();
  await runInTenantContext(ds, ctx.tenant.id, (em) =>
    atualizarConfigGeral(em, ctx.tenant.id, {
      dias_fechamento_automatico: dias,
      ia_resolucao_automatica_habilitada: iaAuto,
    }),
  );
  revalidatePath('/app/config');
  return { sucesso: 'Configurações gerais salvas.' };
}

/** Define/limpa o domínio próprio do tenant (specs/07 §3.4, E-08). */
export async function acaoSalvarDominio(
  _prev: EstadoConfig,
  formData: FormData,
): Promise<EstadoConfig> {
  const { tenant } = await exigirAdminBranding();

  const bruto = String(formData.get('dominio_proprio') ?? '').trim();
  if (bruto === '') {
    const ds = await obterAppDataSource();
    await runInTenantContext(ds, tenant.id, (em) => definirDominioProprio(em, tenant.id, null));
    revalidatePath('/app/config');
    return { sucesso: 'Domínio próprio removido (voltou ao subdomínio da plataforma).' };
  }

  const dominio = normalizarDominio(bruto);
  if (!dominioProprioValido(dominio)) {
    return {
      erro: 'Domínio inválido. Informe um host válido (ex.: suporte.suaempresa.com), sem http:// nem caminho.',
    };
  }

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    definirDominioProprio(em, tenant.id, dominio),
  );
  if (!r.ok) {
    return { erro: 'Este domínio já está em uso por outro tenant.' };
  }
  revalidatePath('/app/config');
  return {
    sucesso: `Domínio ${dominio} salvo. Aponte um CNAME para a plataforma; o certificado TLS (ACME) é provisionado no deploy (fora do escopo de dev).`,
  };
}
