import { In, Not } from 'typeorm';
import type { EstadoLote } from '../../../comum/estados';
import { LoteSchema, type Lote } from '../entidades/lote';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/** Repositório de `lote` (specs/forja/02 §4.5; comportamento em 03 e F-14). */

export interface NovoLote {
  projeto_id: string;
  /** Default `Lote <data hora>` (hora local do processo). */
  nome?: string;
  concorrencia_planos: number;
  concorrencia_impl: number;
}

const ENCERRADOS: EstadoLote[] = ['encerrado', 'cancelado'];

function nomePadrao(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Lote ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class RepositorioLotes extends RepositorioBase {
  async criar(dados: NovoLote): Promise<Lote> {
    const agora = this.agora();
    const linha: Lote = {
      id: novoId(),
      projeto_id: dados.projeto_id,
      nome: dados.nome ?? nomePadrao(this.relogio()),
      estado: 'planejando',
      concorrencia_planos: dados.concorrencia_planos,
      concorrencia_impl: dados.concorrencia_impl,
      encerrado_em: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(LoteSchema, linha);
    return linha;
  }

  obter(id: string): Promise<Lote | null> {
    return this.obterPorId(LoteSchema, id);
  }

  exigir(id: string): Promise<Lote> {
    return this.exigirPorId(LoteSchema, id);
  }

  listar(filtro: { projeto_id?: string; ativos?: boolean } = {}): Promise<Lote[]> {
    return this.m.find(LoteSchema, {
      where: {
        ...(filtro.projeto_id ? { projeto_id: filtro.projeto_id } : {}),
        ...(filtro.ativos === undefined
          ? {}
          : { estado: filtro.ativos ? Not(In(ENCERRADOS)) : In(ENCERRADOS) }),
      },
      order: { criado_em: 'DESC' },
    });
  }

  async mudarEstado(id: string, estado: EstadoLote): Promise<Lote> {
    await this.atualizarPorId(LoteSchema, id, {
      estado,
      encerrado_em: ENCERRADOS.includes(estado) ? this.agora() : null,
    });
    return this.exigir(id);
  }
}
