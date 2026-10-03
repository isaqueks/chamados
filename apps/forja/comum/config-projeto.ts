import { z } from 'zod';
import type {
  AvancadoProjetoDto,
  ConfigProjetoDto,
  ConfigResolvidaDto,
  ConfiguracoesGlobaisDto,
  ProjetoDetectadoDto,
} from './dto';
import { EstrategiaIntegracao, GatePlano, ModoEntrega, PoliticaStatus, valores } from './estados';

/**
 * Configuração de projeto (specs/forja/02 §4.2; FJ-030 §1, §2).
 *
 * Desde FJ-030 ("muitas configurações; deixe automático") há TRÊS formas:
 *
 * - `ConfigProjeto` (v2): o que o humano decide — pasta do repositório (único
 *   campo obrigatório), nome, branch e sistemas opcionais, e um `avancado`
 *   recolhido, todo opcional, editado como texto.
 * - `ConfiguracoesGlobais`: modelos, cota, concorrência, limites e gates, uma
 *   vez só para a máquina (`<dados>/configuracoes.json`).
 * - `ConfigResolvida`: projeto + globais + autodetecção do repositório. É a
 *   forma que o domínio sempre consumiu e o `execucao.config_snapshot` (F-05):
 *   uma execução iniciada não muda se o humano mexer depois.
 *
 * POR QUE aqui (`comum/`): os schemas são o contrato com a SPA (que valida o
 * texto do "Avançado" com o MESMO zod) e o formato das colunas JSON (02 §1:
 * leitura de coluna JSON sempre passa pelo zod — fora do formato é erro
 * explícito, nunca default silencioso). `resolverConfig` é puro: o servidor
 * resolve com o detectado do disco; a tela pode prever o efeito do Avançado.
 */

/** `projeto.config_versao`. Mudança incompatível = versão nova + migração dos dados gravados. */
export const CONFIG_PROJETO_VERSAO = 2;

/** Prefixo fixo das branches da Forja (F-09). */
export const PREFIXO_BRANCH_PADRAO = 'forja/';

const Inteiro = (min: number) => z.number().int().min(min);
const Fracao = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Seções (formas do snapshot resolvido)
// ---------------------------------------------------------------------------

/**
 * Script do projeto = DICA ao agente (FJ-032): a Forja nunca o executa. O
 * `rapido` de antes (linha de base) é aceito num Avançado/snapshot antigo e
 * descartado.
 */
export const ComandoProjetoSchema = z
  .object({
    nome: z.string().min(1).max(60),
    comando: z.string().min(1),
    timeout_s: Inteiro(1),
    rapido: z.unknown().optional(),
  })
  .transform(({ rapido: _r, ...c }) => c);

export const ComandoSimplesSchema = z.object({
  comando: z.string().min(1),
  timeout_s: Inteiro(1),
});

const EsforcoSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const ModeloEsforcoSchema = z.object({ modelo: z.string().min(1), esforco: z.string().min(1) });

export const RepoProjetoSchema = z.object({
  dir: z.string().startsWith('/'),
  remoto: z.string().min(1).nullable(),
  branch_destino: z.string().min(1),
  prefixo_branch: z.string().min(1),
});

export const EntregaProjetoSchema = z.object({
  modo: z.enum(valores(ModoEntrega)),
  estrategia: z.enum(valores(EstrategiaIntegracao)),
  merge_publica: z.boolean(),
  avanco_com_copia_suja: z.enum(['push_direto', 'bloquear']),
});

export const PoliticaStatusProjetoSchema = z.object({
  ao_concluir: z.enum(valores(PoliticaStatus)),
  motivo: z.string().min(1),
});

const HealthcheckSchema = z.object({
  caminho: z.string().startsWith('/'),
  status: Inteiro(100),
  timeout_s: Inteiro(1),
});

/**
 * Comandos do projeto = DICAS para o agente (FJ-032): vão ao prompt como
 * "scripts encontrados"; o app não roda `setup`, verificação, e2e nem sobe o app.
 */
export const ComandosProjetoSchema = z.object({
  dependencias: z.literal('instalar'),
  setup: ComandoSimplesSchema.nullable(),
  verificacao: z.array(ComandoProjetoSchema),
  e2e: ComandoSimplesSchema.nullable(),
  app_subir: ComandoSimplesSchema.nullable(),
  healthcheck: HealthcheckSchema.nullable(),
});

