/**
 * Contrato CANÔNICO da camada de abstração do provider de IA (specs/01 §4.1).
 *
 * Este é o documento da abstração (RF-17): o pipeline de triagem fala APENAS com
 * `AIProvider` e NUNCA importa o SDK concreto. Trocar de engine = escrever outra
 * classe que implemente `AIProvider` e selecioná-la por configuração — sem
 * reescrever o pipeline (specs/01 §4.2, specs/05 §10).
 *
 * Tipos PUROS, ZERO dependências (só reusa os enums canônicos deste pacote).
 * Os NOMES dos campos são EXATOS aos de specs/01 §4.1 — não renomear sem mudar a
 * spec primeiro (a spec é a fonte da verdade). A telemetria usa exatamente
 * `custoUsd`/`duracaoMs`/`tokensEntrada`/`tokensSaida` (specs/01 §4.1, specs/05
 * §10) — gravada em `ExecucaoIA` com esses mesmos nomes.
 */
import type { Natureza, Prioridade, Complexidade, Papel } from './enums';

// ---------------------------------------------------------------------------
// Contexto entregue ao modelo (specs/05 §4.1) — SEM credenciais do sistema-alvo
// ---------------------------------------------------------------------------

/**
 * Mensagem pública da timeline, já SANITIZADA (texto puro, sem HTML cru nem
 * dados sensíveis). A IA vê o autor por papel, não por identidade pessoal.
 */
export interface MensagemPublica {
  id: string;
  /** Papel do autor (cliente/operador/agente_ia) — não expõe PII. */
  autorPapel: Papel;
  /** Corpo em texto puro (projeção do HTML sanitizado). */
  corpo: string;
  /** Timestamp ISO-8601 (UTC). */
  criadaEm: string;
}

/**
 * Metadados do sistema-alvo entregues ao modelo — SEM credenciais (nem DSN, nem
 * caminho de repo cru, nem `*_ref` do cofre). Apenas o que orienta a análise.
 */
export interface MetadadosSistemaAlvo {
  nome: string;
  descricao: string | null;
  /** Resumo de stack (ex.: "bd: postgres · logs: cloudwatch"); pode ser null. */
  stack: string | null;
}

// ---------------------------------------------------------------------------
// Ferramentas read-only (specs/05 §4.2) — handles JÁ escopados, injetados pelo
// worker. O provider recebe FUNÇÕES, nunca conexões/credenciais cruas.
// ---------------------------------------------------------------------------

/** Uma ocorrência de busca no código sincronizado (`repo_buscar`). */
export interface ResultadoBusca {
  caminho: string;
  linha: number;
  trecho: string;
}

/** Filtro da consulta de logs (`logs_consultar`), com janela temporal limitada. */
export interface FiltroLogs {
  desde?: string;
  ate?: string;
  consulta?: string;
  limite?: number;
}

/** Uma linha de log retornada por `logs_consultar`. */
export interface LinhaLog {
  timestamp: string;
  nivel: string | null;
  mensagem: string;
}

/** Uma linha de resultado de `bd_consultar` (SELECT-only). */
export type Linha = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Ferramentas de ESCRITA (specs/05 §6) — presentes SÓ na tentativa de resolução
// automática, quando o GATE do pipeline autorizou. Operam numa working copy
// DESCARTÁVEL (clone do cache → diretório temp), nunca no cache nem em produção.
// O provider apenas ESCREVE arquivos; branch/commit/push/PR são do WORKER (nunca
// do provider — specs/05 §6, specs/09 §4). É por isso que estes handles NÃO
// abrem branch nem PR: essa fronteira fica fora do provider (menor privilégio).
// ---------------------------------------------------------------------------

/**
 * Ferramentas de escrita injetadas pelo worker SÓ quando o gate de resolução
 * automática passou (specs/05 §6). Ausentes no fluxo normal de triagem. Ambas
 * bloqueiam path traversal e o diretório `.git`, e respeitam limites de
 * tamanho/quantidade impostos pelo worker.
 */
export interface FerramentasEscrita {
  /** Sobrescreve (ou cria) um arquivo na working copy descartável. */
  repo_escrever_arquivo(caminho: string, conteudo: string): Promise<void>;
  /** Cria um arquivo novo; falha se o caminho já existir. */
  repo_criar_arquivo(caminho: string, conteudo: string): Promise<void>;
}

