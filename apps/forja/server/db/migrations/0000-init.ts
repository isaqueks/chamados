import { Complexidade, Natureza, Papel, Prioridade, StatusChamado } from '@chamados/shared';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  AlvoComentario,
  AmbienteConexao,
  DecisaoAprovacao,
  EstadoEtapa,
  EstadoExecucao,
  EstadoItemFilaMerge,
  EstadoLote,
  EstadoOutbox,
  EvidenciaVisual,
  LocalSenha,
  ModoAvancoRef,
  MotivoEstado,
  MotivoFimEtapa,
  NivelVerificacao,
  OrigemEvento,
  PapelAgente,
  PassoOutbox,
  PoliticaStatus,
  StatusCota,
  TipoArtefato,
  TipoAprovacao,
  TipoEtapa,
  TipoSessaoTerminal,
} from '../../../comum/estados';
import { NivelEvento } from '../../../comum/protocolo-eventos';
import {
  COLUNAS_TEMPO,
  SQL_APROVACAO_VIGENTE,
  SQL_ESTADOS_LATERAIS,
  SQL_EXECUCAO_ATIVA,
  SQL_ITEM_FILA_ATIVO,
  SQL_ITEM_FILA_PROCESSANDO,
  checkBool,
  checkEnum,
  checkJson,
  checkMinimo,
  valoresDe,
} from '../sql';
import { conferirChavesEstrangeiras } from './util';

/**
 * Migration inicial da Forja (specs/forja/02 §4, §5 e §10): as 15 tabelas, com
 * CHECKs de enum/booleano/JSON (02 §1), as invariantes I-1…I-9 que cabem no
 * banco e os índices de 02 §10.
 *
 * POR QUE SQL escrito à mão: 02 §1 manda migrations revisadas, com `up` e
 * `down`, e o DDL do SQLite precisa de detalhes que o TypeORM não gera bem
 * (índices únicos PARCIAIS, `AUTOINCREMENT`, CHECKs nomeados que viram código de
 * invariante em `erros.ts`). Os valores dos enums vêm das constantes de
 * `comum/estados.ts` e de `@chamados/shared` (F-18), nunca de literais.
 *
 * Chaves estrangeiras: `RESTRICT` por padrão (02 §1); `CASCADE` só de
 * `execucao` para as filhas (usado só no "apagar histórico"). Referências
 * ENTRE filhas da mesma execução (artefato→etapa, aprovacao→artefato…) ficam
 * `NO ACTION`, que o SQLite confere no FIM do comando — assim a cascata a
 * partir da execução apaga as filhas juntas sem tropeçar na ordem; um DELETE
 * direto de uma filha referenciada continua recusado.
 */
