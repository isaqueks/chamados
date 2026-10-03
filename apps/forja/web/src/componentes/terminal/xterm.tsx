import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { conectarTerminal, type EstadoTerminal } from '@/lib/terminal';
import { cn } from '@/lib/utils';
import { direcaoAtalho, rgbParaHex, temaTerminal } from './logica';

/**
 * `TerminalPty` (specs/forja/06 §4.7 e §7; protocolo em 01 §8.1/§11): xterm.js
 * ligado ao WebSocket `/api/terminal/:sessao`. Bytes do PTY chegam e sobem
 * CRUS (frames binários); controle vai como frame de texto JSON
 * (`redimensionar` sobe; `scrollback_inicio/fim` e `encerrado` descem).
 *
 * O protocolo do WS tem UMA implementação, `conectarTerminal` (lib/terminal.ts,
 * testada com socket falso); este componente só liga o xterm a ela e é o dono
 * do ciclo de vida (abrir, reanexar, redimensionar, fechar).
 *
 * - Reanexar após recarregar: o servidor reenvia o scrollback em anel entre
 *   `scrollback_inicio` e `scrollback_fim`; limpamos a tela antes para não
 *   duplicar [NV: S8 — plano B é o servidor encerrar com SIGINT e a aba
 *   oferecer [Reabrir] com `--resume`].
 * - Atalhos globais da Forja ficam desligados com o foco aqui; só
 *   `Ctrl+Shift+←/→` escapa do xterm para trocar de aba (06 §9).
 * - Tema derivado dos tokens e refeito quando a classe `.dark` muda.
 */

export type EstadoConexaoTerminal = EstadoTerminal;

export interface ControleXterm {
  /** Copia todo o buffer (plano B de acessibilidade, 06 §9). */
  copiarSaida(): Promise<boolean>;
  focar(): void;
  /** Abre um WebSocket novo para a mesma sessão (reanexa ao PTY vivo). */
  reconectar(): void;
}

let canvasCor: CanvasRenderingContext2D | null | undefined;

/** Token CSS (`--card`) → `#rrggbb`, pintando num canvas (o xterm não entende `oklch`). */
function resolverToken(token: string): string | null {
  const valor = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!valor) return null;
  if (canvasCor === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvasCor = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!canvasCor) return null;
  canvasCor.clearRect(0, 0, 1, 1);
  canvasCor.fillStyle = '#000000';
  canvasCor.fillStyle = valor;
  canvasCor.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = canvasCor.getImageData(0, 0, 1, 1).data;
  return rgbParaHex(r, g, b);
}

export function XtermPty({
  sessaoId,
  ativo,
  leitorTela,
  aoEstado,
  aoTrocarAba,
  controleRef,
  className,
}: {
  sessaoId: string;
  /** Aba visível: refaz o `fit` e devolve o foco. */
  ativo: boolean;
  leitorTela: boolean;
  aoEstado?: (
    estado: EstadoConexaoTerminal,
    detalhe?: { codigo: number | null; sinal: string | null },
  ) => void;
  aoTrocarAba?: (direcao: -1 | 1) => void;
  controleRef?: Ref<ControleXterm>;
  className?: string;
}) {
  const hospedeiro = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const aoEstadoRef = useRef(aoEstado);
  const aoTrocarAbaRef = useRef(aoTrocarAba);
  const [tentativa, setTentativa] = useState(0);
  aoEstadoRef.current = aoEstado;
  aoTrocarAbaRef.current = aoTrocarAba;

  useImperativeHandle(
    controleRef,
    () => ({
      async copiarSaida() {
        const t = terminalRef.current;
        if (!t) return false;
        t.selectAll();
        const texto = t.getSelection();
        t.clearSelection();
        try {
          await navigator.clipboard.writeText(texto);
          return true;
        } catch {
          return false;
        }
      },
      focar() {
        terminalRef.current?.focus();
      },
      reconectar() {
        setTentativa((t) => t + 1);
      },
    }),
    [],
  );

  useEffect(() => {
    const elemento = hospedeiro.current;
    if (!elemento) return;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
        'monospace',
      fontSize: 13,
      scrollback: 10_000,
      screenReaderMode: leitorTela,
      theme: temaTerminal(resolverToken),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(elemento);
    terminalRef.current = terminal;
    fitRef.current = fit;

    terminal.attachCustomKeyEventHandler((e) => {
      const d = direcaoAtalho(e);
      if (d === null) return true;
      if (e.type === 'keydown') aoTrocarAbaRef.current?.(d);
      return false;
    });

    const conexao = conectarTerminal(sessaoId, {
      aoBytes: (bytes) => terminal.write(bytes),
      aoControle: (controle) => {
        // Reanexar: o servidor reenvia o scrollback; limpar antes evita duplicar.
        if (controle.tipo === 'scrollback_inicio') terminal.reset();
      },
      aoEstado: (estado, detalhe) => {
        if (estado === 'conectado') {
          try {
            fit.fit();
          } catch {
            // elemento oculto (aba inativa): o fit roda quando a aba ficar visível
          }
          conexao.redimensionar(terminal.cols, terminal.rows);
        }
        aoEstadoRef.current?.(
          estado,
          detalhe ? { codigo: detalhe.codigo, sinal: detalhe.sinal } : undefined,
        );
      },
    });

    const dados = terminal.onData((d) => conexao.enviarTeclas(d));
    const binario = terminal.onBinary((d) => {
      const bytes = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i += 1) bytes[i] = d.charCodeAt(i) & 0xff;
      conexao.enviarBytes(bytes);
    });
    const redimensionou = terminal.onResize(({ cols, rows }) => conexao.redimensionar(cols, rows));

    const observador = new ResizeObserver(() => {
      if (elemento.offsetWidth === 0 || elemento.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // ignora: o terminal pode ter sido descartado entre o evento e o fit
      }
    });
    observador.observe(elemento);

    const observadorTema = new MutationObserver(() => {
      terminal.options.theme = temaTerminal(resolverToken);
    });
    observadorTema.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      observador.disconnect();
      observadorTema.disconnect();
      dados.dispose();
      binario.dispose();
      redimensionou.dispose();
      conexao.fechar();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // `leitorTela` entra só na criação; mudanças depois vão pelo efeito abaixo,
    // sem recriar a conexão.
  }, [sessaoId, tentativa]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.screenReaderMode = leitorTela;
  }, [leitorTela]);

  useEffect(() => {
    if (!ativo) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // ignora
      }
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [ativo]);

  return (
    <div className={cn('h-full w-full overflow-hidden rounded-lg border bg-card p-2', className)}>
      <div ref={hospedeiro} className="h-full w-full" role="application" aria-label="Terminal" />
    </div>
  );
}
