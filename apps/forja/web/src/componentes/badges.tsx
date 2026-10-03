import { cva, type VariantProps } from 'class-variance-authority';
import {
  CheckIcon,
  CircleIcon,
  ClockIcon,
  DiamondIcon,
  KeyboardIcon,
  MinusIcon,
  MonitorIcon,
  PauseIcon,
  TriangleIcon,
  type LucideIcon,
} from 'lucide-react';
import { StatusChamado, Natureza, Prioridade, Complexidade } from '@chamados/shared';
import {
  GRUPO_ESTADO_EXECUCAO,
  type EstadoExecucao,
  type GrupoEstadoExecucao,
  type NivelVerificacao,
} from '@comum/estados';
import { cn } from '@/lib/utils';
import {
  ROTULO_STATUS_CHAMADO,
  ROTULO_NATUREZA,
  ROTULO_PRIORIDADE,
  ROTULO_COMPLEXIDADE,
  ROTULO_ESTADO_EXECUCAO,
  ROTULO_NIVEL_VERIFICACAO,
} from '@/lib/rotulos';

/**
 * Badges do domínio na Forja (specs/forja/06 §3). Duas partes:
 *
 * 1. **Espelhados do Chamados** (06 §3.1): cópia LITERAL de
 *    apps/web/src/components/chamado/badges.tsx — mesmas cores, rótulos e regra
 *    "todo badge tem texto; nenhuma distinção só por cor". Os enums vêm de
 *    `@chamados/shared`: status novo no Chamados quebra o typecheck aqui (proposital).
 * 2. **Novos da Forja** (06 §3.2): mesma `baseBadge`, tons da mesma família. O
 *    estado da execução usa ÍCONE no lugar do ponto, para se distinguir do
 *    status do chamado na mesma linha sem depender de cor.
 */

const baseBadge =
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap w-fit';

// ===========================================================================
// 1. Espelhados do Chamados (cópia literal)
// ===========================================================================

// --- Status -----------------------------------------------------------------

const statusBadge = cva(baseBadge, {
  variants: {
    tom: {
      sky: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
      violet:
        'border-transparent bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
      amber:
        'border-transparent bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      indigo:
        'border-transparent bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
      emerald:
        'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
      neutral: 'border-transparent bg-muted text-muted-foreground',
    },
  },
  defaultVariants: { tom: 'neutral' },
});

type Tom = NonNullable<VariantProps<typeof statusBadge>['tom']>;

const TOM_STATUS: Record<StatusChamado, Tom> = {
  [StatusChamado.novo]: 'sky',
  [StatusChamado.em_triagem]: 'violet',
  [StatusChamado.aguardando_cliente]: 'amber',
  [StatusChamado.em_atendimento]: 'indigo',
  [StatusChamado.resolvido]: 'emerald',
  [StatusChamado.fechado]: 'neutral',
  [StatusChamado.cancelado]: 'neutral',
};

const PONTO_STATUS: Record<Tom, string> = {
  sky: 'bg-sky-500',
  violet: 'bg-violet-500',
  amber: 'bg-amber-500',
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  neutral: 'bg-muted-foreground/50',
};

/** Ponto de cor de um status, para superfícies que já têm o rótulo em texto. */
export function PontoStatus({ status, className }: { status: StatusChamado; className?: string }) {
  return (
    <span
      className={cn('size-1.5 rounded-full', PONTO_STATUS[TOM_STATUS[status]], className)}
      aria-hidden
    />
  );
}

export function StatusBadge({ status, className }: { status: StatusChamado; className?: string }) {
  const tom = TOM_STATUS[status];
  return (
    <span className={cn(statusBadge({ tom }), className)}>
      <span className={cn('size-1.5 rounded-full', PONTO_STATUS[tom])} aria-hidden />
      {ROTULO_STATUS_CHAMADO[status]}
    </span>
  );
}

// --- Prioridade -------------------------------------------------------------