export const ArquivoLocalSchema = z.object({
  origem: z.string().min(1),
  destino: z.string().min(1),
  modo: z.literal('copiar'),
});
export const ArquivosLocaisSchema = z.array(ArquivoLocalSchema);

export const DetectoresSchema = z.object({
  banco: z.array(z.string()),
  regra_negocio: z.array(z.string()),
  sensivel: z.array(z.string()),
  docs_exigidas: z.array(z.string()),
  frontend: z.array(z.string()),
});

export const ModelosProjetoSchema = z.object({
  planejador: ModeloEsforcoSchema,
  condutor: ModeloEsforcoSchema,
  subagentes: z.object({
    modelo: z.string().min(1),
    esforco_implementador: z.string().min(1),
    esforco_revisor: z.string().min(1),
  }),
});

const ConcorrenciaSchema = z.object({
  agentes: Inteiro(1),
  planejadores: Inteiro(1),
  schema_em_voo: Inteiro(1),
});
const CiclosSchema = z.object({
  max_auto: Inteiro(0),
  max_total: Inteiro(1),
});
const OrcamentoSchema = z.object({
  planejar: z.number().positive(),
  implementar: z.number().positive(),
  revisar: z.number().positive(),
  relatar: z.number().positive(),
  por_chamado: z.number().positive(),
});
const TimeoutsSchema = z.object({
  planejar: Inteiro(1),
  implementar: Inteiro(1),
  revisar: Inteiro(1),
  relatar: Inteiro(1),
  aviso_inatividade: Inteiro(1),
});
const FreioCotaSchema = z.object({
  five_hour: Fracao,
  seven_day: Fracao,
  permitir_creditos_extras: z.boolean(),
});

export const LimitesProjetoSchema = z.object({
  concorrencia: ConcorrenciaSchema,
  ciclos: CiclosSchema,
  orcamento_usd: OrcamentoSchema,
  timeout_min: TimeoutsSchema,
  freio_cota: FreioCotaSchema,
});

/**
 * Gates (FJ-034, 2026-10-03): só o do plano é configurável. `exigir_prints_ui` e
 * `exigir_ciente_mensagem_nova` saíram — o G2 não tem exigências, só avisos —;
 * num `avancado`/`configuracoes.json`/snapshot antigo são aceitas e descartadas.
 */
export const GatesProjetoSchema = z.object({
  plano: z.enum(valores(GatePlano)),
});

export const ModoReforcadoSchema = z.object({
  ligado: z.boolean(),
  sandbox: z.object({ allow_read_extra: z.array(z.string()) }),
  rede_agente: z.array(z.string()),
  verificacao_bwrap: z.boolean(),
});

export const RetencaoProjetoSchema = z.object({
  worktree_descartada_dias: Inteiro(1),
  worktree_falha_dias: Inteiro(1),
  eventos_brutos_dias: Inteiro(1),
  evidencias_dias: Inteiro(1),
});

/**
 * Snapshot resolvido (`execucao.config_snapshot`). Snapshots gravados antes de
 * FJ-030 ainda trazem `evidencias` (captura pelo app): o zod (não estrito)
 * descarta a chave na leitura, e o resto da forma é a mesma.
 */
export const ConfigResolvidaSchema = z.object({
  repo: RepoProjetoSchema,
  entrega: EntregaProjetoSchema,
  politica_status: PoliticaStatusProjetoSchema,
  comandos: ComandosProjetoSchema,
  arquivos_locais: ArquivosLocaisSchema,
  detectores: DetectoresSchema,
  modelos: ModelosProjetoSchema,
  limites: LimitesProjetoSchema,
  gates: GatesProjetoSchema,
  modo_reforcado: ModoReforcadoSchema,
  retencao: RetencaoProjetoSchema,
}) satisfies z.ZodType<ConfigResolvidaDto>;
export type ConfigResolvida = z.infer<typeof ConfigResolvidaSchema>;

// ---------------------------------------------------------------------------
// Projeto v2 (FJ-030 §1)
// ---------------------------------------------------------------------------

/**
 * Chave removida por FJ-031 (a Forja não silencia/reativa a IA do servidor nem
 * a usa como pré-condição): aceita num `avancado` antigo e descartada.
 */
