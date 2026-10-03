import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CopyIcon,
  KeyboardIcon,
  PlusIcon,
  RotateCwIcon,
  SquareTerminalIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import type { SessaoTerminalDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Switch } from '@/ui/switch';
import { useProjetoAtual } from '@/componentes/shell/projeto-atual';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import { Carregando, ErroCarregar, Vazio } from '@/componentes/apoio/estrutura-tela';
import { shaCurto } from '@/componentes/apoio/texto';
import { descreverSaida, indiceVizinho, ordenarSessoes } from '@/componentes/terminal/logica';
import { DialogoNovoChat } from '@/componentes/terminal/novo-chat';
import {
  XtermPty,
  type ControleXterm,
  type EstadoConexaoTerminal,
} from '@/componentes/terminal/xterm';

/**
 * Terminal (specs/forja/06 §4.7, fluxo §5.6; PTY em 01 §11, F-13, F-17).
 *
 * Abas de PTY: **chat livre** (o "Claude normal" do usuário, fora do
 * pipeline) e **sessão assumida** (`claude --resume` com o perfil da etapa,
 * com lock — "Devolver ao pipeline" commita e segue para verificação +
 * revisão: o trabalho humano também é revisado). A aba ativa vive na URL
 * (`/terminal?sessao=<id>`), que é para onde a Execução navega depois de
 * "Assumir".
 *
 * Cada aba viva mantém o seu xterm montado (escondido quando inativa) para
 * trocar de aba sem reconectar. Fechar uma aba assumida pergunta "Devolver
 * agora / Manter assumida"; manter encerra só o processo — o lock continua
 * até devolver, e [Reabrir] faz `--resume` da mesma sessão.
 */

const CHAVE = ['terminal'];

interface EstadoAba {
  conexao: EstadoConexaoTerminal;
  saida?: { codigo: number | null; sinal: string | null };
}

