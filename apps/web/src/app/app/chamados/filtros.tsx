'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  STATUS_ABERTOS,
  STATUS_ENCERRADOS,
  ORDEM_ESTIMATIVA_CUSTO,
  type SituacaoChamado,
} from '@chamados/shared';
import type { ContadoresFila, CampoOrdenacaoFila } from '@chamados/db';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { PontoPrioridade, PontoStatus } from '@/components/chamado/badges';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
} from '@/lib/rotulos';
import {
  hrefFila,
  contarMaisFiltros,
  ordemEfetiva,
  rotuloEstimativaFiltro,
  ehDataIso,
  ehUuid,
  TAMANHOS_PAGINA,
  CAMPOS_ORDENACAO,
  descreverOrdem,
  type EstadoFila,
  type ResponsavelFila,
  type TamanhoPagina,
} from '@/lib/fila-params';
import { cn } from '@/lib/utils';

interface Opcao {
  id: string;
  nome: string;
}

interface Props {
  estado: EstadoFila;
  contadores: ContadoresFila;
  operadores: Opcao[];
  clientes: (Opcao & { email: string })[];
  sistemas: Opcao[];
  categorias: Opcao[];
  /** A ordem padrão é a relevância (busca full-text sem ordenação escolhida). */
  buscaPorRelevancia: boolean;
}

/** Filtros rápidos de situação (D-030): o recorte que a equipe usa o dia inteiro. */
const SITUACOES: { valor: SituacaoChamado; rotulo: string }[] = [
  { valor: 'abertos', rotulo: 'Em aberto' },
  { valor: 'encerrados', rotulo: 'Encerrados' },
  { valor: 'todos', rotulo: 'Todos' },
];

/** Prioridades da mais à menos urgente (é a ordem em que o operador pensa). */
const PRIORIDADES_DESC: Prioridade[] = [
  Prioridade.urgente,
  Prioridade.alta,
  Prioridade.media,
  Prioridade.baixa,
];

/**
 * Barra de ferramentas da fila (D-045, specs/08 §4.4). Uma faixa coesa, na ordem
 * das perguntas do operador: QUAL recorte (situação, D-030) → O QUÊ (busca) →
 * DE QUEM / EM QUE ESTADO / QUÃO URGENTE (os três filtros diários) → o resto em
 * "Mais filtros". Tudo vira URL (`lib/fila-params`): links compartilháveis e a
 * página continua server component.
 */
