import { EntitySchema } from 'typeorm';
import type { AvancadoProjeto, ProjetoDetectado } from '../../../comum/config-projeto';
import { AvancadoProjetoSchema, ListaCaminhosSchema, ProjetoDetectadoSchema } from '../json';
import { booleano, inteiro, json, pk, tempo, texto, type ComTempo } from './colunas';

/**
 * `projeto` (specs/forja/02 §4.2; FJ-030 §1): um repositório local que
 * implementa chamados de um ou mais sistemas-alvo.
 *
 * Desde FJ-030 a linha guarda só o que o humano DECIDIU (`ConfigProjeto` v2):
 * pasta, nome, branch e sistemas opcionais e o `avancado` (JSON validado pelo
 * zod, estrito). O resto vem da configuração global e da autodetecção, cujo
 * último resultado fica em `detectado` (cache: refeito ao abrir a tela do
 * projeto e ao criar cada execução). `branch_destino`/`sistemas` nulos =
 * automáticos.
 *
 * Mudar a configuração não afeta execuções já iniciadas: elas leem
 * `execucao.config_snapshot` (F-05), resolvido no G0.
 */
export interface Projeto extends ComTempo {
  id: string;
  nome: string;
  slug: string;
  conexao_id: string;
  repo_dir: string;
  /** URL do remoto confirmada no cadastro (05 §9): conferida antes de cada fetch/push. */
  remoto_url: string | null;
  /** Escolhida pelo humano; `null` = autodetectada. */
  branch_destino: string | null;
  /** Ids/nomes de sistema-alvo escolhidos; `null` = casamento automático por nome. */
  sistemas: string[] | null;
  avancado: AvancadoProjeto | null;
  detectado: ProjetoDetectado | null;
  ativo: boolean;
  config_versao: number;
  versao_cli_fixada: string | null;
}

export const ProjetoSchema = new EntitySchema<Projeto>({
  name: 'Projeto',
  tableName: 'projeto',
  columns: {
    id: pk(),
    nome: texto(),
    slug: texto(),
    conexao_id: texto(),
    repo_dir: texto(),
    remoto_url: texto(true),
    branch_destino: texto(true),
    sistemas: json(ListaCaminhosSchema, 'projeto.sistemas', true),
    avancado: json(AvancadoProjetoSchema, 'projeto.avancado', true),
    detectado: json(ProjetoDetectadoSchema, 'projeto.detectado', true),
    ativo: booleano(),
    config_versao: inteiro(),
    versao_cli_fixada: texto(true),
    ...tempo(),
  },
  uniques: [{ name: 'uq_projeto_slug', columns: ['slug'] }],
});
