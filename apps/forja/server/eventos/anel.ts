/**
 * Estruturas de buffer dos eventos (specs/forja/01 §8.1). POR QUE um anel de
 * capacidade fixa e não um array com `shift()`: o leitor do stdout da CLI
 * publica milhares de eventos por etapa e nunca pode esperar ninguém; `shift`
 * é O(n) e um array sem teto cresce sem limite atrás de um cliente lento. O anel
 * tem custo O(1) por evento e memória limitada por construção.
 *
 * - `AnelLimitado<T>`: os últimos N itens, descartando o mais antigo.
 * - `FilaCliente<T>`: buffer em anel POR CLIENTE (SSE/WS). Escreve direto
 *   enquanto o socket aceita; acumula enquanto espera `drain`; se o anel
 *   encher, o cliente é lento demais → `aoEstourar` (o canal manda
 *   `sistema.recarregar` e desconecta). O publicador nunca bloqueia.
 */

export class AnelLimitado<T> {
  private readonly itens: (T | undefined)[];
  private inicio = 0;
  private tamanho = 0;

  constructor(readonly capacidade: number) {
    if (!Number.isInteger(capacidade) || capacidade < 1) {
      throw new RangeError(`capacidade inválida: ${capacidade}`);
    }
    this.itens = new Array<T | undefined>(capacidade);
  }

  get length(): number {
    return this.tamanho;
  }

  get cheio(): boolean {
    return this.tamanho === this.capacidade;
  }

  /** Acrescenta no fim; devolve o item descartado do início quando cheio. */
  push(item: T): T | undefined {
    if (this.tamanho < this.capacidade) {
      this.itens[(this.inicio + this.tamanho) % this.capacidade] = item;
      this.tamanho += 1;
      return undefined;
    }
    const descartado = this.itens[this.inicio];
    this.itens[this.inicio] = item;
    this.inicio = (this.inicio + 1) % this.capacidade;
    return descartado;
  }

  /** Remove e devolve o mais antigo. */
  shift(): T | undefined {
    if (this.tamanho === 0) return undefined;
    const item = this.itens[this.inicio];
    this.itens[this.inicio] = undefined;
    this.inicio = (this.inicio + 1) % this.capacidade;
    this.tamanho -= 1;
    return item;
  }

  primeiro(): T | undefined {
    return this.tamanho === 0 ? undefined : this.itens[this.inicio];
  }

  ultimo(): T | undefined {
    return this.tamanho === 0
      ? undefined
      : this.itens[(this.inicio + this.tamanho - 1) % this.capacidade];
  }

  limpar(): void {
    this.itens.fill(undefined);
    this.inicio = 0;
    this.tamanho = 0;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this.tamanho; i += 1) {
      yield this.itens[(this.inicio + i) % this.capacidade] as T;
    }
  }

  paraArray(): T[] {
    return [...this];
  }
}

/** Saída de um cliente: `write` devolve false quando o socket pede espera. */
export interface SaidaCliente<T> {
  escrever(item: T): boolean;
  aoDrenar(fn: () => void): void;
}

export class FilaCliente<T> {
  private readonly pendentes: AnelLimitado<T>;
  private esperandoDreno = false;
  private estourada = false;

  constructor(
    private readonly saida: SaidaCliente<T>,
    capacidade: number,
    private readonly aoEstourar: () => void,
  ) {
    this.pendentes = new AnelLimitado<T>(capacidade);
  }

  get emEspera(): number {
    return this.pendentes.length;
  }

  get estourou(): boolean {
    return this.estourada;
  }

  enviar(item: T): void {
    if (this.estourada) return;
    if (!this.esperandoDreno) {
      if (!this.saida.escrever(item)) this.aguardar();
      return;
    }
    if (this.pendentes.cheio) {
      this.estourada = true;
      this.pendentes.limpar();
      this.aoEstourar();
      return;
    }
    this.pendentes.push(item);
  }

  private aguardar(): void {
    this.esperandoDreno = true;
    this.saida.aoDrenar(() => this.drenar());
  }

  private drenar(): void {
    this.esperandoDreno = false;
    while (this.pendentes.length > 0 && !this.estourada) {
      if (!this.saida.escrever(this.pendentes.shift() as T)) {
        this.aguardar();
        return;
      }
    }
  }
}
