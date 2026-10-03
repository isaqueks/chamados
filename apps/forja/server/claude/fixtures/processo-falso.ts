import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { FuncaoSpawn, OpcoesSpawn, ProcessoFilho } from '../runner';

/**
 * Apoio dos testes do runner: um `ChildProcess` falso (nenhum teste chama o
 * `claude` real) e a leitura das fixtures reais da CLI 2.1.288 gravadas na
 * pesquisa (`a.jsonl`: turno simples; `b.jsonl`: 4 turnos num processo com
 * custo acumulado; `c.jsonl`: subagente em background, dois `result` e
 * `structured_output` só no último).
 */

export function lerFixture(nome: 'a.jsonl' | 'b.jsonl' | 'c.jsonl' | 'agents.json'): string {
  return readFileSync(new URL(`./${nome}`, import.meta.url), 'utf8');
}

export class ProcessoFalso extends EventEmitter implements ProcessoFilho {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinRecebido: string[] = [];
  stdinFechado = false;
  readonly stdin = {
    write: (dado: string) => {
      this.stdinRecebido.push(dado);
      return true;
    },
    end: () => {
      this.stdinFechado = true;
    },
    on: () => this.stdin,
  };

  constructor(readonly pid: number | undefined = 4242) {
    super();
  }

  escrever(texto: string): void {
    this.stdout.emit('data', Buffer.from(texto, 'utf8'));
  }

  sair(codigo: number | null, sinal: NodeJS.Signals | null = null): void {
    this.emit('exit', codigo, sinal);
    this.emit('close', codigo, sinal);
  }
}

export interface SpawnFalso {
  spawn: FuncaoSpawn;
  chamadas: { executavel: string; args: string[]; opcoes: OpcoesSpawn }[];
  processos: ProcessoFalso[];
}

export function criarSpawnFalso(pid = 4242): SpawnFalso {
  const chamadas: SpawnFalso['chamadas'] = [];
  const processos: ProcessoFalso[] = [];
  return {
    chamadas,
    processos,
    spawn: (executavel, args, opcoes) => {
      chamadas.push({ executavel, args, opcoes });
      const p = new ProcessoFalso(pid + processos.length);
      processos.push(p);
      return p;
    },
  };
}
