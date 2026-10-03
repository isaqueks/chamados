import type { StatusChamado } from '@chamados/shared';
import { In } from 'typeorm';
import { ChamadoCacheSchema, type ChamadoCache } from '../entidades/chamado-cache';
import { novoId } from '../ids';
import { SINAIS_VAZIOS, type SinaisCache } from '../json';
import { RepositorioBase } from './base';

/**
 * Repositório de `chamado_cache` (specs/forja/02 §4.4). O cache é ESPELHO da
 * API: `gravarDaLista` faz upsert pela chave remota `(conexao_id, chamado_id)`
 * mantendo o `id` local (FK das execuções) e preservando o que só o detalhe
 * informa (sinais, `ia_silenciada`, última mensagem) quando a lista não traz.
 */

type Opcionais =
  | 'complexidade'
  | 'sistema_alvo_id'
  | 'sistema_nome'
  | 'operador_id'
  | 'ia_silenciada'
  | 'ultima_mensagem_id'
  | 'ultima_mensagem_em'
  | 'atualizado_em_remoto';

/** O que uma linha da LISTA da API traz. Ausente (`undefined`) = mantém o valor já gravado. */
export type DadosListaChamado = Pick<
  ChamadoCache,
  'conexao_id' | 'chamado_id' | 'numero' | 'titulo' | 'status' | 'natureza' | 'prioridade'
> &
  Partial<Pick<ChamadoCache, Opcionais>>;

/** O que a leitura do DETALHE acrescenta (sinais são lazy, 02 §4.4). */
export interface DadosDetalheChamado {
  sinais: SinaisCache;
  ia_silenciada?: boolean | null;
  ultima_mensagem_id?: string | null;
  ultima_mensagem_em?: string | null;
}

function semIndefinidos<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class RepositorioChamadosCache extends RepositorioBase {
  async gravarDaLista(dados: DadosListaChamado): Promise<ChamadoCache> {
    const agora = this.agora();
    const existente = await this.obterPorChamado(dados.conexao_id, dados.chamado_id);
    if (existente) {
      await this.atualizarPorId(ChamadoCacheSchema, existente.id, {
        ...semIndefinidos(dados),
        sincronizado_em: agora,
      });
      return this.exigir(existente.id);
    }
    const linha: ChamadoCache = {
      id: novoId(),
      conexao_id: dados.conexao_id,
      chamado_id: dados.chamado_id,
      numero: dados.numero,
      titulo: dados.titulo,
      status: dados.status,
      natureza: dados.natureza,
      prioridade: dados.prioridade,
      complexidade: dados.complexidade ?? null,
      sistema_alvo_id: dados.sistema_alvo_id ?? null,
      sistema_nome: dados.sistema_nome ?? null,
      operador_id: dados.operador_id ?? null,
      ia_silenciada: dados.ia_silenciada ?? null,
      ultima_mensagem_id: dados.ultima_mensagem_id ?? null,
      ultima_mensagem_em: dados.ultima_mensagem_em ?? null,
      sinais: SINAIS_VAZIOS,
      atualizado_em_remoto: dados.atualizado_em_remoto ?? null,
      sincronizado_em: agora,
      detalhe_sincronizado_em: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ChamadoCacheSchema, linha);
    return linha;
  }

  async gravarDetalhe(id: string, detalhe: DadosDetalheChamado): Promise<ChamadoCache> {
    const agora = this.agora();
    await this.atualizarPorId(ChamadoCacheSchema, id, {
      ...semIndefinidos(detalhe),
      detalhe_sincronizado_em: agora,
      sincronizado_em: agora,
    });
    return this.exigir(id);
  }

  obter(id: string): Promise<ChamadoCache | null> {
    return this.obterPorId(ChamadoCacheSchema, id);
  }

  exigir(id: string): Promise<ChamadoCache> {
    return this.exigirPorId(ChamadoCacheSchema, id);
  }

  obterPorChamado(conexaoId: string, chamadoId: string): Promise<ChamadoCache | null> {
    return this.m.findOne(ChamadoCacheSchema, {
      where: { conexao_id: conexaoId, chamado_id: chamadoId },
    });
  }

  obterPorNumero(conexaoId: string, numero: number): Promise<ChamadoCache | null> {
    return this.m.findOne(ChamadoCacheSchema, { where: { conexao_id: conexaoId, numero } });
  }

  listar(conexaoId: string, filtro: { status?: StatusChamado[] } = {}): Promise<ChamadoCache[]> {
    return this.m.find(ChamadoCacheSchema, {
      where: {
        conexao_id: conexaoId,
        ...(filtro.status ? { status: In(filtro.status) } : {}),
      },
      order: { numero: 'DESC' },
    });
  }
}