export interface AIProviderInput {
  /** Contexto do chamado — SEM credenciais do sistema-alvo. */
  contexto: {
    titulo: string;
    naturezaDeclarada: Natureza;
    /** Apenas mensagens públicas, já sanitizadas. */
    timeline: MensagemPublica[];
    /** Metadados SEM credenciais (nem DSN, nem caminho de repo cru). */
    sistemaAlvo: MetadadosSistemaAlvo;
  };

  /**
   * Handles de ferramentas JÁ escopadas, injetados pelo worker (nunca
   * conexões/credenciais cruas). As quatro primeiras são read-only sobre o
   * sistema-alvo. As de ESCRITA (`repo_escrever_arquivo`/`repo_criar_arquivo`)
   * SÓ existem quando o gate de resolução automática passou (specs/05 §6) —
   * caso contrário são `undefined` e o provider não tem como tentar resolver.
   */
  ferramentas: {
    repo_buscar(consulta: string): Promise<ResultadoBusca[]>;
    repo_ler_arquivo(caminho: string): Promise<string>;
    logs_consultar(filtro: FiltroLogs): Promise<LinhaLog[]>;
    /** SELECT-only, com timeout imposto pelo worker. */
    bd_consultar(sql: string): Promise<Linha[]>;
  } & Partial<FerramentasEscrita>;

  limites: {
    timeoutMs: number;
    budgetUsd: number;
    maxTurnos: number;
  };
}

/** Telemetria OBRIGATÓRIA em toda resposta (specs/01 §4.1, specs/05 §10). */
export interface TelemetriaIA {
  custoUsd: number;
  duracaoMs: number;
  tokensEntrada: number;
  tokensSaida: number;
}

/** Situação do registro da tentativa de resolução (preenchida pelo WORKER). */
export type SituacaoResolucao = 'pr_aberto' | 'push_sem_pr' | 'falhou';

/**
 * Tentativa de resolução automática (specs/05 §6).
 *
 * DIVERGÊNCIA de specs/01 §4.1 (reportada — a spec ganha, mas ficou desalinhada
 * com o desenho do M8): a spec define `{ branch, prUrl, resumo }`, mas o PROVIDER
 * não abre branch nem PR (isso é do worker — specs/05 §6, specs/09 §4); ele só
 * IMPLEMENTA a correção via ferramentas de escrita. Logo o provider preenche
 * `resumo` + `arquivosAlterados`, e o WORKER, ao registrar a tentativa
 * (branch/push/PR), acrescenta `branch`/`prUrl`/`situacao`. Estes últimos são
 * opcionais: ausentes na saída crua do provider, presentes em
 * `ExecucaoIA.resultado` e no evento `ia_abriu_pr` depois do registro.
 */
export interface TentativaResolucao {
  /** Resumo NEUTRO e sanitizado da mudança proposta (specs/05 §6/§9). */
  resumo: string;
  /** Caminhos (relativos ao repo) que o provider alterou na working copy. */
  arquivosAlterados: string[];
  /** Branch criada pelo worker (`ia/chamado-<numero>-<slug>`). */
  branch?: string;
  /** URL do PR quando o host é GitHub; `null` em outros hosts (PR manual). */
  prUrl?: string | null;
  /** Como a tentativa terminou, do ponto de vista do worker. */
  situacao?: SituacaoResolucao;
}

export interface AIProviderResult {
  compreendido: boolean;
  /** 0..1 */
  confianca: number;
  perguntasAoCliente: string[] | null;
  complexidade: Complexidade | null;
  naturezaAjustada: Natureza | null;
  prioridadeSugerida: Prioridade | null;
  diagnostico: string | null;
  /** Preenchido quando `naturezaAjustada = 'alteracao'` (specs/05 §7). */
  spec: string | null;
  /** Tentativa de resolução (specs/05 §6): preenchida SÓ quando o provider usou
   *  as ferramentas de escrita. `null` no fluxo normal de diagnóstico. */
  tentativaResolucao: TentativaResolucao | null;
  telemetria: TelemetriaIA;
}

/**
 * Abstração do provider. O pipeline consome SEMPRE `AIProviderResult`,
 * independentemente do engine concreto (Claude Agent SDK hoje — D-006).
 */
export interface AIProvider {
  /** ex.: "claude-agent-sdk" | "fake" */
  nome: string;
  /** ex.: "claude-opus-4-8" */
  modelo: string;

  executarTriagem(input: AIProviderInput): Promise<AIProviderResult>;
}