const prioridadeBadge = cva(baseBadge, {
  variants: {
    prioridade: {
      baixa: 'border-transparent bg-muted text-muted-foreground',
      media: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
      alta: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
      urgente: 'border-transparent bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    },
  },
  defaultVariants: { prioridade: 'media' },
});

const PONTO_PRIORIDADE: Record<Prioridade, string> = {
  [Prioridade.baixa]: 'bg-muted-foreground/40',
  [Prioridade.media]: 'bg-slate-400',
  [Prioridade.alta]: 'bg-amber-500',
  [Prioridade.urgente]: 'bg-red-500',
};

export function PrioridadeBadge({
  prioridade,
  className,
}: {
  prioridade: Prioridade;
  className?: string;
}) {
  return (
    <span className={cn(prioridadeBadge({ prioridade }), className)}>
      <span className={cn('size-1.5 rounded-full', PONTO_PRIORIDADE[prioridade])} aria-hidden />
      {ROTULO_PRIORIDADE[prioridade]}
    </span>
  );
}

// --- Complexidade (interna) -------------------------------------------------

const complexidadeBadge = cva(baseBadge, {
  variants: {
    complexidade: {
      facil:
        'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
      medio:
        'border-transparent bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      dificil: 'border-transparent bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
    },
  },
  defaultVariants: { complexidade: 'medio' },
});

export function ComplexidadeBadge({
  complexidade,
  className,
}: {
  complexidade: Complexidade;
  className?: string;
}) {
  return (
    <span className={cn(complexidadeBadge({ complexidade }), className)}>
      {ROTULO_COMPLEXIDADE[complexidade]}
    </span>
  );
}

// --- Natureza ---------------------------------------------------------------

export function NaturezaBadge({ natureza, className }: { natureza: Natureza; className?: string }) {
  return (
    <span className={cn(baseBadge, 'border-border text-foreground', className)}>
      {ROTULO_NATUREZA[natureza]}
    </span>
  );
}

// --- Nota interna -----------------------------------------------------------

/** Selo textual de nota interna (fundo âmbar — specs/08 §4.3). */
export function NotaInternaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        baseBadge,
        'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-300',
        className,
      )}
    >
      Nota interna
    </span>
  );
}

// ===========================================================================
// 2. Novos da Forja (06 §3.2)
// ===========================================================================

/** Tons da família dos badges existentes (-50/-700 no claro, -950/50 e -300 no escuro). */
const tomForja = cva(baseBadge, {
  variants: {
    tom: {
      neutral: 'border-transparent bg-muted text-muted-foreground',
      violet:
        'border-transparent bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
      amber:
        'border-transparent bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      rose: 'border-transparent bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
      sky: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
      emerald:
        'border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
    },
    contorno: {
      nenhum: '',
      rose: 'border-rose-300 dark:border-rose-800/60',
      amber: 'border-amber-300 dark:border-amber-800/60',
      sky: 'border-sky-300 dark:border-sky-800/60',
      neutro: 'border-border bg-transparent text-muted-foreground',
    },
  },
  defaultVariants: { tom: 'neutral', contorno: 'nenhum' },
});

type TomForja = NonNullable<VariantProps<typeof tomForja>['tom']>;

const VISUAL_GRUPO: Record<GrupoEstadoExecucao, { tom: TomForja; icone: LucideIcon }> = {
  esperando_recurso: { tom: 'neutral', icone: CircleIcon },
  trabalhando: { tom: 'violet', icone: CircleIcon },
  aguardando_voce: { tom: 'amber', icone: DiamondIcon },
  precisa_atencao: { tom: 'rose', icone: TriangleIcon },
  aguardando_terceiros: { tom: 'sky', icone: ClockIcon },
  pausado: { tom: 'neutral', icone: PauseIcon },
  com_voce: { tom: 'violet', icone: KeyboardIcon },
  concluido: { tom: 'emerald', icone: CheckIcon },
  encerrado: { tom: 'neutral', icone: MinusIcon },
};

/**
 * Estado da `execucao` (06 §3.2). Rótulo legível sempre; o identificador cru
 * fica no `title`. "Trabalhando" pulsa (parado com `prefers-reduced-motion`,
 * pela regra global de globals.css).
 */
export function EstadoExecucaoBadge({
  estado,
  className,
}: {
  estado: EstadoExecucao;
  className?: string;
}) {
  const grupo = GRUPO_ESTADO_EXECUCAO[estado];
  const { tom, icone: Icone } = VISUAL_GRUPO[grupo];
  const preenchido =
    grupo === 'trabalhando' || grupo === 'aguardando_voce' || grupo === 'precisa_atencao';
  return (
    <span className={cn(tomForja({ tom }), className)} title={estado}>
      <Icone
        className={cn(
          'size-3',
          preenchido && 'fill-current',
          grupo === 'trabalhando' && 'animate-pulse',
        )}
        aria-hidden
      />
      {ROTULO_ESTADO_EXECUCAO[estado]}
    </span>
  );
}

const TOM_NIVEL: Record<NivelVerificacao, TomForja> = {
  verificado_pelo_revisor: 'emerald',
  declarado: 'amber',
  nao_verificado: 'rose',
  e2e_automatizado: 'emerald',
  e2e_roteiro: 'emerald',
  verificacao_estatica: 'amber',
};

/** Nível de verificação ⚙ — nunca arredondado para cima, nunca "testado" sem qualificar. */
export function NivelVerificacaoBadge({
  nivel,
  className,
}: {
  nivel: NivelVerificacao;
  className?: string;
}) {
  return (
    <span
      className={cn(tomForja({ tom: TOM_NIVEL[nivel] }), className)}
      title="Calculado pela Forja: comandos relatados pelo revisor conferidos no stream do agente"
    >
      {ROTULO_NIVEL_VERIFICACAO[nivel]}
    </span>
  );
}