export function TelaTerminal() {
  const { projetoId } = useProjetoAtual();
  const [params, setParams] = useSearchParams();
  const [estados, setEstados] = useState<Record<string, EstadoAba>>({});
  const [ocultas, setOcultas] = useState<Set<string>>(new Set());
  const [leitorTela, setLeitorTela] = useState(false);
  const [novoChat, setNovoChat] = useState(false);
  const [fechando, setFechando] = useState<SessaoTerminalDto | null>(null);
  const [devolvendo, setDevolvendo] = useState<SessaoTerminalDto | null>(null);
  const controles = useRef<Record<string, ControleXterm | null>>({});

  const consulta = useQuery({
    queryKey: CHAVE,
    queryFn: ({ signal }) => api('terminal_sessoes', { sinal: signal }),
    refetchInterval: 10_000,
  });

  const sessoes = useMemo(
    () => ordenarSessoes((consulta.data?.sessoes ?? []).filter((s) => !ocultas.has(s.id))),
    [consulta.data, ocultas],
  );
  const vivas = (consulta.data?.sessoes ?? []).filter((s) => s.viva).length;
  const limite = consulta.data?.limite ?? 4;
  const pedida = params.get('sessao');
  const ativa = sessoes.find((s) => s.id === pedida) ?? sessoes[0] ?? null;

  const ativar = useCallback(
    (id: string) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.set('sessao', id);
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );

  const trocarAba = useCallback(
    (direcao: -1 | 1) => {
      const i = sessoes.findIndex((s) => s.id === ativa?.id);
      const alvo = sessoes[indiceVizinho(i, sessoes.length, direcao)];
      if (alvo) ativar(alvo.id);
    },
    [sessoes, ativa, ativar],
  );

  // Ctrl+Shift+←/→ também fora do xterm (foco na barra de abas).
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        trocarAba(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [trocarAba]);

  const atualizarEstado = useCallback(
    (id: string, conexao: EstadoConexaoTerminal, saida?: EstadoAba['saida']) => {
      setEstados((e) => ({ ...e, [id]: { conexao, saida } }));
      if (conexao === 'encerrado') void consulta.refetch();
    },
    [consulta],
  );

  const encerrar = useComando({
    executar: (id: string) => api('terminal_encerrar', { params: { id } }),
    invalidar: [CHAVE],
    aoSucesso: () => setFechando(null),
  });
  const reabrir = useComando({
    executar: (id: string) => api('terminal_reabrir', { params: { id } }),
    invalidar: [CHAVE],
    aoSucesso: (r, id) => {
      setEstados((e) => {
        const n = { ...e };
        delete n[id];
        return n;
      });
      ativar(r.sessao_id);
    },
  });
  const devolver = useComando({
    executar: (execucaoId: string) => api('execucao_devolver', { params: { id: execucaoId } }),
    invalidar: [CHAVE, ['execucao']],
    sucesso: 'Devolvido ao pipeline: o app commita e segue para verificação e revisão',
    aoSucesso: () => {
      setDevolvendo(null);
      setFechando(null);
    },
  });

  function pedirFechar(s: SessaoTerminalDto) {
    if (!s.viva && s.tipo === 'livre') {
      setOcultas((o) => new Set(o).add(s.id));
      return;
    }
    setFechando(s);
  }

  async function copiar(texto: string, rotulo: string) {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(`${rotulo} copiado`);
    } catch {
      toast.error('Não foi possível copiar (permissão da área de transferência).');
    }
  }

  if (consulta.isPending) {
    return (
      <div className="p-6">
        <Carregando linhas={3} />
      </div>
    );
  }
  if (consulta.isError) {
    return (
      <div className="p-6">
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      </div>
    );
  }

  const estadoAtiva = ativa ? estados[ativa.id] : undefined;
  const ativaEncerrada = !!ativa && (!ativa.viva || estadoAtiva?.conexao === 'encerrado');

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Sessões de terminal"
          className="flex min-w-0 flex-1 flex-wrap gap-1"
        >
          {sessoes.map((s) => {
            const selecionada = s.id === ativa?.id;
            return (
              <div
                key={s.id}
                className={cn(
                  'flex items-center rounded-lg border text-sm',
                  selecionada
                    ? 'border-ring bg-card shadow-campo'
                    : 'border-transparent hover:bg-muted',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selecionada}
                  onClick={() => ativar(s.id)}
                  className="flex items-center gap-1.5 py-1 pr-1 pl-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {s.tipo === 'assumida' ? (
                    <KeyboardIcon
                      className="size-3.5 text-violet-700 dark:text-violet-300"
                      aria-hidden
                    />
                  ) : (
                    <SquareTerminalIcon className="size-3.5 text-muted-foreground" aria-hidden />
                  )}
                  <span className="max-w-56 truncate">{s.titulo}</span>
                  <span
                    role="img"
                    className={cn(
                      'size-1.5 rounded-full',
                      s.viva ? 'bg-emerald-500' : 'bg-muted-foreground/50',
                    )}
                    aria-label={s.viva ? 'vivo' : 'encerrado'}
                  />
                  {!s.viva && (
                    <span className="text-xs text-muted-foreground" aria-hidden>
                      encerrado
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => pedirFechar(s)}
                  aria-label={`Fechar ${s.titulo}`}
                  className="mr-1 rounded p-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {vivas}/{limite} abertos
        </span>
        <Button
          size="sm"
          onClick={() => setNovoChat(true)}
          disabled={vivas >= limite}
          title={vivas >= limite ? `Limite de ${limite} terminais simultâneos` : undefined}
        >
          <PlusIcon aria-hidden />
          Novo chat
        </Button>
      </div>

      {!ativa ? (
        <div className="mx-auto w-full max-w-3xl pt-6">
          <Vazio
            icone={SquareTerminalIcon}
            titulo="Nenhum terminal aberto."
            descricao="Abra um chat com o Claude no repositório."
            acao={
              <Button size="sm" onClick={() => setNovoChat(true)}>
                Novo chat no repo
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2 text-xs">
            <span className="font-mono text-muted-foreground" title={ativa.cwd}>
              {ativa.cwd}
            </span>
            {ativa.session_id_claude && (
              <button
                type="button"
                onClick={() => void copiar(ativa.session_id_claude ?? '', 'session_id')}
                className="flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground"
                title="Copiar session_id"
              >
                sessão {shaCurto(ativa.session_id_claude, 8)}…
                <CopyIcon className="size-3" aria-hidden />
              </button>
            )}
            <span
              className={cn(
                'font-medium',
                ativaEncerrada
                  ? 'text-muted-foreground'
                  : estadoAtiva?.conexao === 'desconectado'
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-emerald-700 dark:text-emerald-400',
              )}
            >
              {ativaEncerrada
                ? estadoAtiva?.saida
                  ? descreverSaida(estadoAtiva.saida)
                  : 'encerrado'
                : estadoAtiva?.conexao === 'desconectado'
                  ? 'desconectado'
                  : estadoAtiva?.conexao === 'conectando'
                    ? 'conectando…'
                    : 'vivo'}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <Switch size="sm" checked={leitorTela} onCheckedChange={setLeitorTela} />
                leitor de tela
              </label>
              {!ativaEncerrada && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={async () => {
                    const ok = await controles.current[ativa.id]?.copiarSaida();
                    if (ok) toast.success('Saída copiada');
                    else toast.error('Não foi possível copiar a saída.');
                  }}
                >
                  <CopyIcon aria-hidden />
                  Copiar saída
                </Button>
              )}
              {estadoAtiva?.conexao === 'desconectado' && !ativaEncerrada && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => controles.current[ativa.id]?.reconectar()}
                >
                  <RotateCwIcon aria-hidden />
                  Reconectar
                </Button>
              )}
              {ativaEncerrada && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={reabrir.isPending}
                  onClick={() => reabrir.mutate(ativa.id)}
                >
                  <RotateCwIcon aria-hidden />
                  Reabrir
                </Button>
              )}
              {ativa.tipo === 'assumida' && ativa.execucao_id && (
                <Button size="xs" onClick={() => setDevolvendo(ativa)}>
                  <Undo2Icon aria-hidden />
                  Devolver ao pipeline
                </Button>
              )}
            </div>
          </div>

          <div className="relative min-h-80 flex-1">
            {sessoes
              .filter((s) => s.viva)
              .map((s) => (
                <div
                  key={s.id}
                  className={cn('absolute inset-0', s.id !== ativa.id && 'invisible')}
                  aria-hidden={s.id !== ativa.id}
                >
                  <XtermPty
                    sessaoId={s.id}
                    ativo={s.id === ativa.id}
                    leitorTela={leitorTela}
                    aoEstado={(e, saida) => atualizarEstado(s.id, e, saida)}
                    aoTrocarAba={trocarAba}
                    controleRef={(c) => {
                      controles.current[s.id] = c;
                    }}
                  />
                </div>
              ))}
            {ativaEncerrada && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg border bg-card/90">
                <div className="flex flex-col items-center gap-3 text-center text-sm">
                  <p className="text-muted-foreground">
                    O processo saiu
                    {estadoAtiva?.saida ? ` (${descreverSaida(estadoAtiva.saida)})` : ''}.
                    {ativa.tipo === 'assumida'
                      ? ' A sessão continua assumida até você devolver.'
                      : ''}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={reabrir.isPending}
                    onClick={() => reabrir.mutate(ativa.id)}
                  >
                    <RotateCwIcon aria-hidden />
                    Reabrir{ativa.session_id_claude ? ' (retoma a mesma conversa)' : ''}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <DialogoNovoChat
        aberto={novoChat}
        aoMudarAberto={setNovoChat}
        projetoInicial={projetoId}
        aoAbrir={ativar}
      />

      {/* Fechar: livre viva → encerrar; assumida → Devolver agora / Manter assumida. */}
      <Dialog open={fechando !== null} onOpenChange={(v) => !v && setFechando(null)}>
        <DialogContent>
          {fechando?.tipo === 'assumida' ? (
            <>
              <DialogHeader>
                <DialogTitle>Fechar a sessão assumida?</DialogTitle>
                <DialogDescription>
                  Devolver agora: o app commita o que está no disco e segue para verificação e
                  revisão. Manter assumida: o processo é encerrado, a sessão continua com você e
                  [Reabrir] retoma a mesma conversa depois.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setFechando(null)}>
                  Cancelar
                </Button>
                <Button
                  variant="outline"
                  disabled={encerrar.isPending || !fechando.viva}
                  onClick={() => encerrar.mutate(fechando.id)}
                >
                  Manter assumida
                </Button>
                <Button
                  disabled={devolver.isPending || !fechando.execucao_id}
                  onClick={() => fechando.execucao_id && devolver.mutate(fechando.execucao_id)}
                >
                  Devolver agora
                </Button>
              </DialogFooter>
            </>
          ) : fechando ? (
            <>
              <DialogHeader>
                <DialogTitle>Encerrar este chat?</DialogTitle>
                <DialogDescription>
                  O processo do claude em {fechando.cwd} é encerrado. A conversa fica no histórico
                  da CLI.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setFechando(null)}>
                  Cancelar
                </Button>
                <Button
                  variant="destructive"
                  disabled={encerrar.isPending}
                  onClick={() =>
                    encerrar.mutate(fechando.id, {
                      onSuccess: () => setOcultas((o) => new Set(o).add(fechando.id)),
                    })
                  }
                >
                  Encerrar
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <DialogoConfirmacao
        aberto={devolvendo !== null}
        aoMudarAberto={(v) => !v && setDevolvendo(null)}
        titulo={`Devolver ${devolvendo?.numero ? `#${devolvendo.numero}` : 'a sessão'} ao pipeline?`}
        descricao="O app encerra a TUI, commita o que está no disco e segue para verificação e revisão. O trabalho manual passa pelo mesmo gate de aprovação."
        rotuloConfirmar="Devolver ao pipeline"
        pendente={devolver.isPending}
        aoConfirmar={() => devolvendo?.execucao_id && devolver.mutate(devolvendo.execucao_id)}
      />
    </div>
  );
}
