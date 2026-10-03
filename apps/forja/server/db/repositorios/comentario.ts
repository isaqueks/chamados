import { In, IsNull, LessThanOrEqual } from 'typeorm';
import type { AlvoComentario } from '../../../comum/estados';
import { ComentarioSchema, type Comentario } from '../entidades/comentario';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `comentario` (specs/forja/02 §4.10). `pendentes` devolve o que
 * ainda não entrou num prompt T1 até o ciclo dado; `marcarConsumidos` é chamado
 * na mesma transação que registra o turno que os levou no stdin (F-03).
 */

export interface NovoComentario {
  execucao_id: string;
  artefato_id?: string | null;
  alvo: AlvoComentario;
  arquivo?: string | null;
  linha?: number | null;
  texto: string;
  ciclo_destino: number;
}

export class RepositorioComentarios extends RepositorioBase {
  async criar(dados: NovoComentario): Promise<Comentario> {
    const agora = this.agora();
    const linha: Comentario = {
      id: novoId(),
      execucao_id: dados.execucao_id,
      artefato_id: dados.artefato_id ?? null,
      alvo: dados.alvo,
      arquivo: dados.arquivo ?? null,
      linha: dados.linha ?? null,
      texto: dados.texto,
      ciclo_destino: dados.ciclo_destino,
      consumido_em: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ComentarioSchema, linha);
    return linha;
  }

  listar(execucaoId: string): Promise<Comentario[]> {
    return this.m.find(ComentarioSchema, {
      where: { execucao_id: execucaoId },
      order: { id: 'ASC' },
    });
  }

  pendentes(execucaoId: string, ateCiclo: number): Promise<Comentario[]> {
    return this.m.find(ComentarioSchema, {
      where: {
        execucao_id: execucaoId,
        consumido_em: IsNull(),
        ciclo_destino: LessThanOrEqual(ateCiclo),
      },
      order: { id: 'ASC' },
    });
  }

  async marcarConsumidos(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const agora = this.agora();
    await this.m.update(
      ComentarioSchema,
      { id: In(ids), consumido_em: IsNull() },
      { consumido_em: agora, atualizado_em: agora },
    );
  }
}
