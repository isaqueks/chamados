import { createHash } from 'node:crypto';
import type { TipoArtefato } from '../../../comum/estados';
import { ArtefatoSchema, type Artefato } from '../entidades/artefato';
import { novoId } from '../ids';
import type { JsonLivre } from '../json';
import { RepositorioBase } from './base';

/**
 * Repositório de `artefato` (specs/forja/02 §4.9). `criar` numera a `versao`
 * por `(execucao_id, tipo)` — editar o plano cria versão nova, nunca
 * sobrescreve (F-11). Para artefato só com `conteudo`, `sha256`/`tamanho_bytes`
 * são calculados do JSON gravado; para arquivo, quem chama informa os do arquivo
 * (é o que a aprovação confere contra o disco).
 */

export interface NovoArtefato {
  execucao_id: string;
  etapa_id?: string | null;
  tipo: TipoArtefato;
  contrato?: string | null;
  conteudo?: JsonLivre | null;
  /** Relativo a `<dados>/execucoes/<execucao_id>/`. */
  caminho?: string | null;
  sha256?: string;
  tamanho_bytes?: number;
  sha_git?: string | null;
  patch_id?: string | null;
  editado_por_humano?: boolean;
}

function assinaturaDoConteudo(conteudo: JsonLivre): { sha256: string; tamanho_bytes: number } {
  const bytes = Buffer.from(JSON.stringify(conteudo), 'utf8');
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    tamanho_bytes: bytes.length,
  };
}

export class RepositorioArtefatos extends RepositorioBase {
  async criar(dados: NovoArtefato): Promise<Artefato> {
    const conteudo = dados.conteudo ?? null;
    let assinatura: { sha256: string; tamanho_bytes: number };
    if (dados.sha256 !== undefined && dados.tamanho_bytes !== undefined) {
      assinatura = { sha256: dados.sha256, tamanho_bytes: dados.tamanho_bytes };
    } else if (conteudo !== null && !dados.caminho) {
      assinatura = assinaturaDoConteudo(conteudo);
    } else {
      throw new TypeError('artefato em arquivo exige sha256 e tamanho_bytes do arquivo');
    }
    const versao =
      (await this.maximo('artefato', 'versao', {
        execucao_id: dados.execucao_id,
        tipo: dados.tipo,
      })) + 1;
    const agora = this.agora();
    const linha: Artefato = {
      id: novoId(),
      execucao_id: dados.execucao_id,
      etapa_id: dados.etapa_id ?? null,
      tipo: dados.tipo,
      versao,
      contrato: dados.contrato ?? null,
      conteudo,
      caminho: dados.caminho ?? null,
      ...assinatura,
      sha_git: dados.sha_git ?? null,
      patch_id: dados.patch_id ?? null,
      editado_por_humano: dados.editado_por_humano ?? false,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ArtefatoSchema, linha);
    return linha;
  }

  obter(id: string): Promise<Artefato | null> {
    return this.obterPorId(ArtefatoSchema, id);
  }

  exigir(id: string): Promise<Artefato> {
    return this.exigirPorId(ArtefatoSchema, id);
  }

  /** Versão vigente de um contrato (a mais alta). */
  ultimaVersao(execucaoId: string, tipo: TipoArtefato): Promise<Artefato | null> {
    return this.m.findOne(ArtefatoSchema, {
      where: { execucao_id: execucaoId, tipo },
      order: { versao: 'DESC' },
    });
  }

  listar(
    execucaoId: string,
    filtro: { tipo?: TipoArtefato; etapa_id?: string } = {},
  ): Promise<Artefato[]> {
    return this.m.find(ArtefatoSchema, {
      where: {
        execucao_id: execucaoId,
        ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
        ...(filtro.etapa_id ? { etapa_id: filtro.etapa_id } : {}),
      },
      order: { tipo: 'ASC', versao: 'ASC' },
    });
  }

  /**
   * Print `antes` reaproveitável (FJ-026, 02 §4.9): mesma execução, mesma rota
   * e mesmo `sha_base` — um novo ciclo não recaptura o `antes`.
   */
  async evidenciaAntes(
    execucaoId: string,
    rota: string,
    shaBase: string,
  ): Promise<Artefato | null> {
    const linhas = (await this.m.query(
      `SELECT "id" FROM "artefato"
        WHERE "execucao_id" = ? AND "tipo" = 'evidencia' AND "sha_git" = ?
          AND json_extract("conteudo", '$.momento') = 'antes'
          AND json_extract("conteudo", '$.rota') = ?
        ORDER BY "versao" DESC LIMIT 1`,
      [execucaoId, shaBase, rota],
    )) as { id: string }[];
    const id = linhas[0]?.id;
    return id ? this.obter(id) : null;
  }
}
