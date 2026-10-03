import { IsNull, In } from 'typeorm';
import type { DecisaoAprovacao, PoliticaStatus, TipoAprovacao } from '../../../comum/estados';
import { AprovacaoSchema, type Aprovacao } from '../entidades/aprovacao';
import { ExecucaoSchema } from '../entidades/execucao';
import { ErroEstado, ErroRestricao } from '../erros';
import { novoId } from '../ids';
import type { ValidacaoAprovacao } from '../json';
import { RepositorioBase } from './base';

/**
 * Repositório de `aprovacao` (specs/forja/02 §4.11, invariante I-3). Registro
 * IMUTÁVEL: depois de gravada, a única mudança possível é a invalidação
 * (patch-id mudou na integração, mensagem nova do cliente).
 *
 * Mantém `execucao.aprovacao_vigente_id` coerente na MESMA transação: uma
 * final/reaprovação aprovada passa a ser a vigente; invalidá-la limpa o
 * ponteiro. A exigência de "aprovar sem prints" depende da execução (selos,
 * evidência visual, gates) e é do domínio, antes de chamar `registrar`.
 */

export interface NovaAprovacao {
  execucao_id: string;
  tipo: TipoAprovacao;
  decisao: DecisaoAprovacao;
  artefato_id?: string | null;
  patch_id?: string | null;
  sha?: string | null;
  texto_resposta?: string | null;
  validacao_resposta?: ValidacaoAprovacao | null;
  aprovado_sem_prints?: boolean;
  politica_status?: PoliticaStatus | null;
  comentario?: string | null;
  ciente_mensagem_id?: string | null;
  em_bloco?: boolean;
  lote_id?: string | null;
}

const TIPOS_FINAIS: TipoAprovacao[] = ['final', 'reaprovacao'];
const DECISOES_POSITIVAS: DecisaoAprovacao[] = ['aprovado', 'aprovado_com_edicao'];

function ehVigente(a: Pick<Aprovacao, 'tipo' | 'decisao'>): boolean {
  return TIPOS_FINAIS.includes(a.tipo) && DECISOES_POSITIVAS.includes(a.decisao);
}

export class RepositorioAprovacoes extends RepositorioBase {
  async registrar(dados: NovaAprovacao): Promise<Aprovacao> {
    if (ehVigente(dados)) {
      const vigente = await this.vigente(dados.execucao_id);
      if (vigente) {
        throw new ErroRestricao(
          'I-3',
          'aprovacao.execucao_id',
          `a execução já tem aprovação vigente (${vigente.id}); invalide-a antes`,
        );
      }
    }
    const agora = this.agora();
    const linha: Aprovacao = {
      id: novoId(),
      execucao_id: dados.execucao_id,
      tipo: dados.tipo,
      decisao: dados.decisao,
      artefato_id: dados.artefato_id ?? null,
      patch_id: dados.patch_id ?? null,
      sha: dados.sha ?? null,
      texto_resposta: dados.texto_resposta ?? null,
      validacao_resposta: dados.validacao_resposta ?? null,
      aprovado_sem_prints: dados.aprovado_sem_prints ?? false,
      politica_status: dados.politica_status ?? null,
      comentario: dados.comentario ?? null,
      ciente_mensagem_id: dados.ciente_mensagem_id ?? null,
      em_bloco: dados.em_bloco ?? false,
      lote_id: dados.lote_id ?? null,
      invalidada_em: null,
      motivo_invalidacao: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(AprovacaoSchema, linha);
    if (ehVigente(linha)) {
      await this.atualizarPorId(ExecucaoSchema, linha.execucao_id, {
        aprovacao_vigente_id: linha.id,
      });
    }
    return linha;
  }

  obter(id: string): Promise<Aprovacao | null> {
    return this.obterPorId(AprovacaoSchema, id);
  }

  exigir(id: string): Promise<Aprovacao> {
    return this.exigirPorId(AprovacaoSchema, id);
  }

  /** A final/reaprovação aprovada e não invalidada (I-3: no máximo uma). */
  vigente(execucaoId: string): Promise<Aprovacao | null> {
    return this.m.findOne(AprovacaoSchema, {
      where: {
        execucao_id: execucaoId,
        tipo: In(TIPOS_FINAIS),
        decisao: In(DECISOES_POSITIVAS),
        invalidada_em: IsNull(),
      },
    });
  }

  listar(execucaoId: string, filtro: { tipo?: TipoAprovacao } = {}): Promise<Aprovacao[]> {
    return this.m.find(AprovacaoSchema, {
      where: { execucao_id: execucaoId, ...(filtro.tipo ? { tipo: filtro.tipo } : {}) },
      order: { criado_em: 'ASC', id: 'ASC' },
    });
  }

  /** Única mutação permitida (F-11). Limpa o ponteiro da execução se era a vigente. */
  async invalidar(id: string, motivo: string): Promise<Aprovacao> {
    const a = await this.exigir(id);
    if (a.invalidada_em) throw new ErroEstado(`aprovação ${id} já foi invalidada`);
    await this.atualizarPorId(AprovacaoSchema, id, {
      invalidada_em: this.agora(),
      motivo_invalidacao: motivo,
    });
    await this.m
      .createQueryBuilder()
      .update(ExecucaoSchema)
      .set({ aprovacao_vigente_id: null, atualizado_em: this.agora() })
      .where('id = :e AND aprovacao_vigente_id = :a', { e: a.execucao_id, a: id })
      .execute();
    return this.exigir(id);
  }
}