const TITULO_SELO = 'Calculado pela Forja a partir do diff';

/** Selos ⚙ do relatório (06 §3.2): texto em caixa alta, nunca só cor. */
export function SeloBanco({ altera, className }: { altera: boolean; className?: string }) {
  return (
    <span
      className={cn(
        altera ? tomForja({ tom: 'rose', contorno: 'rose' }) : tomForja({ contorno: 'neutro' }),
        'uppercase',
        className,
      )}
      title={TITULO_SELO}
    >
      {altera ? 'Altera o banco' : 'Não altera o banco'}
    </span>
  );
}

export function SeloRegraNegocio({ altera, className }: { altera: boolean; className?: string }) {
  return (
    <span
      className={cn(
        altera ? tomForja({ tom: 'amber', contorno: 'amber' }) : tomForja({ contorno: 'neutro' }),
        'uppercase',
        className,
      )}
      title={TITULO_SELO}
    >
      {altera ? 'Altera regra de negócio' : 'Não altera regra de negócio'}
    </span>
  );
}

export function SeloInterface({ telas, className }: { telas: number; className?: string }) {
  const altera = telas > 0;
  return (
    <span
      className={cn(
        altera ? tomForja({ tom: 'sky', contorno: 'sky' }) : tomForja({ contorno: 'neutro' }),
        'uppercase',
        className,
      )}
      title={TITULO_SELO}
    >
      {altera ? `UI · ${telas} ${telas === 1 ? 'tela' : 'telas'}` : 'Não altera a interface'}
    </span>
  );
}

export function SeloSensiveis({
  quantidade,
  className,
}: {
  quantidade: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        quantidade > 0 ? tomForja({ tom: 'rose' }) : tomForja({ contorno: 'neutro' }),
        'uppercase',
        className,
      )}
      title={TITULO_SELO}
    >
      {quantidade} {quantidade === 1 ? 'arquivo sensível' : 'arquivos sensíveis'}
    </span>
  );
}

export function SeloDocsExigidas({ ok, className }: { ok: boolean; className?: string }) {
  return (
    <span
      className={cn(tomForja({ tom: ok ? 'emerald' : 'rose' }), 'uppercase', className)}
      title={TITULO_SELO}
    >
      Docs exigidas {ok ? '✓' : '✗'}
    </span>
  );
}

/**
 * Badge `UI` (FJ-026): ao lado do estado quando o selo `altera_ui` liga. Sem
 * prints, o ícone fica âmbar e o tooltip traz o motivo.
 */
export function BadgeUi({
  telas,
  semPrintsMotivo,
  className,
}: {
  telas: number;
  semPrintsMotivo?: string | null;
  className?: string;
}) {
  const titulo = semPrintsMotivo
    ? `muda a interface: sem prints (${semPrintsMotivo})`
    : `muda a interface: prints antes/depois em ${telas} ${telas === 1 ? 'tela' : 'telas'}`;
  return (
    <span
      className={cn(tomForja({ tom: 'sky', contorno: 'sky' }), 'bg-transparent', className)}
      title={titulo}
    >
      <MonitorIcon
        className={cn('size-3', semPrintsMotivo && 'text-amber-600 dark:text-amber-400')}
        aria-hidden
      />
      UI
    </span>
  );
}

export type Sinal = 'spec' | 'pr_ia' | 'ia_ativa' | 'ia_silenciada' | 'cliente_respondeu';

const VISUAL_SINAL: Record<Sinal, { rotulo: string; classe: string; titulo: string }> = {
  spec: {
    rotulo: 'SPEC ✓',
    classe: tomForja({ contorno: 'neutro' }),
    titulo: 'A IA do servidor deixou SPEC/diagnóstico',
  },
  pr_ia: {
    rotulo: 'PR IA ⚠',
    classe: tomForja({ tom: 'amber' }),
    titulo: 'Existe branch ia/chamado-N-* da IA do servidor',
  },
  // Informativos (FJ-031): a IA do servidor não é pré-condição nem bloqueio.
  ia_ativa: {
    rotulo: 'IA ativa',
    classe: tomForja({ contorno: 'neutro' }),
    titulo: 'IA do servidor ativa — triagem do servidor; não interfere na Forja',
  },
  ia_silenciada: {
    rotulo: 'IA silenciada',
    classe: tomForja({ contorno: 'neutro' }),
    titulo: 'IA do servidor silenciada — triagem do servidor; não interfere na Forja',
  },
  cliente_respondeu: {
    rotulo: 'cliente respondeu',
    classe: tomForja({ tom: 'sky' }),
    titulo: 'Mensagem nova do cliente',
  },
};

/** Sinais da fila (06 §3.2). */
export function SinalFila({ sinal, className }: { sinal: Sinal; className?: string }) {
  const v = VISUAL_SINAL[sinal];
  return (
    <span className={cn(v.classe, className)} title={v.titulo}>
      {v.rotulo}
    </span>
  );
}
