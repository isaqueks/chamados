import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  ArquivosLocaisSchema,
  ComandosProjetoSchema,
  CONFIG_PROJETO_VERSAO,
  configuracoesGlobaisPadrao,
  converterConfigV1,
  DetectoresSchema,
  detectadoVazio,
  EntregaProjetoSchema,
  GatesProjetoSchema,
  LimitesProjetoSchema,
  ModoReforcadoSchema,
  PoliticaStatusProjetoSchema,
  resolverConfig,
  RetencaoProjetoSchema,
  type AvancadoProjeto,
  type ProjetoDetectado,
} from '../../../comum/config-projeto';
import { COLUNAS_TEMPO, checkBool, checkJson, checkMinimo } from '../sql';
import { conferirChavesEstrangeiras } from './util';

/**
 * `projeto` v2 (specs/forja/02 §4.2; FJ-030 §1): a linha passa a guardar só o
 * que o humano decidiu — pasta, nome, branch e sistemas opcionais e o
 * `avancado` —, mais o cache da autodetecção (`detectado`). Modelos, limites,
 * cota e gates foram para a configuração global; `evidencias` deixou de existir
 * (a captura passou ao agente, FJ-030 §3).
 *
 * POR QUE recriar a tabela: o SQLite não remove coluna citada em CHECK
 * (`ck_projeto_remoto` lia `entrega`). As linhas são lidas para a memória, a
 * tabela é derrubada e recriada com o MESMO nome e as linhas reinseridas,
 * dentro da transação da migration com `defer_foreign_keys`: as filhas
 * (`execucao`, `lote`, `mapeamento_sistema`…) ficam órfãs só entre o DROP e o
 * INSERT, e a conferência das chaves é no COMMIT (o `undoLastMigration` do
 * TypeORM sempre abre transação, então `transaction = false` não serviria ao
 * `down`).
 *
 * Projetos existentes NÃO se perdem: `converterConfigV1` leva para `avancado`
 * tudo o que o projeto tinha de próprio (comandos, detectores, arquivos locais,
 * entrega, política, gates, limites, modo reforçado) — o comportamento das
 * próximas execuções é o mesmo, salvo modelos (agora globais). Os sistemas já
 * mapeados viram a lista explícita (`sistemas`), para o casamento automático
 * não mexer no que o humano escolheu.
 */
export class ProjetoV21790000000002 implements MigrationInterface {
  name = 'ProjetoV21790000000002';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query('PRAGMA defer_foreign_keys = ON');
    const linhas = (await qr.query('SELECT * FROM "projeto"')) as LinhaV1[];
    const novas: unknown[][] = [];
    for (const l of linhas) {
      const maps = (await qr.query(
        'SELECT "sistema_nome" FROM "mapeamento_sistema" WHERE "projeto_id" = ? ORDER BY "sistema_nome"',
        [l.id],
      )) as { sistema_nome: string }[];
      const v2 = converterConfigV1(l.nome, {
        repo: {
          dir: l.repo_dir,
          remoto: l.remoto,
          branch_destino: l.branch_destino,
          prefixo_branch: l.prefixo_branch,
        },
        entrega: EntregaProjetoSchema.parse(JSON.parse(l.entrega)),
        politica_status: PoliticaStatusProjetoSchema.parse(JSON.parse(l.politica_status)),
        comandos: ComandosProjetoSchema.parse(JSON.parse(l.comandos)),
        arquivos_locais: ArquivosLocaisSchema.parse(JSON.parse(l.arquivos_locais)),
        detectores: DetectoresSchema.parse(JSON.parse(l.detectores)),
        limites: LimitesProjetoSchema.parse(JSON.parse(l.limites)),
        gates: GatesProjetoSchema.parse(JSON.parse(l.gates)),
        modo_reforcado: ModoReforcadoSchema.parse(JSON.parse(l.modo_reforcado)),
        retencao: RetencaoProjetoSchema.parse(JSON.parse(l.retencao)),
      });
      novas.push([
        l.id,
        v2.nome,
        l.slug,
        l.conexao_id,
        v2.repo_dir,
        l.remoto_url ?? null,
        v2.branch_destino ?? null,
        maps.length > 0 ? JSON.stringify(maps.map((m) => m.sistema_nome)) : null,
        v2.avancado ? JSON.stringify(v2.avancado) : null,
        l.ativo,
        CONFIG_PROJETO_VERSAO,
        l.versao_cli_fixada,
        l.criado_em,
        l.atualizado_em,
      ]);
    }
    await qr.query('DROP TABLE "projeto"');
    await qr.query(ddlV2('projeto'));
    for (const valores of novas) {
      await qr.query(
        `INSERT INTO "projeto" ("id", "nome", "slug", "conexao_id", "repo_dir", "remoto_url",
          "branch_destino", "sistemas", "avancado", "detectado", "ativo", "config_versao",
          "versao_cli_fixada", "criado_em", "atualizado_em")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        valores,
      );
    }
    await conferirChavesEstrangeiras(qr);
  }

  /** Volta à v1 com a configuração RESOLVIDA (padrões globais + o detectado em cache). */
  public async down(qr: QueryRunner): Promise<void> {
    await qr.query('PRAGMA defer_foreign_keys = ON');
    const linhas = (await qr.query('SELECT * FROM "projeto"')) as LinhaV2[];
    const antigas: unknown[][] = [];
    for (const l of linhas) {
      const avancado = l.avancado ? (JSON.parse(l.avancado) as AvancadoProjeto) : undefined;
      const detectado = l.detectado
        ? (JSON.parse(l.detectado) as ProjetoDetectado)
        : detectadoVazio(l.repo_dir);
      const r = resolverConfig(
        {
          repo_dir: l.repo_dir,
          ...(l.branch_destino ? { branch_destino: l.branch_destino } : {}),
          ...(avancado ? { avancado } : {}),
        },
        configuracoesGlobaisPadrao(),
        detectado,
      );
      antigas.push([
        l.id,
        l.nome,
        l.slug,
        l.conexao_id,
        l.repo_dir,
        r.repo.remoto,
        l.remoto_url,
        r.repo.branch_destino,
        r.repo.prefixo_branch,
        l.ativo,
        JSON.stringify(r.comandos),
        JSON.stringify(r.arquivos_locais),
        JSON.stringify(r.detectores),
        JSON.stringify(EVIDENCIAS_V1),
        JSON.stringify(r.modelos),
        JSON.stringify(r.limites),
        JSON.stringify(r.gates),
        JSON.stringify(r.entrega),
        JSON.stringify(r.politica_status),
        JSON.stringify(r.modo_reforcado),
        JSON.stringify(r.retencao),
        l.versao_cli_fixada,
        l.criado_em,
        l.atualizado_em,
      ]);
    }
    await qr.query('DROP TABLE "projeto"');
    await qr.query(ddlV1('projeto'));
    for (const valores of antigas) {
      await qr.query(
        `INSERT INTO "projeto" ("id", "nome", "slug", "conexao_id", "repo_dir", "remoto",
          "remoto_url", "branch_destino", "prefixo_branch", "ativo", "config_versao",
          "comandos", "arquivos_locais", "detectores", "evidencias", "modelos", "limites",
          "gates", "entrega", "politica_status", "modo_reforcado", "retencao",
          "versao_cli_fixada", "criado_em", "atualizado_em")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        valores,
      );
    }
    await conferirChavesEstrangeiras(qr);
  }
}

