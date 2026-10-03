import {
  CONFIG_PROJETO_VERSAO,
  type ConfigProjeto,
  type ProjetoDetectado,
} from '../../../comum/config-projeto';
import type { FindOptionsWhere } from 'typeorm';
import { MapeamentoSistemaSchema, type MapeamentoSistema } from '../entidades/mapeamento-sistema';
import { ProjetoSchema, type Projeto } from '../entidades/projeto';
import { novoId } from '../ids';
import { RepositorioBase } from './base';

/**
 * Repositório de `projeto` + `mapeamento_sistema` (specs/forja/02 §4.2, §4.3;
 * FJ-030 §1). A configuração entra e sai como `ConfigProjeto` v2 (o que o
 * humano decidiu); resolver contra as globais e o detectado é do domínio
 * (`resolverConfig`), nunca deste módulo.
 */

export interface NovoProjeto {
  slug: string;
  conexao_id: string;
  config: ConfigProjeto;
  /** Default: `config.nome`. */
  nome?: string;
  ativo?: boolean;
  versao_cli_fixada?: string | null;
  detectado?: ProjetoDetectado | null;
}

export type PatchProjeto = Partial<Omit<NovoProjeto, 'conexao_id'>> & { conexao_id?: string };

export interface SistemaMapeado {
  sistema_nome: string;
  sistema_alvo_id?: string | null;
}

type ColunasConfig = Pick<
  Projeto,
  'nome' | 'repo_dir' | 'branch_destino' | 'sistemas' | 'avancado' | 'config_versao'
>;

function colunasDaConfig(config: ConfigProjeto): ColunasConfig {
  return {
    nome: config.nome,
    repo_dir: config.repo_dir,
    branch_destino: config.branch_destino ?? null,
    sistemas: config.sistemas ?? null,
    avancado: config.avancado ?? null,
    config_versao: CONFIG_PROJETO_VERSAO,
  };
}

/** Remonta a `ConfigProjeto` v2 a partir das colunas. */
export function configDoProjeto(p: Projeto): ConfigProjeto {
  return {
    versao: CONFIG_PROJETO_VERSAO,
    nome: p.nome,
    repo_dir: p.repo_dir,
    ...(p.branch_destino ? { branch_destino: p.branch_destino } : {}),
    ...(p.sistemas ? { sistemas: p.sistemas } : {}),
    ...(p.avancado ? { avancado: p.avancado } : {}),
  };
}

export class RepositorioProjetos extends RepositorioBase {
  async criar(dados: NovoProjeto): Promise<Projeto> {
    const agora = this.agora();
    const linha: Projeto = {
      ...colunasDaConfig(dados.config),
      nome: dados.nome ?? dados.config.nome,
      id: novoId(),
      slug: dados.slug,
      conexao_id: dados.conexao_id,
      ativo: dados.ativo ?? true,
      versao_cli_fixada: dados.versao_cli_fixada ?? null,
      detectado: dados.detectado ?? null,
      remoto_url: null,
      criado_em: agora,
      atualizado_em: agora,
    };
    await this.inserir(ProjetoSchema, linha);
    return linha;
  }

  obter(id: string): Promise<Projeto | null> {
    return this.obterPorId(ProjetoSchema, id);
  }

  exigir(id: string): Promise<Projeto> {
    return this.exigirPorId(ProjetoSchema, id);
  }

  obterPorSlug(slug: string): Promise<Projeto | null> {
    return this.m.findOne(ProjetoSchema, { where: { slug } });
  }

  listar(filtro: { ativos?: boolean; conexao_id?: string } = {}): Promise<Projeto[]> {
    const where: FindOptionsWhere<Projeto> = {};
    if (filtro.ativos !== undefined) where.ativo = filtro.ativos;
    if (filtro.conexao_id) where.conexao_id = filtro.conexao_id;
    return this.m.find(ProjetoSchema, { where, order: { nome: 'ASC' } });
  }

