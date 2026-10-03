import { useId, type ReactNode } from 'react';
import { AlertTriangleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

/**
 * Peças de formulário das telas de apoio (Projeto, Conexão, filtros), só com
 * os primitivos de `web/src/ui` (D-009). `Campo` padroniza rótulo, ajuda, erro
 * (vermelho, bloqueia o salvar) e aviso de faixa (âmbar, só explica — 06 §4.8
 * "valores fora da faixa ficam âmbar com explicação").
 */

export function Campo({
  rotulo,
  ajuda,
  erro,
  aviso,
  children,
  className,
  id,
}: {
  rotulo: ReactNode;
  ajuda?: ReactNode;
  erro?: string | null;
  aviso?: string | null;
  /** Recebe o id que o rótulo aponta. */
  children: (id: string) => ReactNode;
  className?: string;
  id?: string;
}) {
  const gerado = useId();
  const idCampo = id ?? gerado;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={idCampo}>{rotulo}</Label>
      {children(idCampo)}
      {erro ? (
        <p className="text-xs text-destructive" role="alert">
          {erro}
        </p>
      ) : aviso ? (
        <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangleIcon className="mt-px size-3 shrink-0" aria-hidden />
          {aviso}
        </p>
      ) : ajuda ? (
        <p className="text-xs text-muted-foreground">{ajuda}</p>
      ) : null}
    </div>
  );
}

export interface OpcaoSelect<V extends string> {
  valor: V;
  rotulo: string;
  desabilitada?: boolean;
}

/** Select com rótulo legível (o `SelectValue` do Base UI mostra o rótulo via `items`). */
export function CampoSelect<V extends string>({
  id,
  valor,
  opcoes,
  aoMudar,
  placeholder,
  invalido,
  className,
  rotuloAcessivel,
  desabilitado,
}: {
  id?: string;
  valor: V | null;
  opcoes: OpcaoSelect<V>[];
  aoMudar: (valor: V) => void;
  placeholder?: string;
  invalido?: boolean;
  className?: string;
  rotuloAcessivel?: string;
  desabilitado?: boolean;
}) {
  return (
    <Select
      value={valor}
      items={opcoes.map((o) => ({ value: o.valor, label: o.rotulo }))}
      onValueChange={(v) => {
        if (v !== null) aoMudar(v as V);
      }}
      disabled={desabilitado}
    >
      <SelectTrigger
        id={id}
        className={cn('w-full', className)}
        aria-invalid={invalido || undefined}
        aria-label={rotuloAcessivel}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {opcoes.map((o) => (
          <SelectItem key={o.valor} value={o.valor} disabled={o.desabilitada}>
            {o.rotulo}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Caixa de seleção com rótulo e descrição opcional — o mesmo `ui/checkbox` da
 * `CaixaMarcacao` (D-009: um só checkbox no design system).
 */
export function Caixa({
  marcada,
  aoMudar,
  rotulo,
  descricao,
  desabilitada,
  className,
  rotuloAcessivel,
}: {
  marcada: boolean;
  aoMudar: (marcada: boolean) => void;
  rotulo?: ReactNode;
  descricao?: ReactNode;
  desabilitada?: boolean;
  className?: string;
  rotuloAcessivel?: string;
}) {
  const caixa = (
    <Checkbox
      checked={marcada}
      disabled={desabilitada}
      onCheckedChange={(v) => aoMudar(v)}
      aria-label={rotulo ? undefined : rotuloAcessivel}
      className="mt-0.5"
    />
  );
  if (!rotulo) return caixa;
  return (
    <label className={cn('flex items-start gap-2', desabilitada && 'opacity-60', className)}>
      {caixa}
      <span className="flex flex-col gap-0.5 text-sm leading-snug">
        <span>{rotulo}</span>
        {descricao && <span className="text-xs text-muted-foreground">{descricao}</span>}
      </span>
    </label>
  );
}

/** Grupo de opções exclusivas (radio nativo) com a frase de consequência de cada uma (06 §4.8). */
export function GrupoOpcoes<V extends string>({
  nome,
  valor,
  opcoes,
  aoMudar,
}: {
  nome: string;
  valor: V;
  opcoes: { valor: V; rotulo: string; consequencia: string; desabilitada?: boolean }[];
  aoMudar: (valor: V) => void;
}) {
  const base = useId();
  return (
    <div role="radiogroup" className="flex flex-col gap-2">
      {opcoes.map((o) => {
        const id = `${base}-${o.valor}`;
        return (
          <div
            key={o.valor}
            className={cn('flex items-start gap-2', o.desabilitada && 'opacity-60')}
          >
            <input
              id={id}
              type="radio"
              name={`${base}-${nome}`}
              checked={valor === o.valor}
              disabled={o.desabilitada}
              onChange={() => aoMudar(o.valor)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <label htmlFor={id} className="flex flex-col gap-0.5 text-sm leading-snug">
              <span className="font-medium">{o.rotulo}</span>
              <span className="text-xs text-muted-foreground">{o.consequencia}</span>
            </label>
          </div>
        );
      })}
    </div>
  );
}
