import type { Papel, StatusTenant } from '@chamados/shared';
import type { ConfigBranding } from '../entities/tenant';

/** Tenant resolvido a partir do host (slug/domínio), pré-autenticação. */
export interface TenantResolvido {
  id: string;
  slug: string;
  dominio_proprio: string | null;
  nome_exibicao: string;
  status: StatusTenant;
  config_branding: ConfigBranding;
}

/** Usuário autenticado exposto à camada web (nunca inclui senha_hash). */
export interface UsuarioAutenticado {
  id: string;
  tenant_id: string;
  email: string;
  nome: string;
  papel: Papel;
  avatar_url: string | null;
}

/** Resultado do login. `ok:false` é sempre genérico (anti-enumeração). */
export type ResultadoLogin =
  { ok: true; token: string; usuario: UsuarioAutenticado } | { ok: false };
