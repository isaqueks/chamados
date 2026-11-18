'use client';

import { Label } from '@/components/ui/label';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { clienteCasaBusca, type OpcaoSolicitante } from '@/lib/form-chamado';

/**
 * Solicitante do "Novo chamado" (D-040): select pesquisável dos clientes ATIVOS
 * do tenant, filtrando por nome ou e-mail (sem acento/caixa). Submete o id em
 * `solicitante_id`; o servidor revalida papel/status/tenant em `criarChamado`.
 */
export function SeletorSolicitante({
  opcoes,
  valor,
  aoMudar,
}: {
  opcoes: OpcaoSolicitante[];
  valor: OpcaoSolicitante | null;
  aoMudar: (v: OpcaoSolicitante | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="solicitante">Solicitante</Label>
      <Combobox
        items={opcoes}
        value={valor}
        onValueChange={(v) => aoMudar((v as OpcaoSolicitante | null) ?? null)}
        filter={(item, consulta) => clienteCasaBusca(item as OpcaoSolicitante, consulta)}
        itemToStringLabel={(o) => (o as OpcaoSolicitante).label}
        itemToStringValue={(o) => (o as OpcaoSolicitante).value}
        isItemEqualToValue={(a, b) =>
          (a as OpcaoSolicitante).value === (b as OpcaoSolicitante).value
        }
        name="solicitante_id"
        required
        autoHighlight
      >
        <ComboboxInput
          id="solicitante"
          placeholder="Busque o cliente por nome ou e-mail"
          aria-describedby="solicitante-ajuda"
          autoFocus
        />
        <ComboboxContent>
          <ComboboxEmpty>Nenhum cliente encontrado.</ComboboxEmpty>
          <ComboboxList>
            {(o: OpcaoSolicitante) => (
              <ComboboxItem key={o.value} value={o}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{o.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{o.email}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <p id="solicitante-ajuda" className="text-xs text-muted-foreground">
        O chamado fica em nome do cliente: ele recebe a confirmação de abertura e acompanha pelo
        portal.
      </p>
    </div>
  );
}
