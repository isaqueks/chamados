import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REDATOR_GENERICO, type Redator } from './normalizador';

/**
 * Gravador do stream BRUTO da CLI (specs/forja/01 §6.5, 02 §4.8 e §7):
 * `<dados>/execucoes/<execucao_id>/etapas/<n>/eventos.jsonl` (uma linha do
 * stdout por linha do arquivo) e `stderr.log` ao lado.
 *
 * POR QUE existe além do SQLite: o `evento` guarda o recorte enxuto; o
 * "Transcript bruto" da tela de Execução (06 §4.2) e qualquer auditoria futura
 * precisam da linha integral. `evento.linha_bruta` aponta para cá — por isso
 * `gravarLinha` devolve o número da linha (1-based).
 *
 * POR QUE escrita síncrona com `writeSync` em fd aberto: o append fica em
 * ordem com o INSERT do enxuto no mesmo tick (o número da linha é exato), e o
 * custo de um write local é desprezível perto do stream da CLI. Arquivos 0600,
 * diretórios 0700 (02 §7). Redigido antes de gravar (05 §8.2: `eventos.jsonl`
 * também nunca guarda segredo).
 */

export function dirEtapa(dirDados: string, execucaoId: string, n: number): string {
  if (!/^[0-9a-zA-Z-]+$/.test(execucaoId)) throw new Error(`execucao_id inválido: ${execucaoId}`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`n de etapa inválido: ${n}`);
  return join(dirDados, 'execucoes', execucaoId, 'etapas', String(n));
}

export function caminhoEventosBrutos(dirDados: string, execucaoId: string, n: number): string {
  return join(dirEtapa(dirDados, execucaoId, n), 'eventos.jsonl');
}

export function caminhoStderr(dirDados: string, execucaoId: string, n: number): string {
  return join(dirEtapa(dirDados, execucaoId, n), 'stderr.log');
}

/** Conta `\n` de um arquivo já existente (reabertura após retomada no mesmo `n`). */
function contarLinhas(fd: number): number {
  const tamanho = fstatSync(fd).size;
  if (tamanho === 0) return 0;
  const buf = Buffer.allocUnsafe(64 * 1024);
  let linhas = 0;
  let pos = 0;
  let ultimo = 0x0a;
  while (pos < tamanho) {
    const lidos = readSync(fd, buf, 0, buf.length, pos);
    if (lidos <= 0) break;
    for (let i = 0; i < lidos; i += 1) if (buf[i] === 0x0a) linhas += 1;
    ultimo = buf[lidos - 1]!;
    pos += lidos;
  }
  // Última linha sem `\n` final (crash no meio do write) conta como linha.
  return ultimo === 0x0a ? linhas : linhas + 1;
}

function abrirAppend(caminho: string): number {
  mkdirSync(dirname(caminho), { recursive: true, mode: 0o700 });
  return openSync(caminho, 'a+', 0o600);
}

export class GravadorEventosBrutos {
  private fd: number | null;
  private linhas: number;
  private terminaComQuebra: boolean;

  constructor(
    readonly caminho: string,
    private readonly redator: Redator = REDATOR_GENERICO,
  ) {
    this.fd = abrirAppend(caminho);
    this.linhas = contarLinhas(this.fd);
    this.terminaComQuebra = this.linhas === 0 || this.ultimoByteEhQuebra();
  }

  get totalLinhas(): number {
    return this.linhas;
  }

  /**
   * Acrescenta uma linha do stdout (sem o `\n`) e devolve o número dela.
   * Uma quebra interna (não deveria haver: o divisor corta em `\n`) vira `\n`
   * literal, para manter "uma linha = um registro".
   */
  gravarLinha(linha: string): number {
    if (this.fd === null) throw new Error(`gravador fechado: ${this.caminho}`);
    const limpa = this.redator.redigir(linha.replace(/\r?\n$/, '')).replace(/\r?\n/g, '\\n');
    const prefixo = this.terminaComQuebra ? '' : '\n';
    writeSync(this.fd, `${prefixo}${limpa}\n`);
    this.terminaComQuebra = true;
    this.linhas += 1;
    return this.linhas;
  }

  fechar(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  private ultimoByteEhQuebra(): boolean {
    const tamanho = fstatSync(this.fd!).size;
    const b = Buffer.alloc(1);
    readSync(this.fd!, b, 0, 1, tamanho - 1);
    return b[0] === 0x0a;
  }
}

/**
 * `stderr.log` da etapa: append cru (redigido por pedaço). Um segredo partido
 * entre dois pedaços pode escapar da redação por valor — limitação aceita; o
 * stderr da CLI raramente ecoa conteúdo de arquivo.
 */
export class GravadorStderr {
  private fd: number | null;

  constructor(
    readonly caminho: string,
    private readonly redator: Redator = REDATOR_GENERICO,
  ) {
    this.fd = abrirAppend(caminho);
  }

  gravar(pedaco: string | Buffer): void {
    if (this.fd === null) return;
    const texto = typeof pedaco === 'string' ? pedaco : pedaco.toString('utf8');
    writeSync(this.fd, this.redator.redigir(texto));
  }

  fechar(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

export interface GravadoresEtapa {
  eventos: GravadorEventosBrutos;
  stderr: GravadorStderr;
  fechar(): void;
}

export function abrirGravadoresEtapa(
  dirDados: string,
  execucaoId: string,
  n: number,
  redator: Redator = REDATOR_GENERICO,
): GravadoresEtapa {
  const eventos = new GravadorEventosBrutos(caminhoEventosBrutos(dirDados, execucaoId, n), redator);
  const stderr = new GravadorStderr(caminhoStderr(dirDados, execucaoId, n), redator);
  return {
    eventos,
    stderr,
    fechar() {
      eventos.fechar();
      stderr.fechar();
    },
  };
}