interface LinhaV1 {
  id: string;
  nome: string;
  slug: string;
  conexao_id: string;
  repo_dir: string;
  remoto: string | null;
  remoto_url: string | null;
  branch_destino: string;
  prefixo_branch: string;
  ativo: number;
  versao_cli_fixada: string | null;
  comandos: string;
  arquivos_locais: string;
  detectores: string;
  limites: string;
  gates: string;
  entrega: string;
  politica_status: string;
  modo_reforcado: string;
  retencao: string;
  criado_em: string;
  atualizado_em: string;
}

interface LinhaV2 {
  id: string;
  nome: string;
  slug: string;
  conexao_id: string;
  repo_dir: string;
  remoto_url: string | null;
  branch_destino: string | null;
  avancado: string | null;
  detectado: string | null;
  ativo: number;
  versao_cli_fixada: string | null;
  criado_em: string;
  atualizado_em: string;
}

/** O antigo default de `projeto.evidencias` (só para o `down`). */
const EVIDENCIAS_V1 = {
  viewport: { largura: 1366, altura: 768 },
  tema: 'claro',
  autenticacao: { modo: 'storage_state', rota_login: '/login' },
  timeout_tela_s: 30,
};

function ddlV2(tabela: string): string {
  return `
    CREATE TABLE "${tabela}" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "nome" TEXT NOT NULL,
      "slug" TEXT NOT NULL,
      "conexao_id" TEXT NOT NULL REFERENCES "conexao_chamados" ("id") ON DELETE RESTRICT,
      "repo_dir" TEXT NOT NULL,
      "remoto_url" TEXT,
      "branch_destino" TEXT,
      "sistemas" TEXT,
      "avancado" TEXT,
      "detectado" TEXT,
      "ativo" INTEGER NOT NULL,
      "config_versao" INTEGER NOT NULL,
      "versao_cli_fixada" TEXT,
      ${COLUNAS_TEMPO},
      CONSTRAINT "uq_projeto_slug" UNIQUE ("slug"),
      ${checkBool('projeto', 'ativo')},
      ${checkMinimo('projeto', 'config_versao', 2)},
      ${['sistemas', 'avancado', 'detectado'].map((c) => checkJson('projeto', c)).join(',\n      ')}
    )
  `;
}

function ddlV1(tabela: string): string {
  const jsons = [
    'comandos',
    'arquivos_locais',
    'detectores',
    'evidencias',
    'modelos',
    'limites',
    'gates',
    'entrega',
    'politica_status',
    'modo_reforcado',
    'retencao',
  ];
  return `
    CREATE TABLE "${tabela}" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "nome" TEXT NOT NULL,
      "slug" TEXT NOT NULL,
      "conexao_id" TEXT NOT NULL REFERENCES "conexao_chamados" ("id") ON DELETE RESTRICT,
      "repo_dir" TEXT NOT NULL,
      "remoto" TEXT,
      "branch_destino" TEXT NOT NULL,
      "prefixo_branch" TEXT NOT NULL,
      "ativo" INTEGER NOT NULL,
      "config_versao" INTEGER NOT NULL,
      ${jsons.map((c) => `"${c}" TEXT NOT NULL`).join(',\n      ')},
      "versao_cli_fixada" TEXT,
      "remoto_url" TEXT,
      ${COLUNAS_TEMPO},
      CONSTRAINT "uq_projeto_slug" UNIQUE ("slug"),
      ${checkBool('projeto', 'ativo')},
      ${checkMinimo('projeto', 'config_versao', 1)},
      ${jsons.map((c) => checkJson('projeto', c)).join(',\n      ')},
      CONSTRAINT "ck_projeto_remoto" CHECK ("remoto" IS NOT NULL OR json_extract("entrega", '$.modo') = 'merge_local')
    )
  `;
}