  /** Não afeta execuções em curso: elas usam `execucao.config_snapshot` (F-05). */
  async atualizar(id: string, patch: PatchProjeto): Promise<Projeto> {
    const { config, nome, ...simples } = patch;
    const valores: Partial<Projeto> = { ...simples, ...(config ? colunasDaConfig(config) : {}) };
    if (nome !== undefined) valores.nome = nome;
    if (config) {
      // Outro repositório ou outro remoto: a URL confirmada deixa de valer (recapturada).
      const atual = await this.exigir(id);
      const remotoAntes = atual.avancado?.repo?.remoto;
      const remotoDepois = config.avancado?.repo?.remoto;
      if (atual.repo_dir !== config.repo_dir || remotoAntes !== remotoDepois) {
        valores.remoto_url = null;
      }
      if (atual.repo_dir !== config.repo_dir) valores.detectado = null;
    }
    await this.atualizarPorId(ProjetoSchema, id, valores);
    return this.exigir(id);
  }

  /** Grava o resultado da autodetecção (cache; FJ-030 §1). */
  async gravarDetectado(id: string, detectado: ProjetoDetectado): Promise<void> {
    await this.atualizarPorId(ProjetoSchema, id, { detectado });
  }

  /** Fixa a URL do remoto (05 §9). Só preenche se ainda vazia: nunca troca a confirmada. */
  async fixarRemotoUrl(id: string, url: string): Promise<Projeto> {
    const atual = await this.exigir(id);
    if (!atual.remoto_url) await this.atualizarPorId(ProjetoSchema, id, { remoto_url: url });
    return this.exigir(id);
  }

  // ----- mapeamento_sistema (02 §4.3) -------------------------------------

  listarMapeamentos(projetoId: string): Promise<MapeamentoSistema[]> {
    return this.m.find(MapeamentoSistemaSchema, {
      where: { projeto_id: projetoId },
      order: { sistema_nome: 'ASC' },
    });
  }

  listarTodosMapeamentos(conexaoId: string): Promise<MapeamentoSistema[]> {
    return this.m.find(MapeamentoSistemaSchema, { where: { conexao_id: conexaoId } });
  }

  /**
   * Substitui o conjunto de sistemas do projeto (a tela salva a lista inteira).
   * Sistema já mapeado para OUTRO projeto da mesma conexão → `ErroRestricao`
   * (UNIQUE `(conexao_id, sistema_nome)`): um sistema-alvo aponta para um projeto.
   */
  async definirSistemas(
    projetoId: string,
    sistemas: SistemaMapeado[],
  ): Promise<MapeamentoSistema[]> {
    const projeto = await this.exigir(projetoId);
    const atuais = await this.listarMapeamentos(projetoId);
    const desejados = new Map(sistemas.map((s) => [s.sistema_nome, s]));
    for (const m of atuais) {
      if (!desejados.has(m.sistema_nome) || m.conexao_id !== projeto.conexao_id) {
        await this.m.delete(MapeamentoSistemaSchema, { id: m.id });
      }
    }
    const agora = this.agora();
    for (const s of desejados.values()) {
      const existente = atuais.find(
        (m) => m.sistema_nome === s.sistema_nome && m.conexao_id === projeto.conexao_id,
      );
      if (existente) {
        if (s.sistema_alvo_id !== undefined && s.sistema_alvo_id !== existente.sistema_alvo_id) {
          await this.atualizarPorId(MapeamentoSistemaSchema, existente.id, {
            sistema_alvo_id: s.sistema_alvo_id,
          });
        }
        continue;
      }
      await this.m.insert(MapeamentoSistemaSchema, {
        id: novoId(),
        projeto_id: projetoId,
        conexao_id: projeto.conexao_id,
        sistema_alvo_id: s.sistema_alvo_id ?? null,
        sistema_nome: s.sistema_nome,
        criado_em: agora,
        atualizado_em: agora,
      });
    }
    return this.listarMapeamentos(projetoId);
  }

  /** Projeto que recebe chamados do sistema: pelo id remoto (L2) e, sem ele, pelo nome. */
  async projetoDoSistema(
    conexaoId: string,
    sistema: { sistema_alvo_id?: string | null; sistema_nome?: string | null },
  ): Promise<Projeto | null> {
    let mapa: MapeamentoSistema | null = null;
    if (sistema.sistema_alvo_id) {
      mapa = await this.m.findOne(MapeamentoSistemaSchema, {
        where: { conexao_id: conexaoId, sistema_alvo_id: sistema.sistema_alvo_id },
      });
    }
    if (!mapa && sistema.sistema_nome) {
      mapa = await this.m.findOne(MapeamentoSistemaSchema, {
        where: { conexao_id: conexaoId, sistema_nome: sistema.sistema_nome },
      });
    }
    return mapa ? this.obter(mapa.projeto_id) : null;
  }
}