export function FilaBarra({
  estado,
  contadores,
  operadores,
  clientes,
  sistemas,
  categorias,
  buscaPorRelevancia,
}: Props) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();

  function ir(mudancas: Partial<EstadoFila>) {
    startTransition(() => router.push(hrefFila(estado, mudancas)));
  }

  return (
    <div
      className="flex flex-col gap-3 border-b p-3 sm:p-4"
      aria-busy={pendente || undefined}
      data-pendente={pendente || undefined}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SegmentoSituacao estado={estado} contadores={contadores} />
        <CampoBusca estado={estado} aoBuscar={(busca) => ir({ busca })} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FiltroResponsavel
          estado={estado}
          contadores={contadores}
          operadores={operadores}
          aoEscolher={(responsavel) => ir({ responsavel })}
        />
        <FiltroStatus
          estado={estado}
          contadores={contadores}
          aoEscolher={(status) => ir({ status })}
        />
        <FiltroPrioridade estado={estado} aoEscolher={(prioridade) => ir({ prioridade })} />
        <MaisFiltros
          estado={estado}
          clientes={clientes}
          sistemas={sistemas}
          categorias={categorias}
          aoAplicar={ir}
        />
        {/* Ordenação sempre visível (inclui "Criado", que não tem coluna própria);
            os cabeçalhos da tabela ordenam as colunas visíveis. */}
        <OrdenacaoCompacta
          estado={estado}
          buscaPorRelevancia={buscaPorRelevancia}
          aoEscolher={(ordem) => ir({ ordem })}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Situação

function SegmentoSituacao({
  estado,
  contadores,
}: {
  estado: EstadoFila;
  contadores: ContadoresFila;
}) {
  const conta = (s: SituacaoChamado) =>
    s === 'todos' ? contadores.porSituacao.total : contadores.porSituacao[s];
  return (
    <nav aria-label="Situação dos chamados" className="w-full sm:w-auto">
      <ul className="flex w-full items-center gap-1 rounded-lg bg-muted p-1 sm:w-fit">
        {SITUACOES.map((s) => {
          const ativo = estado.situacao === s.valor;
          return (
            <li key={s.valor} className="flex-1 sm:flex-none">
              <Link
                href={hrefFila(estado, { situacao: s.valor })}
                aria-current={ativo ? 'page' : undefined}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                  ativo
                    ? 'bg-background text-foreground shadow-sm dark:bg-input/40'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {s.rotulo}
                <span
                  className={cn(
                    'text-xs tabular-nums',
                    ativo ? 'text-muted-foreground' : 'text-muted-foreground/70',
                  )}
                >
                  {conta(s.valor)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ------------------------------------------------------------------- Busca

function CampoBusca({
  estado,
  aoBuscar,
}: {
  estado: EstadoFila;
  aoBuscar: (busca: string) => void;
}) {
  const [busca, setBusca] = useState(estado.busca);
  // Mantém o campo em sincronia quando a URL muda por fora (chip "Limpar tudo", voltar).
  const [ultimaUrl, setUltimaUrl] = useState(estado.busca);
  if (ultimaUrl !== estado.busca) {
    setUltimaUrl(estado.busca);
    setBusca(estado.busca);
  }

  return (
    // Busca full-text (título + descrição, com ranking) — specs/04 §10.4
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        aoBuscar(busca.trim());
      }}
      className="relative w-full lg:w-72 xl:w-80"
    >
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        name="q"
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar por número, título ou descrição…"
        aria-label="Buscar chamados"
        className="h-8 pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {busca && (
        <button
          type="button"
          aria-label="Limpar busca"
          onClick={() => {
            setBusca('');
            if (estado.busca) aoBuscar('');
          }}
          className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" />
        </button>
      )}
    </form>
  );
}

// ---------------------------------------------------- Filtros de uso diário

/** Gatilho dos filtros: rótulo da dimensão + valor escolhido (quando houver). */
function GatilhoFiltro({ rotulo, valor }: { rotulo: string; valor?: string }) {
  return (
    <DropdownMenuTrigger
      data-ativo={valor ? 'true' : undefined}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'max-w-[16rem] data-[ativo=true]:border-primary/40',
      )}
    >
      <span className={cn(valor ? 'text-muted-foreground' : 'text-foreground')}>{rotulo}</span>
      {valor && <span className="truncate font-medium text-foreground">{valor}</span>}
      <ChevronDown className="text-muted-foreground" aria-hidden />
    </DropdownMenuTrigger>
  );
}

function Contagem({ n }: { n: number }) {
  return <span className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums">{n}</span>;
}

function FiltroResponsavel({
  estado,
  contadores,
  operadores,
  aoEscolher,
}: {
  estado: EstadoFila;
  contadores: ContadoresFila;
  operadores: Opcao[];
  aoEscolher: (r: ResponsavelFila) => void;
}) {
  const valor =
    estado.responsavel === 'meus'
      ? 'Atribuídos a mim'
      : estado.responsavel === 'nenhum'
        ? 'Não atribuídos'
        : estado.responsavel
          ? (operadores.find((o) => o.id === estado.responsavel)?.nome ?? 'Operador')
          : undefined;
  return (
    <DropdownMenu>
      <GatilhoFiltro rotulo="Responsável" valor={valor} />
      <DropdownMenuContent className="w-64">
        <DropdownMenuRadioGroup
          value={estado.responsavel || 'qualquer'}
          onValueChange={(v: string) => aoEscolher(v === 'qualquer' ? '' : v)}
        >
          <DropdownMenuRadioItem value="qualquer" closeOnClick>
            Qualquer responsável
            <Contagem n={contadores.total} />
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="meus" closeOnClick>
            Atribuídos a mim
            <Contagem n={contadores.meus} />
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="nenhum" closeOnClick>
            Não atribuídos
            <Contagem n={contadores.naoAtribuidos} />
          </DropdownMenuRadioItem>
          {operadores.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Equipe</DropdownMenuLabel>
                {operadores.map((o) => (
                  <DropdownMenuRadioItem key={o.id} value={o.id} closeOnClick>
                    <span className="truncate">{o.nome}</span>
                    <Contagem n={contadores.porOperador[o.id] ?? 0} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FiltroStatus({
  estado,
  contadores,
  aoEscolher,
}: {
  estado: EstadoFila;
  contadores: ContadoresFila;
  aoEscolher: (s: StatusChamado | undefined) => void;
}) {
  // D-030: só os status da situação escolhida — a interseção "Em aberto + Fechado"
  // não é oferecida — e só os que têm chamado. O atual entra sempre (veio por URL).
  const daSituacao =
    estado.situacao === 'abertos'
      ? STATUS_ABERTOS
      : estado.situacao === 'encerrados'
        ? STATUS_ENCERRADOS
        : [...STATUS_ABERTOS, ...STATUS_ENCERRADOS];
  const opcoes = daSituacao.filter((s) => contadores.porStatus[s] > 0 || estado.status === s);
  if (estado.status && !opcoes.includes(estado.status)) opcoes.push(estado.status);

  return (
    <DropdownMenu>
      <GatilhoFiltro
        rotulo="Status"
        valor={estado.status ? ROTULO_STATUS_CHAMADO[estado.status] : undefined}
      />
      <DropdownMenuContent className="w-60">
        <DropdownMenuRadioGroup
          value={estado.status ?? 'qualquer'}
          onValueChange={(v: string) =>
            aoEscolher(v === 'qualquer' ? undefined : (v as StatusChamado))
          }
        >
          <DropdownMenuRadioItem value="qualquer" closeOnClick>
            Qualquer status
          </DropdownMenuRadioItem>
          {opcoes.length > 0 && <DropdownMenuSeparator />}
          {opcoes.map((s) => (
            <DropdownMenuRadioItem key={s} value={s} closeOnClick>
              <PontoStatus status={s} />
              {ROTULO_STATUS_CHAMADO[s]}
              <Contagem n={contadores.porStatus[s]} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FiltroPrioridade({
  estado,
  aoEscolher,
}: {
  estado: EstadoFila;
  aoEscolher: (p: Prioridade | undefined) => void;
}) {
  return (
    <DropdownMenu>
      <GatilhoFiltro
        rotulo="Prioridade"
        valor={estado.prioridade ? ROTULO_PRIORIDADE[estado.prioridade] : undefined}
      />
      <DropdownMenuContent className="w-52">
        <DropdownMenuRadioGroup
          value={estado.prioridade ?? 'qualquer'}
          onValueChange={(v: string) =>
            aoEscolher(v === 'qualquer' ? undefined : (v as Prioridade))
          }
        >
          <DropdownMenuRadioItem value="qualquer" closeOnClick>
            Qualquer prioridade
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {PRIORIDADES_DESC.map((p) => (
            <DropdownMenuRadioItem key={p} value={p} closeOnClick>
              <PontoPrioridade prioridade={p} />
              {ROTULO_PRIORIDADE[p]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ----------------------------------------------------------- Mais filtros

function MaisFiltros({
  estado,
  clientes,
  sistemas,
  categorias,
  aoAplicar,
}: {
  estado: EstadoFila;
  clientes: (Opcao & { email: string })[];
  sistemas: Opcao[];
  categorias: Opcao[];
  aoAplicar: (m: Partial<EstadoFila>) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const ativos = contarMaisFiltros(estado);
  const alvoAtual = estado.sistema
    ? `sistema:${estado.sistema}`
    : estado.categoria
      ? `categoria:${estado.categoria}`
      : '';

  function aplicar(form: HTMLFormElement) {
    const d = new FormData(form);
    const txt = (k: string) => String(d.get(k) ?? '').trim();
    const alvo = txt('alvo');
    const de = txt('de');
    const ate = txt('ate');
    const deOk = ehDataIso(de) ? de : undefined;
    const ateOk = ehDataIso(ate) ? ate : undefined;
    const [inicio, fim] = deOk && ateOk && deOk > ateOk ? [ateOk, deOk] : [deOk, ateOk];
    aoAplicar({
      natureza: (txt('natureza') || undefined) as Natureza | undefined,
      complexidade: (txt('complexidade') || undefined) as Complexidade | undefined,
      sistema: alvo.startsWith('sistema:') ? alvo.slice(8) : undefined,
      categoria: alvo.startsWith('categoria:') ? alvo.slice(10) : undefined,
      solicitante: ehUuid(txt('solicitante')) ? txt('solicitante') : undefined,
      estimativa: (txt('estimativa') || undefined) as EstadoFila['estimativa'],
      periodo:
        inicio || fim
          ? {
              campo: txt('periodo') === 'atualizado' ? 'atualizado' : 'criado',
              ...(inicio ? { de: inicio } : {}),
              ...(fim ? { ate: fim } : {}),
            }
          : undefined,
    });
    setAberto(false);
  }

  function limpar() {
    aoAplicar({
      natureza: undefined,
      complexidade: undefined,
      sistema: undefined,
      categoria: undefined,
      solicitante: undefined,
      estimativa: undefined,
      periodo: undefined,
    });
    setAberto(false);
  }

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger
        data-ativo={ativos > 0 ? 'true' : undefined}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'data-[ativo=true]:border-primary/40',
        )}
      >
        <SlidersHorizontal className="text-muted-foreground" aria-hidden />
        Mais filtros
        {ativos > 0 && (
          <span
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.7rem] leading-none font-semibold text-primary-foreground tabular-nums"
            aria-label={`${ativos} ${ativos === 1 ? 'filtro ativo' : 'filtros ativos'}`}
          >
            {ativos}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] gap-4 p-4">
        <PopoverHeader>
          <PopoverTitle>Mais filtros</PopoverTitle>
          <PopoverDescription>Classificação, pessoas, custo e datas.</PopoverDescription>
        </PopoverHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            aplicar(e.currentTarget);
          }}
          className="flex flex-col gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <Campo id="mf-natureza" rotulo="Natureza">
              <NativeSelect
                id="mf-natureza"
                name="natureza"
                defaultValue={estado.natureza ?? ''}
                className="w-full"
              >
                <option value="">Qualquer</option>
                {Object.values(Natureza).map((n) => (
                  <option key={n} value={n}>
                    {ROTULO_NATUREZA[n]}
                  </option>
                ))}
              </NativeSelect>
            </Campo>
            <Campo id="mf-complexidade" rotulo="Complexidade">
              <NativeSelect
                id="mf-complexidade"
                name="complexidade"
                defaultValue={estado.complexidade ?? ''}
                className="w-full"
              >
                <option value="">Qualquer</option>
                {Object.values(Complexidade).map((c) => (
                  <option key={c} value={c}>
                    {ROTULO_COMPLEXIDADE[c]}
                  </option>
                ))}
              </NativeSelect>
            </Campo>
          </div>

          {(sistemas.length > 0 || categorias.length > 0) && (
            <Campo id="mf-alvo" rotulo="Sistema ou categoria">
              <NativeSelect id="mf-alvo" name="alvo" defaultValue={alvoAtual} className="w-full">
                <option value="">Qualquer</option>
                {sistemas.length > 0 && (
                  <optgroup label="Sistemas">
                    {sistemas.map((s) => (
                      <option key={s.id} value={`sistema:${s.id}`}>
                        {s.nome}
                      </option>
                    ))}
                  </optgroup>
                )}
                {categorias.length > 0 && (
                  <optgroup label="Categorias">
                    {categorias.map((c) => (
                      <option key={c.id} value={`categoria:${c.id}`}>
                        {c.nome}
                      </option>
                    ))}
                  </optgroup>
                )}
              </NativeSelect>
            </Campo>
          )}

          <Campo id="mf-solicitante" rotulo="Solicitante">
            <NativeSelect
              id="mf-solicitante"
              name="solicitante"
              defaultValue={estado.solicitante ?? ''}
              className="w-full"
            >
              <option value="">Qualquer</option>
              {/* Solicitante já filtrado mas hoje inativo continua selecionável. */}
              {estado.solicitante && !clientes.some((c) => c.id === estado.solicitante) && (
                <option value={estado.solicitante}>Cliente inativo</option>
              )}
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome} — {c.email}
                </option>
              ))}
            </NativeSelect>
          </Campo>

          <Campo id="mf-estimativa" rotulo="Estimativa de custo">
            <NativeSelect
              id="mf-estimativa"
              name="estimativa"
              defaultValue={estado.estimativa ?? ''}
              className="w-full"
            >
              <option value="">Qualquer</option>
              <option value="sem_estimativa">{rotuloEstimativaFiltro('sem_estimativa')}</option>
              {ORDEM_ESTIMATIVA_CUSTO.map((e) => (
                <option key={e} value={e}>
                  {rotuloEstimativaFiltro(e)}
                </option>
              ))}
            </NativeSelect>
          </Campo>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Período</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,7.5rem)_1fr_1fr]">
              <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
                <Label htmlFor="mf-periodo" className="text-xs font-normal text-muted-foreground">
                  Data de
                </Label>
                <NativeSelect
                  id="mf-periodo"
                  name="periodo"
                  defaultValue={estado.periodo?.campo ?? 'criado'}
                  className="w-full"
                >
                  <option value="criado">Criação</option>
                  <option value="atualizado">Atualização</option>
                </NativeSelect>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor="mf-de" className="text-xs font-normal text-muted-foreground">
                  De
                </Label>
                <Input
                  id="mf-de"
                  type="date"
                  name="de"
                  defaultValue={estado.periodo?.de ?? ''}
                  className="min-w-0 px-2"
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor="mf-ate" className="text-xs font-normal text-muted-foreground">
                  Até
                </Label>
                <Input
                  id="mf-ate"
                  type="date"
                  name="ate"
                  defaultValue={estado.periodo?.ate ?? ''}
                  className="min-w-0 px-2"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              De/até inclusivos. Deixe um dos lados vazio para um intervalo aberto.
            </p>
          </fieldset>

          <Separator />
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={limpar} disabled={!ativos}>
              Limpar estes filtros
            </Button>
            <Button type="submit" size="sm">
              Aplicar filtros
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function Campo({
  id,
  rotulo,
  children,
}: {
  id: string;
  rotulo: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{rotulo}</Label>
      {children}
    </div>
  );
}

// -------------------------------------------------------------- Ordenação

function OrdenacaoCompacta({
  estado,
  buscaPorRelevancia,
  aoEscolher,
}: {
  estado: EstadoFila;
  buscaPorRelevancia: boolean;
  aoEscolher: (o: EstadoFila['ordem']) => void;
}) {
  const atual = ordemEfetiva(estado, buscaPorRelevancia);
  const valor = atual ? `${atual.campo}:${atual.direcao}` : 'relevancia';
  return (
    <div className="flex items-center gap-2 sm:ml-auto">
      <label htmlFor="fila-ordem" className="hidden text-xs text-muted-foreground sm:inline">
        Ordenar
      </label>
      <NativeSelect
        id="fila-ordem"
        size="sm"
        aria-label="Ordenar chamados"
        value={valor}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'relevancia') return aoEscolher(undefined);
          const [campo, direcao] = v.split(':') as [CampoOrdenacaoFila, 'asc' | 'desc'];
          aoEscolher({ campo, direcao });
        }}
      >
        {buscaPorRelevancia && <option value="relevancia">Relevância</option>}
        {CAMPOS_ORDENACAO.flatMap((c) =>
          (['desc', 'asc'] as const).map((d) => (
            <option key={`${c}:${d}`} value={`${c}:${d}`}>
              {descreverOrdem({ campo: c, direcao: d })}
            </option>
          )),
        )}
      </NativeSelect>
    </div>
  );
}

// ------------------------------------------------------------- Paginação

/** Tamanho de página (25/50/100) no rodapé da tabela. */
export function SeletorPorPagina({ estado }: { estado: EstadoFila }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="fila-por-pagina" className="text-xs text-muted-foreground">
        Por página
      </label>
      <NativeSelect
        id="fila-por-pagina"
        size="sm"
        value={String(estado.por)}
        onChange={(e) =>
          startTransition(() =>
            router.push(hrefFila(estado, { por: Number(e.target.value) as TamanhoPagina })),
          )
        }
      >
        {TAMANHOS_PAGINA.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