export class Init1790000000000 implements MigrationInterface {
  name = 'Init1790000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "conexao_chamados" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "nome" TEXT NOT NULL,
        "url_base" TEXT NOT NULL,
        "tenant_slug" TEXT,
        "ambiente" TEXT NOT NULL,
        "email" TEXT NOT NULL,
        "usuario_id" TEXT,
        "usuario_nome" TEXT,
        "papel" TEXT,
        "token_cifrado" TEXT,
        "token_expira_em" TEXT,
        "local_senha" TEXT NOT NULL,
        "ultimo_login_em" TEXT,
        ${COLUNAS_TEMPO},
        CONSTRAINT "uq_conexao_chamados_nome" UNIQUE ("nome"),
        ${checkEnum('conexao_chamados', 'ambiente', valoresDe(AmbienteConexao))},
        ${checkEnum('conexao_chamados', 'local_senha', valoresDe(LocalSenha))},
        ${checkEnum('conexao_chamados', 'papel', [Papel.operador, Papel.admin])}
      )
    `);

    await qr.query(`
      CREATE TABLE "projeto" (
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
        "comandos" TEXT NOT NULL,
        "arquivos_locais" TEXT NOT NULL,
        "detectores" TEXT NOT NULL,
        "evidencias" TEXT NOT NULL,
        "modelos" TEXT NOT NULL,
        "limites" TEXT NOT NULL,
        "gates" TEXT NOT NULL,
        "entrega" TEXT NOT NULL,
        "politica_status" TEXT NOT NULL,
        "modo_reforcado" TEXT NOT NULL,
        "retencao" TEXT NOT NULL,
        "versao_cli_fixada" TEXT,
        ${COLUNAS_TEMPO},
        CONSTRAINT "uq_projeto_slug" UNIQUE ("slug"),
        ${checkBool('projeto', 'ativo')},
        ${checkMinimo('projeto', 'config_versao', 1)},
        ${[
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
        ]
          .map((c) => checkJson('projeto', c))
          .join(',\n        ')},
        CONSTRAINT "ck_projeto_remoto" CHECK ("remoto" IS NOT NULL OR json_extract("entrega", '$.modo') = 'merge_local')
      )
    `);

    await qr.query(`
      CREATE TABLE "mapeamento_sistema" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "projeto_id" TEXT NOT NULL REFERENCES "projeto" ("id") ON DELETE RESTRICT,
        "conexao_id" TEXT NOT NULL REFERENCES "conexao_chamados" ("id") ON DELETE RESTRICT,
        "sistema_alvo_id" TEXT,
        "sistema_nome" TEXT NOT NULL,
        ${COLUNAS_TEMPO}
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_mapeamento_sistema_alvo" ON "mapeamento_sistema" ("conexao_id", "sistema_alvo_id") WHERE "sistema_alvo_id" IS NOT NULL`,
    );
    await qr.query(
      `CREATE UNIQUE INDEX "ux_mapeamento_sistema_nome" ON "mapeamento_sistema" ("conexao_id", "sistema_nome")`,
    );
    await qr.query(
      `CREATE INDEX "ix_mapeamento_sistema_projeto" ON "mapeamento_sistema" ("projeto_id")`,
    );

    await qr.query(`
      CREATE TABLE "chamado_cache" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "conexao_id" TEXT NOT NULL REFERENCES "conexao_chamados" ("id") ON DELETE RESTRICT,
        "chamado_id" TEXT NOT NULL,
        "numero" INTEGER NOT NULL,
        "titulo" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "natureza" TEXT NOT NULL,
        "prioridade" TEXT NOT NULL,
        "complexidade" TEXT,
        "sistema_alvo_id" TEXT,
        "sistema_nome" TEXT,
        "operador_id" TEXT,
        "ia_silenciada" INTEGER,
        "ultima_mensagem_id" TEXT,
        "ultima_mensagem_em" TEXT,
        "sinais" TEXT NOT NULL,
        "atualizado_em_remoto" TEXT,
        "sincronizado_em" TEXT NOT NULL,
        "detalhe_sincronizado_em" TEXT,
        ${COLUNAS_TEMPO},
        ${checkMinimo('chamado_cache', 'numero', 1)},
        ${checkEnum('chamado_cache', 'status', valoresDe(StatusChamado))},
        ${checkEnum('chamado_cache', 'natureza', valoresDe(Natureza))},
        ${checkEnum('chamado_cache', 'prioridade', valoresDe(Prioridade))},
        ${checkEnum('chamado_cache', 'complexidade', valoresDe(Complexidade))},
        ${checkBool('chamado_cache', 'ia_silenciada')},
        ${checkJson('chamado_cache', 'sinais')}
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_chamado_cache_chamado" ON "chamado_cache" ("conexao_id", "chamado_id")`,
    );
    await qr.query(
      `CREATE UNIQUE INDEX "ux_chamado_cache_numero" ON "chamado_cache" ("conexao_id", "numero")`,
    );
    await qr.query(
      `CREATE INDEX "ix_chamado_cache_status" ON "chamado_cache" ("conexao_id", "status")`,
    );
    await qr.query(`CREATE INDEX "ix_chamado_cache_sistema" ON "chamado_cache" ("sistema_nome")`);

    await qr.query(`
      CREATE TABLE "lote" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "projeto_id" TEXT NOT NULL REFERENCES "projeto" ("id") ON DELETE RESTRICT,
        "nome" TEXT NOT NULL,
        "estado" TEXT NOT NULL,
        "concorrencia_planos" INTEGER NOT NULL,
        "concorrencia_impl" INTEGER NOT NULL,
        "encerrado_em" TEXT,
        ${COLUNAS_TEMPO},
        ${checkEnum('lote', 'estado', valoresDe(EstadoLote))},
        ${checkMinimo('lote', 'concorrencia_planos', 1)},
        ${checkMinimo('lote', 'concorrencia_impl', 1)}
      )
    `);
    await qr.query(`CREATE INDEX "ix_lote_projeto" ON "lote" ("projeto_id", "estado")`);

    await qr.query(`
      CREATE TABLE "execucao" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "conexao_id" TEXT NOT NULL REFERENCES "conexao_chamados" ("id") ON DELETE RESTRICT,
        "chamado_id" TEXT NOT NULL,
        "chamado_cache_id" TEXT NOT NULL REFERENCES "chamado_cache" ("id") ON DELETE RESTRICT,
        "projeto_id" TEXT NOT NULL REFERENCES "projeto" ("id") ON DELETE RESTRICT,
        "lote_id" TEXT REFERENCES "lote" ("id") ON DELETE RESTRICT,
        "numero" INTEGER NOT NULL,
        "tentativa" INTEGER NOT NULL,
        "estado" TEXT NOT NULL,
        "estado_anterior" TEXT,
        "motivo_estado" TEXT,
        "motivo_texto" TEXT,
        "config_snapshot" TEXT NOT NULL,
        "branch_destino" TEXT NOT NULL,
        "branch" TEXT,
        "worktree_dir" TEXT,
        "sha_base" TEXT,
        "sha_atual" TEXT,
        "sha_verificado" TEXT,
        "nivel_verificacao" TEXT,
        "ciclo_auto" INTEGER NOT NULL,
        "ciclo_total" INTEGER NOT NULL,
        "session_id_planejador" TEXT,
        "session_id_condutor" TEXT,
        "aprovacao_vigente_id" TEXT REFERENCES "aprovacao" ("id"),
        "sha_merge" TEXT,
        "selos" TEXT,
        "evidencia_visual" TEXT,
        "evidencia_visual_motivo" TEXT,
        "ia_silenciada_pelo_app" INTEGER NOT NULL,
        "atribuido_pelo_app" INTEGER NOT NULL,
        "sentinela" TEXT,
        "ultima_mensagem_ciente_id" TEXT,
        "custo_micro_usd" INTEGER NOT NULL,
        "iniciado_em" TEXT,
        "concluido_em" TEXT,
        ${COLUNAS_TEMPO},
        ${checkMinimo('execucao', 'numero', 1)},
        ${checkMinimo('execucao', 'tentativa', 1)},
        ${checkEnum('execucao', 'estado', valoresDe(EstadoExecucao))},
        ${checkEnum('execucao', 'estado_anterior', valoresDe(EstadoExecucao))},
        ${checkEnum('execucao', 'motivo_estado', valoresDe(MotivoEstado))},
        ${checkEnum('execucao', 'nivel_verificacao', valoresDe(NivelVerificacao))},
        ${checkEnum('execucao', 'evidencia_visual', valoresDe(EvidenciaVisual))},
        ${checkMinimo('execucao', 'ciclo_auto', 0)},
        ${checkMinimo('execucao', 'ciclo_total', 0)},
        ${checkMinimo('execucao', 'custo_micro_usd', 0)},
        ${checkBool('execucao', 'ia_silenciada_pelo_app')},
        ${checkBool('execucao', 'atribuido_pelo_app')},
        ${checkJson('execucao', 'config_snapshot')},
        ${checkJson('execucao', 'selos')},
        ${checkJson('execucao', 'sentinela')},
        CONSTRAINT "ck_execucao_lateral_anterior" CHECK ("estado" NOT IN (${SQL_ESTADOS_LATERAIS}) OR "estado_anterior" IS NOT NULL)
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_execucao_ativa_chamado" ON "execucao" ("conexao_id", "chamado_id") WHERE ${SQL_EXECUCAO_ATIVA}`,
    );
    await qr.query(
      `CREATE UNIQUE INDEX "ux_execucao_tentativa" ON "execucao" ("conexao_id", "chamado_id", "tentativa")`,
    );
    await qr.query(
      `CREATE UNIQUE INDEX "ux_execucao_worktree_ativa" ON "execucao" ("worktree_dir") WHERE ${SQL_EXECUCAO_ATIVA} AND "worktree_dir" IS NOT NULL`,
    );
    await qr.query(
      `CREATE UNIQUE INDEX "ux_execucao_branch_ativa" ON "execucao" ("projeto_id", "branch") WHERE ${SQL_EXECUCAO_ATIVA} AND "branch" IS NOT NULL`,
    );
    await qr.query(`CREATE INDEX "ix_execucao_estado" ON "execucao" ("estado")`);
    await qr.query(
      `CREATE INDEX "ix_execucao_projeto_estado" ON "execucao" ("projeto_id", "estado")`,
    );
    await qr.query(`CREATE INDEX "ix_execucao_lote" ON "execucao" ("lote_id")`);

    await qr.query(`
      CREATE TABLE "etapa" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "execucao_id" TEXT NOT NULL REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "n" INTEGER NOT NULL,
        "ciclo" INTEGER NOT NULL,
        "tipo" TEXT NOT NULL,
        "papel" TEXT,
        "estado" TEXT NOT NULL,
        "motivo_fim" TEXT,
        "contrato" TEXT,
        "session_id" TEXT,
        "retomada" INTEGER NOT NULL,
        "pid" INTEGER,
        "pgid" INTEGER,
        "modelo" TEXT,
        "esforco" TEXT,
        "prompt_versao" TEXT,
        "perfil" TEXT,
        "versao_cli" TEXT,
        "init" TEXT,
        "inicio" TEXT NOT NULL,
        "fim" TEXT,
        "ultimo_evento_em" TEXT,
        "exit_code" INTEGER,
        "sinal" TEXT,
        "custo_micro_usd" INTEGER,
        "model_usage" TEXT,
        "subagent_stats" TEXT,
        "permission_denials" TEXT,
        "condutor_editou" INTEGER NOT NULL,
        "sha_inicio" TEXT,
        "sha_fim" TEXT,
        "comandos" TEXT,
        "telas" TEXT,
        "transcript_path" TEXT,
        ${COLUNAS_TEMPO},
        ${checkMinimo('etapa', 'n', 1)},
        ${checkMinimo('etapa', 'ciclo', 0)},
        ${checkEnum('etapa', 'tipo', valoresDe(TipoEtapa))},
        ${checkEnum('etapa', 'papel', valoresDe(PapelAgente))},
        ${checkEnum('etapa', 'estado', valoresDe(EstadoEtapa))},
        ${checkEnum('etapa', 'motivo_fim', valoresDe(MotivoFimEtapa))},
        ${checkBool('etapa', 'retomada')},
        ${checkBool('etapa', 'condutor_editou')},
        ${checkMinimo('etapa', 'custo_micro_usd', 0)},
        ${[
          'perfil',
          'init',
          'model_usage',
          'subagent_stats',
          'permission_denials',
          'comandos',
          'telas',
        ]
          .map((c) => checkJson('etapa', c))
          .join(',\n        ')},
        CONSTRAINT "ck_etapa_do_app" CHECK ("tipo" NOT IN ('verificar', 'evidenciar', 'integrar') OR ("papel" IS NULL AND "session_id" IS NULL))
      )
    `);
    await qr.query(`CREATE UNIQUE INDEX "ux_etapa_execucao_n" ON "etapa" ("execucao_id", "n")`);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_etapa_sessao_executando" ON "etapa" ("session_id") WHERE "estado" = 'executando' AND "session_id" IS NOT NULL`,
    );
    await qr.query(`CREATE INDEX "ix_etapa_estado" ON "etapa" ("estado")`);

    await qr.query(`
      CREATE TABLE "evento" (
        "seq" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "execucao_id" TEXT REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "etapa_id" TEXT REFERENCES "etapa" ("id"),
        "origem" TEXT NOT NULL,
        "tipo" TEXT NOT NULL,
        "nivel" TEXT NOT NULL,
        "papel_agente" TEXT,
        "parent_tool_use_id" TEXT,
        "resumo" TEXT NOT NULL,
        "payload" TEXT,
        "linha_bruta" INTEGER,
        "criado_em" TEXT NOT NULL,
        ${checkEnum('evento', 'origem', valoresDe(OrigemEvento))},
        ${checkEnum('evento', 'nivel', valoresDe(NivelEvento))},
        ${checkEnum('evento', 'papel_agente', valoresDe(PapelAgente))},
        ${checkJson('evento', 'payload')}
      )
    `);
    await qr.query(`CREATE INDEX "ix_evento_execucao_seq" ON "evento" ("execucao_id", "seq")`);
    await qr.query(`CREATE INDEX "ix_evento_etapa_seq" ON "evento" ("etapa_id", "seq")`);

    await qr.query(`
      CREATE TABLE "artefato" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "execucao_id" TEXT NOT NULL REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "etapa_id" TEXT REFERENCES "etapa" ("id"),
        "tipo" TEXT NOT NULL,
        "versao" INTEGER NOT NULL,
        "contrato" TEXT,
        "conteudo" TEXT,
        "caminho" TEXT,
        "sha256" TEXT NOT NULL,
        "tamanho_bytes" INTEGER NOT NULL,
        "sha_git" TEXT,
        "patch_id" TEXT,
        "editado_por_humano" INTEGER NOT NULL,
        ${COLUNAS_TEMPO},
        ${checkEnum('artefato', 'tipo', valoresDe(TipoArtefato))},
        ${checkMinimo('artefato', 'versao', 1)},
        ${checkMinimo('artefato', 'tamanho_bytes', 0)},
        ${checkBool('artefato', 'editado_por_humano')},
        ${checkJson('artefato', 'conteudo')},
        CONSTRAINT "ck_artefato_conteudo_ou_caminho" CHECK ("conteudo" IS NOT NULL OR "caminho" IS NOT NULL),
        CONSTRAINT "ck_artefato_patch_id_diff" CHECK ("patch_id" IS NULL OR "tipo" = 'diff')
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_artefato_versao" ON "artefato" ("execucao_id", "tipo", "versao")`,
    );
    await qr.query(`CREATE INDEX "ix_artefato_etapa" ON "artefato" ("etapa_id")`);

    await qr.query(`
      CREATE TABLE "comentario" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "execucao_id" TEXT NOT NULL REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "artefato_id" TEXT REFERENCES "artefato" ("id"),
        "alvo" TEXT NOT NULL,
        "arquivo" TEXT,
        "linha" INTEGER,
        "texto" TEXT NOT NULL,
        "ciclo_destino" INTEGER NOT NULL,
        "consumido_em" TEXT,
        ${COLUNAS_TEMPO},
        ${checkEnum('comentario', 'alvo', valoresDe(AlvoComentario))},
        ${checkMinimo('comentario', 'linha', 1)},
        ${checkMinimo('comentario', 'ciclo_destino', 0)}
      )
    `);
    await qr.query(
      `CREATE INDEX "ix_comentario_execucao" ON "comentario" ("execucao_id", "ciclo_destino")`,
    );

    await qr.query(`
      CREATE TABLE "aprovacao" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "execucao_id" TEXT NOT NULL REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "tipo" TEXT NOT NULL,
        "decisao" TEXT NOT NULL,
        "artefato_id" TEXT REFERENCES "artefato" ("id"),
        "patch_id" TEXT,
        "sha" TEXT,
        "texto_resposta" TEXT,
        "validacao_resposta" TEXT,
        "aprovado_sem_prints" INTEGER NOT NULL,
        "politica_status" TEXT,
        "comentario" TEXT,
        "ciente_mensagem_id" TEXT,
        "em_bloco" INTEGER NOT NULL,
        "lote_id" TEXT REFERENCES "lote" ("id") ON DELETE RESTRICT,
        "invalidada_em" TEXT,
        "motivo_invalidacao" TEXT,
        ${COLUNAS_TEMPO},
        ${checkEnum('aprovacao', 'tipo', valoresDe(TipoAprovacao))},
        ${checkEnum('aprovacao', 'decisao', valoresDe(DecisaoAprovacao))},
        ${checkEnum('aprovacao', 'politica_status', valoresDe(PoliticaStatus))},
        ${checkBool('aprovacao', 'aprovado_sem_prints')},
        ${checkBool('aprovacao', 'em_bloco')},
        ${checkJson('aprovacao', 'validacao_resposta')},
        CONSTRAINT "ck_aprovacao_final_patch" CHECK ("tipo" NOT IN ('final', 'reaprovacao') OR ("patch_id" IS NOT NULL AND "sha" IS NOT NULL AND "em_bloco" = 0)),
        CONSTRAINT "ck_aprovacao_sem_prints" CHECK ("aprovado_sem_prints" = 0 OR "tipo" IN ('final', 'reaprovacao')),
        CONSTRAINT "ck_aprovacao_em_bloco" CHECK ("em_bloco" = 0 OR ("tipo" = 'plano' AND "lote_id" IS NOT NULL))
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_aprovacao_vigente" ON "aprovacao" ("execucao_id") WHERE ${SQL_APROVACAO_VIGENTE}`,
    );
    await qr.query(
      `CREATE INDEX "ix_aprovacao_execucao" ON "aprovacao" ("execucao_id", "criado_em")`,
    );

    await qr.query(`
      CREATE TABLE "item_fila_merge" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "projeto_id" TEXT NOT NULL REFERENCES "projeto" ("id") ON DELETE RESTRICT,
        "branch_destino" TEXT NOT NULL,
        "execucao_id" TEXT NOT NULL REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "aprovacao_id" TEXT NOT NULL REFERENCES "aprovacao" ("id"),
        "ordem" INTEGER NOT NULL,
        "estado" TEXT NOT NULL,
        "motivo" TEXT,
        "tentativas_conflito" INTEGER NOT NULL,
        "sha_destino_antes" TEXT,
        "sha_integrado" TEXT,
        "patch_id_integrado" TEXT,
        "arquivos_em_conflito" TEXT,
        "modo_avanco" TEXT,
        "push_em" TEXT,
        "copia_local_atras" INTEGER NOT NULL,
        "worktree_integracao_dir" TEXT,
        ${COLUNAS_TEMPO},
        ${checkEnum('item_fila_merge', 'estado', valoresDe(EstadoItemFilaMerge))},
        ${checkEnum('item_fila_merge', 'modo_avanco', valoresDe(ModoAvancoRef))},
        ${checkMinimo('item_fila_merge', 'tentativas_conflito', 0)},
        ${checkBool('item_fila_merge', 'copia_local_atras')},
        ${checkJson('item_fila_merge', 'arquivos_em_conflito')}
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_item_fila_execucao_ativo" ON "item_fila_merge" ("execucao_id") WHERE ${SQL_ITEM_FILA_ATIVO}`,
    );
    await qr.query(
      `CREATE UNIQUE INDEX "ux_item_fila_processando" ON "item_fila_merge" ("projeto_id", "branch_destino") WHERE ${SQL_ITEM_FILA_PROCESSANDO}`,
    );
    await qr.query(
      `CREATE INDEX "ix_item_fila_ordem" ON "item_fila_merge" ("projeto_id", "branch_destino", "estado", "ordem")`,
    );

    await qr.query(`
      CREATE TABLE "outbox_chamado" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "execucao_id" TEXT NOT NULL REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "passo" TEXT NOT NULL,
        "estado" TEXT NOT NULL,
        "rodada" INTEGER NOT NULL,
        "ordem" INTEGER NOT NULL,
        "corpo" TEXT,
        "corpo_hash" TEXT,
        "status_alvo" TEXT,
        "motivo" TEXT,
        "tentativas" INTEGER NOT NULL,
        "proxima_em" TEXT,
        "ultimo_http" INTEGER,
        "erro" TEXT,
        "id_remoto" TEXT,
        "enviado_em" TEXT,
        ${COLUNAS_TEMPO},
        ${checkEnum('outbox_chamado', 'passo', valoresDe(PassoOutbox))},
        ${checkEnum('outbox_chamado', 'estado', valoresDe(EstadoOutbox))},
        ${checkMinimo('outbox_chamado', 'rodada', 0)},
        ${checkMinimo('outbox_chamado', 'ordem', 0)},
        ${checkMinimo('outbox_chamado', 'tentativas', 0)}
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_outbox_passo_rodada" ON "outbox_chamado" ("execucao_id", "passo", "rodada")`,
    );
    await qr.query(
      `CREATE INDEX "ix_outbox_estado_proxima" ON "outbox_chamado" ("estado", "proxima_em")`,
    );

    await qr.query(`
      CREATE TABLE "uso_assinatura" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "etapa_id" TEXT REFERENCES "etapa" ("id") ON DELETE SET NULL,
        "utilizacao_5h" REAL,
        "utilizacao_7d" REAL,
        "reinicia_5h_em" TEXT,
        "reinicia_7d_em" TEXT,
        "status" TEXT,
        "status_overage" TEXT,
        "usando_creditos_extras" INTEGER,
        "bruto" TEXT NOT NULL,
        "criado_em" TEXT NOT NULL,
        ${checkMinimo('uso_assinatura', 'utilizacao_5h', 0)},
        ${checkMinimo('uso_assinatura', 'utilizacao_7d', 0)},
        ${checkEnum('uso_assinatura', 'status', valoresDe(StatusCota))},
        ${checkBool('uso_assinatura', 'usando_creditos_extras')},
        ${checkJson('uso_assinatura', 'bruto')}
      )
    `);
    await qr.query(`CREATE INDEX "ix_uso_assinatura_criado" ON "uso_assinatura" ("criado_em")`);

    await qr.query(`
      CREATE TABLE "sessao_terminal" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "tipo" TEXT NOT NULL,
        "cwd" TEXT NOT NULL,
        "execucao_id" TEXT REFERENCES "execucao" ("id") ON DELETE CASCADE,
        "etapa_id" TEXT REFERENCES "etapa" ("id"),
        "session_id_claude" TEXT,
        "pid" INTEGER,
        "pgid" INTEGER,
        "aberta_em" TEXT NOT NULL,
        "encerrada_em" TEXT,
        "sha_ao_devolver" TEXT,
        ${COLUNAS_TEMPO},
        ${checkEnum('sessao_terminal', 'tipo', valoresDe(TipoSessaoTerminal))},
        CONSTRAINT "ck_sessao_terminal_assumida" CHECK ("tipo" <> 'assumida' OR ("execucao_id" IS NOT NULL AND "etapa_id" IS NOT NULL AND "session_id_claude" IS NOT NULL))
      )
    `);
    await qr.query(
      `CREATE UNIQUE INDEX "ux_sessao_terminal_assumida_aberta" ON "sessao_terminal" ("session_id_claude") WHERE "encerrada_em" IS NULL AND "tipo" = 'assumida' AND "session_id_claude" IS NOT NULL`,
    );

    await conferirChavesEstrangeiras(qr);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // O DROP faz um DELETE implícito que conferiria FKs a cada tabela (há a
    // referência circular execucao ⇄ aprovacao); adiadas, a conferência fica para
    // o COMMIT, quando já não resta nenhuma das tabelas.
    await qr.query('PRAGMA defer_foreign_keys = ON');
    for (const tabela of [
      'sessao_terminal',
      'uso_assinatura',
      'outbox_chamado',
      'item_fila_merge',
      'evento',
      'comentario',
      'etapa',
      'aprovacao',
      'artefato',
      'execucao',
      'lote',
      'chamado_cache',
      'mapeamento_sistema',
      'projeto',
      'conexao_chamados',
    ]) {
      await qr.query(`DROP TABLE IF EXISTS "${tabela}"`);
    }
  }
}
