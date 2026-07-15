/**
 * Cabeçalho de marca do tenant (logo whitelabel ou inicial). Reutilizado na
 * sidebar (desktop) e no sheet (mobile). Sem marca da plataforma "Chamados" no
 * painel por ora (whitelabel — specs/08 §7).
 */
export function Marca({ tenantNome, logoUrl }: { tenantNome: string; logoUrl?: string | null }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt={tenantNome} className="h-7 max-w-[168px] object-contain" />
    );
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
        {tenantNome.charAt(0).toUpperCase()}
      </div>
      <span className="truncate text-sm font-semibold">{tenantNome}</span>
    </div>
  );
}
