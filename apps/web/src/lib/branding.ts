import type { ConfigBranding } from '@chamados/db';
import { avaliarCorMarca, corHexValida } from '@chamados/shared';

/**
 * Aplicação do branding whitelabel na UI (specs/07 §3.2, specs/08 §7). As cores
 * do tenant viram CSS custom properties injetadas no `:root`. Cada cor passa por
 * checagem de contraste AA; se reprovar (ou for inválida), NÃO é aplicada e a UI
 * cai no fallback neutro dos defaults do design system.
 */

/** Variantes de logo servidas pela aplicação. */
export type VarianteLogo = 'light' | 'dark';

/** A chave do objeto de logo (armazenada em `config_branding`) para a variante. */
export function chaveLogo(
  branding: ConfigBranding | null | undefined,
  variante: VarianteLogo,
): string | null {
  if (!branding) return null;
  const v = variante === 'light' ? branding.logo_light_url : branding.logo_dark_url;
  return v && v.trim() !== '' ? v : null;
}

/** Há logo cadastrado para a variante? */
export function temLogo(
  branding: ConfigBranding | null | undefined,
  variante: VarianteLogo,
): boolean {
  return chaveLogo(branding, variante) !== null;
}

/** Hash curto e estável de uma string (cache-busting do logo). */
function hashCurto(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

/** URL (rota da aplicação) que serve o logo da variante, com cache-busting. */
export function urlLogo(
  branding: ConfigBranding | null | undefined,
  variante: VarianteLogo,
): string | null {
  const chave = chaveLogo(branding, variante);
  if (!chave) return null;
  return `/api/branding/logo?variant=${variante}&v=${hashCurto(chave)}`;
}

/**
 * Monta o CSS (`:root { ... }`) com as variáveis de branding do tenant. Retorna
 * string vazia quando não há nada aplicável (fallback neutro). Cores que
 * reprovam no contraste AA são descartadas (a UI mantém o neutro).
 */
export function cssBranding(branding: ConfigBranding | null | undefined): string {
  if (!branding) return '';
  const linhas: string[] = [];

  const primaria = branding.cor_primaria;
  if (primaria && corHexValida(primaria)) {
    const aval = avaliarCorMarca(primaria);
    if (aval.ok) {
      linhas.push(`--primary:${primaria};`);
      linhas.push(`--primary-foreground:${aval.foreground};`);
      linhas.push(`--sidebar-primary:${primaria};`);
      linhas.push(`--sidebar-primary-foreground:${aval.foreground};`);
      linhas.push(`--ring:${primaria};`);
    }
  }

  const secundaria = branding.cor_secundaria;
  if (secundaria && corHexValida(secundaria)) {
    const aval = avaliarCorMarca(secundaria);
    if (aval.ok) {
      linhas.push(`--marca-acento:${secundaria};`);
      linhas.push(`--marca-acento-foreground:${aval.foreground};`);
    }
  }

  return linhas.length > 0 ? `:root{${linhas.join('')}}` : '';
}
