import type { Ref } from 'react';
import { RefreshCwIcon, SearchIcon } from 'lucide-react';
import type { FilaDto, FiltrosFilaDto } from '@comum/dto';
import {
  ROTULO_COMPLEXIDADE,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_STATUS_CHAMADO,
} from '@/lib/rotulos';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import {
  OPCOES_COMPLEXIDADE,
  OPCOES_NATUREZA,
  OPCOES_PRIORIDADE,
  OPCOES_STATUS,
  rotuloComContagem,
  rotuloFiltro,
} from './logica-fila';

/**
 * Barra de filtros da Fila (specs/forja/06 §4.1 "Filtros"): dropdowns por
 * dimensão seguindo a regra D-030 do Chamados (08 §4.4) — contador no rótulo
 * de cada opção —, busca por número ou título e o interruptor "só
 * implementáveis". A complexidade é filtrada em memória até D-036 L3 (F-19).
 */

type ChaveMulti = 'status' | 'natureza' | 'prioridade' | 'complexidade';

function FiltroMulti<V extends string>({
  nome,
  opcoes,
  selecionados,
  rotulos,
  contagens,
  aoMudar,
}: {
  nome: string;
  opcoes: V[];
  selecionados: V[];
  rotulos: Record<V, string>;
  contagens: Partial<Record<V, number>> | undefined;
  aoMudar: (v: V[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        {rotuloFiltro(nome, selecionados, (v) => rotulos[v as V])}
        <span className="text-muted-foreground" aria-hidden>
          ▾
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {opcoes.map((o) => (
          <DropdownMenuCheckboxItem
            key={o}
            checked={selecionados.includes(o)}
            closeOnClick={false}
            onCheckedChange={(marcado) =>
              aoMudar(marcado ? [...selecionados, o] : selecionados.filter((s) => s !== o))
            }
          >
            {rotuloComContagem(rotulos[o], contagens?.[o])}
          </DropdownMenuCheckboxItem>
        ))}
        {selecionados.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => aoMudar([])}>Limpar</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FiltrosFila({
  filtros,
  contagens,
  aoMudar,
  sincronizadoHa,
  sincronizando,
  aoSincronizar,
  refBusca,
}: {
  filtros: FiltrosFilaDto;
  contagens: FilaDto['contagens'] | undefined;
  aoMudar: (f: FiltrosFilaDto) => void;
  sincronizadoHa: string | null;
  sincronizando: boolean;
  aoSincronizar: () => void;
  refBusca?: Ref<HTMLInputElement>;
}) {
  function mudar<K extends ChaveMulti>(chave: K, valor: FiltrosFilaDto[K]): void {
    aoMudar({ ...filtros, [chave]: valor });
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FiltroMulti
        nome="Status"
        opcoes={OPCOES_STATUS}
        selecionados={filtros.status ?? []}
        rotulos={ROTULO_STATUS_CHAMADO}
        contagens={contagens?.status}
        aoMudar={(v) => mudar('status', v)}
      />
      <FiltroMulti
        nome="Natureza"
        opcoes={OPCOES_NATUREZA}
        selecionados={filtros.natureza ?? []}
        rotulos={ROTULO_NATUREZA}
        contagens={contagens?.natureza}
        aoMudar={(v) => mudar('natureza', v)}
      />
      <FiltroMulti
        nome="Prioridade"
        opcoes={OPCOES_PRIORIDADE}
        selecionados={filtros.prioridade ?? []}
        rotulos={ROTULO_PRIORIDADE}
        contagens={contagens?.prioridade}
        aoMudar={(v) => mudar('prioridade', v)}
      />
      <FiltroMulti
        nome="Complexidade"
        opcoes={OPCOES_COMPLEXIDADE}
        selecionados={filtros.complexidade ?? []}
        rotulos={ROTULO_COMPLEXIDADE}
        contagens={contagens?.complexidade}
        aoMudar={(v) => mudar('complexidade', v)}
      />
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={refBusca}
          value={filtros.busca ?? ''}
          onChange={(e) => aoMudar({ ...filtros, busca: e.target.value })}
          placeholder="buscar nº ou título"
          aria-label="Buscar por número ou título"
          className="h-7 w-56 pl-7"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={filtros.so_implementaveis ?? false}
          onCheckedChange={(v) => aoMudar({ ...filtros, so_implementaveis: v })}
        />
        só implementáveis
      </label>
      <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {sincronizadoHa && <span>sincronizado {sincronizadoHa}</span>}
        <Button variant="outline" size="sm" onClick={aoSincronizar} disabled={sincronizando}>
          <RefreshCwIcon className={sincronizando ? 'animate-spin' : undefined} aria-hidden />
          Atualizar
        </Button>
      </div>
    </div>
  );
}
