import { In, Not } from 'typeorm';
import type { EstadoItemFilaMerge } from '../../../comum/estados';
import { ExecucaoSchema } from '../entidades/execucao';
import { ItemFilaMergeSchema, type ItemFilaMerge } from '../entidades/item-fila-merge';
import { ErroRestricao } from '../erros';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `item_fila_merge` (specs/forja/02 §4.12, invariantes I-5 e
 * I-8). A fila é SERIAL por `(projeto_id, branch_destino)`: `proximo` só
 * devolve um item quando nenhum outro da mesma fila está em processamento, e
 * o único parcial do banco recusa um segundo mesmo com bug no despachante.
 * `emProcessamento` alimenta a reconciliação do boot (I-8: nunca re-mergear).
 */

export interface NovoItemFila {
  projeto_id: string;
  branch_destino: string;
  execucao_id: string;
  aprovacao_id: string;
  copia_local_atras?: boolean;
}

export type PatchItemFila = Partial<
  Omit<
    ItemFilaMerge,
    'id' | 'projeto_id' | 'branch_destino' | 'execucao_id' | 'criado_em' | 'atualizado_em'
  >
>;

const FINAIS: EstadoItemFilaMerge[] = ['concluido', 'devolvido'];
const PROCESSANDO: EstadoItemFilaMerge[] = ['integrando', 'verificando', 'publicando'];

export class RepositorioFilaMerge extends RepositorioBase {
  async enfileirar(dados: NovoItemFila): Promise<ItemFilaMerge> {
    let ativo = await this.ativoDaExecucao(dados.execucao_id);
    if (ativo?.estado === 'conflito') {
      // O item em conflito fica visível até a próxima aprovação (Assumir →
      // Devolver → G2'): ela o substitui por um item novo (I-5).
      await this.atualizarPorId(ItemFilaMergeSchema, ativo.id, {
        estado: 'devolvido',
        motivo: ativo.motivo ?? 'substituído por nova aprovação',
      });
      ativo = null;
    }
    if (ativo) {
      throw new ErroRestricao(
        'I-5',
        'item_fila_merge.execucao_id',
        `a execução já está na fila de merge (item ${ativo.id})`,
      );
    }
    const ordem =
      (await this.maximo('item_fila_merge', 'ordem', {
        projeto_id: dados.projeto_id,
        branch_destino: dados.branch_destino,
      })) + 1;
    const agora = this.agora();
    const linha: ItemFilaMerge = {
      id: novoId(),
      projeto_id: dados.projeto_id,
      branch_destino: dados.branch_destino,
      execucao_id: dados.execucao_id,
      aprovacao_id: dados.aprovacao_id,
      ordem,
      estado: 'aguardando',
      motivo: null,
      tentativas_conflito: 0,
      sha_destino_antes: null,
      sha_integrado: null,
      patch_id_integrado: null,
      arquivos_em_conflito: null,
      modo_avanco: null,
      push_em: null,
      copia_local_atras: dados.copia_local_atras ?? false,
      worktree_integracao_dir: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ItemFilaMergeSchema, linha);
    return linha;
  }

  obter(id: string): Promise<ItemFilaMerge | null> {
    return this.obterPorId(ItemFilaMergeSchema, id);
  }

  exigir(id: string): Promise<ItemFilaMerge> {
    return this.exigirPorId(ItemFilaMergeSchema, id);
  }

  ativoDaExecucao(execucaoId: string): Promise<ItemFilaMerge | null> {
    return this.m.findOne(ItemFilaMergeSchema, {
      where: { execucao_id: execucaoId, estado: Not(In(FINAIS)) },
    });
  }

  /** Itens ativos de uma fila, na ordem de processamento. */
  fila(projetoId: string, branchDestino: string): Promise<ItemFilaMerge[]> {
    return this.m.find(ItemFilaMergeSchema, {
      where: { projeto_id: projetoId, branch_destino: branchDestino, estado: Not(In(FINAIS)) },
      order: { ordem: 'ASC' },
    });
  }

  /** Todos os itens de uma execução (ativos e finais), do mais antigo ao mais novo. */
  daExecucao(execucaoId: string): Promise<ItemFilaMerge[]> {
    return this.m.find(ItemFilaMergeSchema, {
      where: { execucao_id: execucaoId },
      order: { criado_em: 'ASC', ordem: 'ASC' },
    });
  }

  /** Todas as filas com algo ativo (tela "Fila de merge"). */
  ativos(): Promise<ItemFilaMerge[]> {
    return this.m.find(ItemFilaMergeSchema, {
      where: { estado: Not(In(FINAIS)) },
      order: { projeto_id: 'ASC', branch_destino: 'ASC', ordem: 'ASC' },
    });
  }

  /**
   * Próximo `aguardando` da fila, ou null se a fila está ocupada/vazia. Defesa:
   * ignora o item de uma execução que já saiu de `na_fila_merge`/`integrando`
   * (um item esquecido nunca pode travar o destino inteiro).
   */
  async proximo(projetoId: string, branchDestino: string): Promise<ItemFilaMerge | null> {
    const itens = await this.fila(projetoId, branchDestino);
    if (itens.some((i) => PROCESSANDO.includes(i.estado))) return null;
    const aguardando = itens.filter((i) => i.estado === 'aguardando');
    if (aguardando.length === 0) return null;
    const execs = await this.m.find(ExecucaoSchema, {
      where: { id: In(aguardando.map((i) => i.execucao_id)) },
    });
    const naFila = new Set(
      execs
        .filter((e) => e.estado === 'na_fila_merge' || e.estado === 'integrando')
        .map((e) => e.id),
    );
    return aguardando.find((i) => naFila.has(i.execucao_id)) ?? null;
  }

  /** Reconciliação do boot (I-8). */
  emProcessamento(): Promise<ItemFilaMerge[]> {
    return this.m.find(ItemFilaMergeSchema, { where: { estado: In(PROCESSANDO) } });
  }

  async mudarEstado(
    id: string,
    estado: EstadoItemFilaMerge,
    extras: PatchItemFila = {},
  ): Promise<ItemFilaMerge> {
    await this.atualizarPorId(ItemFilaMergeSchema, id, { ...extras, estado });
    return this.exigir(id);
  }

  async atualizar(id: string, patch: PatchItemFila): Promise<ItemFilaMerge> {
    await this.atualizarPorId(ItemFilaMergeSchema, id, patch);
    return this.exigir(id);
  }

  /** Reordenação pelo humano: `ids` na nova ordem; só itens `aguardando` da fila mudam. */
  async reordenar(
    projetoId: string,
    branchDestino: string,
    ids: string[],
  ): Promise<ItemFilaMerge[]> {
    const itens = await this.fila(projetoId, branchDestino);
    const aguardando = itens.filter((i) => i.estado === 'aguardando');
    const posicoes = aguardando.map((i) => i.ordem).sort((a, b) => a - b);
    const novaOrdem = [
      ...ids.filter((id) => aguardando.some((i) => i.id === id)),
      ...aguardando.filter((i) => !ids.includes(i.id)).map((i) => i.id),
    ];
    for (const [k, id] of novaOrdem.entries()) {
      await this.atualizarPorId(ItemFilaMergeSchema, id, { ordem: posicoes[k]! });
    }
    return this.fila(projetoId, branchDestino);
  }
}