const ObsoletaFJ031 = z.unknown().optional();

/**
 * Chaves removidas por FJ-032 (a Forja não executa comandos do projeto: sem
 * semáforo de verificações nem correções de verificação): aceitas num
 * `avancado`/`configuracoes.json` antigo e descartadas.
 */
const ObsoletaFJ032 = z.unknown().optional();

/** Chaves removidas por FJ-034 (G2 sem exigências): aceitas e descartadas. */
const ObsoletaFJ034 = z.unknown().optional();

/**
 * `avancado`: tudo opcional e ESTRITO — é texto digitado pelo humano, e um
 * erro de digitação ignorado em silêncio seria pior que o erro na hora.
 */
export const AvancadoProjetoSchema = z
  .object({
    repo: z
      .object({
        remoto: z.string().min(1).nullable().optional(),
        prefixo_branch: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    comandos: ComandosProjetoSchema.partial().strict().optional(),
    detectores: DetectoresSchema.partial().strict().optional(),
    arquivos_locais: ArquivosLocaisSchema.optional(),
    entrega: EntregaProjetoSchema.partial().strict().optional(),
    politica_status: PoliticaStatusProjetoSchema.partial()
      .extend({ reativar_ia_ao_concluir: ObsoletaFJ031 })
      .strict()
      .transform(({ reativar_ia_ao_concluir: _o, ...p }) => p)
      .optional(),
    gates: GatesProjetoSchema.partial()
      .extend({
        pre_condicao_ia_silenciada: ObsoletaFJ031,
        exigir_prints_ui: ObsoletaFJ034,
        exigir_ciente_mensagem_nova: ObsoletaFJ034,
      })
      .strict()
      .transform(
        ({
          pre_condicao_ia_silenciada: _o,
          exigir_prints_ui: _p,
          exigir_ciente_mensagem_nova: _c,
          ...g
        }) => g,
      )
      .optional(),
    limites: z
      .object({
        concorrencia: ConcorrenciaSchema.partial()
          .extend({ verificacoes: ObsoletaFJ032 })
          .strict()
          .transform(({ verificacoes: _o, ...c }) => c)
          .optional(),
        ciclos: CiclosSchema.partial()
          .extend({ max_correcoes_verificacao: ObsoletaFJ032 })
          .strict()
          .transform(({ max_correcoes_verificacao: _o, ...c }) => c)
          .optional(),
        orcamento_usd: OrcamentoSchema.partial().strict().optional(),
        timeout_min: TimeoutsSchema.partial().strict().optional(),
        freio_cota: FreioCotaSchema.partial().strict().optional(),
      })
      .strict()
      .optional(),
    modo_reforcado: z
      .object({
        ligado: z.boolean().optional(),
        sandbox: z
          .object({ allow_read_extra: z.array(z.string()).optional() })
          .strict()
          .optional(),
        rede_agente: z.array(z.string()).optional(),
        verificacao_bwrap: z.boolean().optional(),
      })
      .strict()
      .optional(),
    retencao: RetencaoProjetoSchema.partial().strict().optional(),
  })
  .strict() satisfies z.ZodType<AvancadoProjetoDto>;
export type AvancadoProjeto = z.infer<typeof AvancadoProjetoSchema>;

/** Último segmento do caminho (sem `node:path`: este módulo também roda na SPA). */
export function nomeDaPasta(dir: string): string {
  const partes = dir.replace(/\/+$/, '').split('/');
  return partes[partes.length - 1] || dir;
}

/**
 * Projeto v2. Entrada tolerante (`versao` e `nome` podem faltar: o nome vira o
 * da pasta); saída sempre completa.
 */
export const ConfigProjetoSchema = z
  .object({
    versao: z.literal(CONFIG_PROJETO_VERSAO).optional(),
    nome: z.string().trim().max(80).optional(),
    repo_dir: z.string().trim().startsWith('/', 'use o caminho absoluto da pasta'),
    branch_destino: z.string().trim().min(1).optional(),
    sistemas: z.array(z.string().min(1)).optional(),
    avancado: AvancadoProjetoSchema.optional(),
  })
  .transform((c): ConfigProjetoDto => ({
    versao: CONFIG_PROJETO_VERSAO,
    nome: c.nome || nomeDaPasta(c.repo_dir),
    repo_dir: c.repo_dir.replace(/(.)\/+$/, '$1'),
    ...(c.branch_destino ? { branch_destino: c.branch_destino } : {}),
    ...(c.sistemas ? { sistemas: [...new Set(c.sistemas)] } : {}),
    ...(c.avancado && Object.keys(c.avancado).length > 0 ? { avancado: c.avancado } : {}),
  })) satisfies z.ZodType<ConfigProjetoDto, unknown>;
export type ConfigProjeto = ConfigProjetoDto;

// ---------------------------------------------------------------------------
// Configurações globais (FJ-030 §2)
// ---------------------------------------------------------------------------

/**
 * Cada folha tem default (`prefault` nos objetos: o default PASSA pelo zod e
 * preenche as folhas): um `configuracoes.json` antigo, parcial ou `{}` vira a
 * configuração completa, e campo novo numa versão futura não quebra o arquivo.
 */
export const ConfiguracoesGlobaisSchema = z
  .object({
    versao: z.literal(1).default(1),
    modelos: z
      .object({
        orquestrador: z
          .object({
            modelo: z.string().min(1).default('claude-fable-5-1'),
            esforco: EsforcoSchema.default('high'),
          })
          .prefault({}),
        subagentes: z
          .object({
            modelo: z.string().min(1).default('claude-opus-5-5'),
            esforco: EsforcoSchema.default('high'),
          })
          .prefault({}),
      })
      .prefault({}),
    cota: z
      .object({
        five_hour: Fracao.default(0.8),
        seven_day: Fracao.default(0.9),
        permitir_creditos_extras: z.boolean().default(false),
      })
      .prefault({}),
    concorrencia: z
      .object({
        implementacoes: Inteiro(1).default(2),
        planejadores: Inteiro(1).default(3),
      })
      .prefault({}),
    limites: z
      .object({
        ciclos: z
          .object({
            max_auto: Inteiro(0).default(2),
            max_total: Inteiro(1).default(5),
          })
          .prefault({}),
        orcamento_usd: z
          .object({
            planejar: z.number().positive().default(5),
            implementar: z.number().positive().default(25),
            revisar: z.number().positive().default(10),
            relatar: z.number().positive().default(2),
            por_chamado: z.number().positive().default(40),
          })
          .prefault({}),
        timeout_min: z
          .object({
            planejar: Inteiro(1).default(15),
            implementar: Inteiro(1).default(90),
            revisar: Inteiro(1).default(45),
            relatar: Inteiro(1).default(5),
            aviso_inatividade: Inteiro(1).default(15),
          })
          .prefault({}),
      })
      .prefault({}),
    gates: z
      .object({
        // FJ-034: G1 desligado por padrão; em `nunca` só `alertas_seguranca` para.
        plano: z.enum(valores(GatePlano)).default('nunca'),
      })
      .prefault({}),
  })
  .refine((c) => c.limites.ciclos.max_auto <= c.limites.ciclos.max_total, {
    message: 'ciclos automáticos não podem passar do total',
    path: ['limites', 'ciclos', 'max_auto'],
  }) satisfies z.ZodType<ConfiguracoesGlobaisDto, unknown>;
export type ConfiguracoesGlobais = ConfiguracoesGlobaisDto;

export function configuracoesGlobaisPadrao(): ConfiguracoesGlobais {
  return ConfiguracoesGlobaisSchema.parse({});
}

// ---------------------------------------------------------------------------
// Autodetecção (forma; quem detecta é `server/projetos/autodeteccao.ts`)
// ---------------------------------------------------------------------------

export const ProjetoDetectadoSchema = z.object({
  detectado_em: z.string(),
  repo_dir: z.string(),
  branch_destino: z.string().nullable(),
  origem_branch: z.enum(['origin_head', 'main', 'master', 'atual']).nullable(),
  remoto: z.string().nullable(),
  gerenciador: z.enum(['npm', 'pnpm', 'yarn', 'bun']).nullable(),
  lockfile: z.string().nullable(),
  workspaces: z.boolean(),
  comandos: ComandosProjetoSchema,
  detectores: DetectoresSchema,
  arquivos_locais: ArquivosLocaisSchema,
  avisos: z.array(z.string()),
}) satisfies z.ZodType<ProjetoDetectadoDto>;
export type ProjetoDetectado = z.infer<typeof ProjetoDetectadoSchema>;

/** Detectores por convenção (FJ-030 §1): valem quando o projeto não sobrescreve no Avançado. */
export const DETECTORES_CONVENCAO: ProjetoDetectado['detectores'] = {
  banco: ['**/migrations/**', '**/*.entity.*', '**/schema.prisma', '**/*.sql', '**/drizzle/**'],
  frontend: ['**/*.{tsx,jsx,vue,svelte,css,scss}', '**/components/**', '**/app/**/page.*'],
  sensivel: [
    'package.json',
    '**/package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    '.github/**',
    '.husky/**',
    '.claude/**',
    'Dockerfile*',
    '**/Dockerfile*',
    '**/auth/**',
  ],
  regra_negocio: [
    '**/services/**',
    '**/servicos/**',
    '**/*-service.*',
    '**/domain/**',
    '**/dominio/**',
  ],
  docs_exigidas: [],
};

/** Detecção vazia (repositório ainda não lido): comandos nenhum, detectores por convenção. */
export function detectadoVazio(repoDir: string, aviso?: string): ProjetoDetectado {
  return {
    detectado_em: new Date(0).toISOString(),
    repo_dir: repoDir,
    branch_destino: null,
    origem_branch: null,
    remoto: null,
    gerenciador: null,
    lockfile: null,
    workspaces: false,
    comandos: {
      dependencias: 'instalar',
      setup: null,
      verificacao: [],
      e2e: null,
      app_subir: null,
      healthcheck: null,
    },
    detectores: structuredClone(DETECTORES_CONVENCAO),
    arquivos_locais: [],
    avisos: aviso ? [aviso] : [],
  };
}

// ---------------------------------------------------------------------------
// Resolução (FJ-030 §1): projeto + globais + detectado → snapshot
// ---------------------------------------------------------------------------

/** Padrões fixos do que não é global nem detectado (02 §6: U-1, U-2, U-3, retenção). */
const ENTREGA_PADRAO: ConfigResolvida['entrega'] = {
  modo: 'merge_e_push',
  estrategia: 'merge_no_ff',
  merge_publica: false,
  avanco_com_copia_suja: 'push_direto',
};
const POLITICA_PADRAO: ConfigResolvida['politica_status'] = {
  ao_concluir: 'resolvido',
  motivo: 'implementado_via_forja',
};
const MODO_REFORCADO_PADRAO: ConfigResolvida['modo_reforcado'] = {
  ligado: false,
  sandbox: { allow_read_extra: ['~/.nvm', '~/.npm'] },
  rede_agente: [],
  verificacao_bwrap: true,
};
const RETENCAO_PADRAO: ConfigResolvida['retencao'] = {
  worktree_descartada_dias: 7,
  worktree_falha_dias: 7,
  eventos_brutos_dias: 90,
  evidencias_dias: 90,
};
const BRANCH_FALLBACK = 'main';

/** Sobrepõe só as chaves PRESENTES (`undefined` não apaga o valor de baixo). */
function sobrepor<T extends object>(base: T, extra: Partial<T> | undefined): T {
  if (!extra) return base;
  const saida = { ...base };
  for (const [k, v] of Object.entries(extra) as [keyof T, T[keyof T] | undefined][]) {
    if (v !== undefined) saida[k] = v;
  }
  return saida;
}

/**
 * Snapshot completo de uma execução (ou do bloco "Detectado"): o Avançado do
 * projeto vence as globais, que vencem a autodetecção, que vence os padrões.
 * Sem remoto detectado nem configurado, a entrega cai em `merge_local` (nada a
 * empurrar) — o CHECK `ck_projeto_remoto` de antes virou regra de resolução.
 */
export function resolverConfig(
  projeto: Pick<ConfigProjeto, 'repo_dir' | 'branch_destino' | 'avancado'>,
  globais: ConfiguracoesGlobais,
  detectado: ProjetoDetectado,
): ConfigResolvida {
  const av: AvancadoProjeto = projeto.avancado ?? {};
  const remoto = av.repo?.remoto !== undefined ? av.repo.remoto : detectado.remoto;
  const entrega = sobrepor(
    { ...ENTREGA_PADRAO, modo: remoto ? ENTREGA_PADRAO.modo : 'merge_local' },
    av.entrega,
  );
  if (!remoto && entrega.modo !== 'merge_local') entrega.modo = 'merge_local';
  const g = globais;
  const limitesAv = av.limites ?? {};
  return {
    repo: {
      dir: projeto.repo_dir,
      remoto,
      branch_destino: projeto.branch_destino ?? detectado.branch_destino ?? BRANCH_FALLBACK,
      prefixo_branch: av.repo?.prefixo_branch ?? PREFIXO_BRANCH_PADRAO,
    },
    entrega,
    politica_status: sobrepor(POLITICA_PADRAO, av.politica_status),
    comandos: sobrepor(detectado.comandos, av.comandos),
    arquivos_locais: av.arquivos_locais ?? detectado.arquivos_locais,
    detectores: sobrepor(detectado.detectores, av.detectores),
    modelos: {
      planejador: { ...g.modelos.orquestrador },
      condutor: { ...g.modelos.orquestrador },
      subagentes: {
        modelo: g.modelos.subagentes.modelo,
        esforco_implementador: g.modelos.subagentes.esforco,
        esforco_revisor: g.modelos.subagentes.esforco,
      },
    },
    limites: {
      concorrencia: sobrepor(
        {
          agentes: g.concorrencia.implementacoes,
          planejadores: g.concorrencia.planejadores,
          schema_em_voo: 1,
        },
        limitesAv.concorrencia,
      ),
      ciclos: sobrepor(g.limites.ciclos, limitesAv.ciclos),
      orcamento_usd: sobrepor(g.limites.orcamento_usd, limitesAv.orcamento_usd),
      timeout_min: sobrepor(g.limites.timeout_min, limitesAv.timeout_min),
      freio_cota: sobrepor(g.cota, limitesAv.freio_cota),
    },
    gates: sobrepor(g.gates, av.gates),
    modo_reforcado: {
      ...sobrepor(MODO_REFORCADO_PADRAO, {
        ligado: av.modo_reforcado?.ligado,
        rede_agente: av.modo_reforcado?.rede_agente,
        verificacao_bwrap: av.modo_reforcado?.verificacao_bwrap,
      }),
      sandbox: {
        allow_read_extra:
          av.modo_reforcado?.sandbox?.allow_read_extra ??
          MODO_REFORCADO_PADRAO.sandbox.allow_read_extra,
      },
    },
    retencao: sobrepor(RETENCAO_PADRAO, av.retencao),
  };
}

/**
 * Snapshot com os padrões e NADA detectado (sem comandos, detectores vazios):
 * a base dos testes e de quem precisa de uma configuração neutra para um
 * `repo` conhecido (o antigo `configProjetoPadrao`).
 */
export function configResolvidaPadrao(repo: ConfigResolvida['repo']): ConfigResolvida {
  const vazio = detectadoVazio(repo.dir);
  const c = resolverConfig(
    {
      repo_dir: repo.dir,
      branch_destino: repo.branch_destino,
      avancado: { repo: { remoto: repo.remoto, prefixo_branch: repo.prefixo_branch } },
    },
    configuracoesGlobaisPadrao(),
    {
      ...vazio,
      detectores: { banco: [], regra_negocio: [], sensivel: [], docs_exigidas: [], frontend: [] },
    },
  );
  return c;
}

/**
 * Projeto v2 que resolve EXATAMENTE para `r` (salvo `modelos`, que são
 * globais): tudo vai para `avancado`. Para testes e scripts que já têm a
 * configuração completa em mãos; o cadastro de verdade usa o mínimo.
 */
export function configProjetoDeResolvida(nome: string, r: ConfigResolvida): ConfigProjeto {
  return {
    versao: CONFIG_PROJETO_VERSAO,
    nome,
    repo_dir: r.repo.dir,
    branch_destino: r.repo.branch_destino,
    avancado: {
      repo: { remoto: r.repo.remoto, prefixo_branch: r.repo.prefixo_branch },
      comandos: r.comandos,
      detectores: r.detectores,
      arquivos_locais: r.arquivos_locais,
      entrega: r.entrega,
      politica_status: r.politica_status,
      gates: r.gates,
      limites: r.limites,
      modo_reforcado: r.modo_reforcado,
      retencao: r.retencao,
    },
  };
}

// ---------------------------------------------------------------------------
// Migração v1 → v2 (FJ-030; usada pela migration 0002 do SQLite)
// ---------------------------------------------------------------------------

/** Diferença rasa entre `valor` e `padrao`: só o que o projeto v1 tinha de PRÓPRIO. */
function diferenca<T extends object>(valor: T, padrao: T): Partial<T> | undefined {
  const saida: Partial<T> = {};
  for (const k of Object.keys(valor) as (keyof T)[]) {
    if (JSON.stringify(valor[k]) !== JSON.stringify(padrao[k])) saida[k] = valor[k];
  }
  return Object.keys(saida).length > 0 ? saida : undefined;
}

/** Colunas de configuração de um projeto v1 (antes de FJ-030). */
export interface ConfigProjetoV1 {
  repo: { dir: string; remoto: string | null; branch_destino: string; prefixo_branch: string };
  entrega: ConfigResolvida['entrega'];
  politica_status: ConfigResolvida['politica_status'];
  comandos: ConfigResolvida['comandos'];
  arquivos_locais: ConfigResolvida['arquivos_locais'];
  detectores: ConfigResolvida['detectores'];
  limites: ConfigResolvida['limites'];
  gates: ConfigResolvida['gates'];
  modo_reforcado: ConfigResolvida['modo_reforcado'];
  retencao: ConfigResolvida['retencao'];
}

/**
 * v1 → v2 sem perder nada que mude o comportamento: tudo que não é básico e
 * difere do que a v2 resolveria sozinha vai para `avancado` (comandos e
 * arquivos locais configurados à mão, detectores, entrega, política, gates e
 * limites próprios, modo reforçado). `modelos` e `evidencias` saem (FJ-030 §1:
 * modelos são globais; a captura passou ao agente).
 */
export function converterConfigV1(nome: string, v1: ConfigProjetoV1): ConfigProjeto {
  const g = configuracoesGlobaisPadrao();
  const base = resolverConfig(
    { repo_dir: v1.repo.dir, branch_destino: v1.repo.branch_destino },
    g,
    { ...detectadoVazio(v1.repo.dir), remoto: v1.repo.remoto },
  );
  const temComandos =
    v1.comandos.setup !== null ||
    v1.comandos.verificacao.length > 0 ||
    v1.comandos.e2e !== null ||
    v1.comandos.app_subir !== null ||
    v1.comandos.healthcheck !== null;
  const detectoresVazios = Object.values(v1.detectores).every((l) => l.length === 0);
  const limites: NonNullable<AvancadoProjeto['limites']> = {};
  for (const k of [
    'concorrencia',
    'ciclos',
    'orcamento_usd',
    'timeout_min',
    'freio_cota',
  ] as const) {
    const d = diferenca(v1.limites[k], base.limites[k]);
    if (d) (limites as Record<string, unknown>)[k] = d;
  }
  const avancado: AvancadoProjeto = {};
  if (v1.repo.remoto !== 'origin') avancado.repo = { remoto: v1.repo.remoto };
  if (v1.repo.prefixo_branch !== PREFIXO_BRANCH_PADRAO) {
    avancado.repo = { ...avancado.repo, prefixo_branch: v1.repo.prefixo_branch };
  }
  if (temComandos) avancado.comandos = v1.comandos;
  if (v1.arquivos_locais.length > 0) avancado.arquivos_locais = v1.arquivos_locais;
  if (!detectoresVazios) avancado.detectores = v1.detectores;
  const entrega = diferenca(v1.entrega, base.entrega);
  if (entrega) avancado.entrega = entrega;
  const politica = diferenca(v1.politica_status, base.politica_status);
  if (politica) avancado.politica_status = politica;
  const gates = diferenca(v1.gates, base.gates);
  if (gates) avancado.gates = gates;
  if (Object.keys(limites).length > 0) avancado.limites = limites;
  if (JSON.stringify(v1.modo_reforcado) !== JSON.stringify(base.modo_reforcado)) {
    avancado.modo_reforcado = v1.modo_reforcado;
  }
  const retencao = diferenca(v1.retencao, base.retencao);
  if (retencao) avancado.retencao = retencao;
  return {
    versao: CONFIG_PROJETO_VERSAO,
    nome: nome || nomeDaPasta(v1.repo.dir),
    repo_dir: v1.repo.dir,
    branch_destino: v1.repo.branch_destino,
    ...(Object.keys(avancado).length > 0 ? { avancado } : {}),
  };
}
