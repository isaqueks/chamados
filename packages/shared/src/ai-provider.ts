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
import type { Natureza, Prioridade, Complexidade, Papel, VisibilidadeMensagem } from './enums';

// ---------------------------------------------------------------------------
// Contexto entregue ao modelo (specs/05 §4.1) — SEM credenciais do sistema-alvo
// ---------------------------------------------------------------------------

/**
 * Item da timeline entregue ao modelo (D-015), já SANITIZADO (texto puro, sem HTML
 * cru nem dados sensíveis). Passa a incluir TODAS as mensagens do chamado —
 * PÚBLICAS **e** INTERNAS — porque o papel `agente_ia` tem permissão de leitura
 * pela matriz (specs/03): a IA precisa enxergar o próprio diagnóstico anterior
 * (continuidade entre triagens) e as orientações internas de operadores/admins. O
 * prompt DEMARCA a visibilidade em duas seções e trata tudo como conteúdo NÃO
 * confiável. A IA vê o autor por papel + nome de exibição, nunca por PII sensível.
 *
 * Nota de contrato (D-015): expande e renomeia a antiga `MensagemPublica` (que só
 * carregava mensagens públicas) — ganhou `visibilidade` e `autorNome`.
 */
export interface MensagemTimeline {
  id: string;
  /** Papel do autor (cliente/operador/admin/agente_ia) — não expõe PII sensível. */
  autorPapel: Papel;
  /** Nome de exibição do autor — ajuda o modelo a situar a origem de cada nota. */
  autorNome: string;
  /**
   * Visibilidade da mensagem: `publica` (conversa visível ao cliente) ou `interna`
   * (nota da equipe — NUNCA visível ao cliente). Governa em qual seção do prompt
   * a mensagem entra.
   */
  visibilidade: VisibilidadeMensagem;
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

/**
 * MAPA DE CONHECIMENTO do sistema-alvo (D-013): resumo estruturado (markdown)
 * do repositório — stack, módulos, entidades, regras de negócio, fluxos — gerado
 * por uma execução dedicada de mapeamento e INJETADO em toda triagem para que a
 * IA "conheça o sistema" sem reler o repo inteiro. Derivado de código do cliente
 * (conteúdo não confiável), mas já DESTILADO — o prompt o rotula como material de
 * REFERÊNCIA, nunca como instruções.
 */
export interface ConhecimentoSistema {
  /** Resumo em markdown (≤ IA_MAPA_MAX_CHARS). */
  resumo: string;
  /** Commit (HEAD do checkout) sobre o qual o mapa foi gerado. */
  commit: string | null;
  /** Timestamp ISO-8601 (UTC) de geração do mapa. */
  geradoEm: string;
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

/**
 * Suporte às ferramentas NATIVAS de exploração de código do provider (D-014): as
 * built-ins `Read`/`Grep`/`Glob` do Agent SDK (as mesmas do Claude Code). É
 * preenchido pelo WORKER; providers sem ferramentas nativas (ex.: fake) o
 * ignoram. NÃO é conteúdo do modelo — o `checkoutDir` é caminho de worker usado
 * SÓ como `cwd`/fronteira, jamais renderizado no prompt.
 */
export interface ExploracaoNativa {
  /**
   * Diretório ABSOLUTO do checkout sincronizado — usado como `cwd` das
   * ferramentas nativas e como FRONTEIRA do `canUseTool` (nega qualquer caminho
   * fora dele). `null` antes do git sync ou quando não há repositório.
   */
  checkoutDir: string | null;
  /**
   * Auditoria das chamadas nativas (`Read`/`Grep`/`Glob`) — ligada ao mesmo
   * `registrar` que alimenta `ExecucaoIA.acoes`. Os handles MCP já se auditam nos
   * próprios wrappers; esta callback cobre as nativas, que passam pelo SDK.
   */
  auditar?: (ferramenta: string, args: unknown) => void;
}

export interface AIProviderInput {
  /** Contexto do chamado — SEM credenciais do sistema-alvo. */
  contexto: {
    titulo: string;
    /**
     * Descrição COMPLETA do chamado em TEXTO PLANO (projeção do HTML sanitizado):
     * é O PEDIDO do cliente (D-014). Antes omitida do contexto — o bug desde o M6.
     * Conteúdo NÃO confiável (dado a analisar, nunca instrução).
     */
    descricao: string;
    naturezaDeclarada: Natureza;
    /** Prioridade declarada no chamado (a IA pode sugerir outra). */
    prioridadeDeclarada: Prioridade;
    /** Solicitante do chamado (quem abriu): nome + papel — D-014. */
    solicitante: { nome: string; papel: Papel };
    /**
     * Timeline COMPLETA do chamado (D-015): TODAS as mensagens — públicas e
     * internas — já sanitizadas, cada uma com visibilidade/autor/momento. Antes
     * levava só as públicas; agora inclui as notas internas (diagnóstico anterior
     * da própria IA + orientações da equipe), demarcadas no prompt por seção.
     */
    timeline: MensagemTimeline[];
    /** Metadados SEM credenciais (nem DSN, nem caminho de repo cru). */
    sistemaAlvo: MetadadosSistemaAlvo;
    /**
     * Mapa de conhecimento do sistema-alvo (D-013), injetado pelo worker quando
     * disponível/atualizado. `null`/ausente quando não há repo ou o mapa ainda
     * não foi gerado.
     */
    conhecimento?: ConhecimentoSistema | null;
  };

  /**
   * Handles de ferramentas JÁ escopadas, injetados pelo worker (nunca
   * conexões/credenciais cruas). As primeiras são read-only sobre o
   * sistema-alvo. As de ESCRITA (`repo_escrever_arquivo`/`repo_criar_arquivo`)
   * SÓ existem quando o gate de resolução automática passou (specs/05 §6) —
   * caso contrário são `undefined` e o provider não tem como tentar resolver.
   */
  ferramentas: {
    repo_buscar(consulta: string): Promise<ResultadoBusca[]>;
    repo_ler_arquivo(caminho: string): Promise<string>;
    /** Lista caminhos (relativos) do checkout — apoia a investigação de estrutura. */
    repo_arvore?(subdir?: string): Promise<string[]>;
    logs_consultar(filtro: FiltroLogs): Promise<LinhaLog[]>;
    /** SELECT-only, com timeout imposto pelo worker. */
    bd_consultar(sql: string): Promise<Linha[]>;
  } & Partial<FerramentasEscrita>;

  limites: {
    timeoutMs: number;
    budgetUsd: number;
    maxTurnos: number;
  };

  /**
   * Ferramentas NATIVAS de exploração (D-014). Preenchido pelo worker para o
   * `ClaudeAgentProvider` (habilita `Read`/`Grep`/`Glob` escopadas ao checkout);
   * ausente/ignorado nos providers sem exploração nativa (fake).
   */
  exploracao?: ExploracaoNativa;
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
  /**
   * Mensagem PÚBLICA amigável ao cliente (D-015), em linguagem simples de
   * atendimento — JAMAIS com detalhes técnicos (arquivos, código, jargão). Opcional
   * em qualquer fluxo: no "entendeu", confirma o entendimento / dá uma posição, ou
   * responde diretamente uma dúvida que a IA resolve sem mudar o sistema. `null`
   * quando não há o que dizer ao cliente. No fluxo "não entendeu",
   * `perguntasAoCliente` é o canal (não se duplica aqui). O APLICADOR publica-a
   * como mensagem pública do `agente_ia`, mas antes passa por um validador
   * conservador que a REBAIXA para uma genérica caso venha com cara de técnica —
   * preservando o texto original apenas na nota interna.
   */
  respostaAoCliente: string | null;
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

// ---------------------------------------------------------------------------
// Mapeamento de conhecimento do sistema (D-013) — execução DEDICADA que explora
// o repositório e produz um resumo estruturado (markdown), persistido no
// sistema-alvo e injetado nas triagens seguintes.
// ---------------------------------------------------------------------------

export interface AIMapeamentoInput {
  /** Metadados do sistema-alvo (SEM credenciais). */
  sistemaAlvo: MetadadosSistemaAlvo;
  /** Ferramentas READ-ONLY sobre o checkout sincronizado (menor privilégio). */
  ferramentas: {
    repo_buscar(consulta: string): Promise<ResultadoBusca[]>;
    repo_ler_arquivo(caminho: string): Promise<string>;
    repo_arvore?(subdir?: string): Promise<string[]>;
  };
  limites: {
    timeoutMs: number;
    budgetUsd: number;
    maxTurnos: number;
  };
  /** Teto de caracteres do resumo (env `IA_MAPA_MAX_CHARS`). */
  maxChars: number;
  /**
   * Ferramentas NATIVAS de exploração (D-014): habilita `Read`/`Grep`/`Glob`
   * escopadas ao checkout também no MAPEAMENTO. Preenchido pelo worker; ignorado
   * pelo provider fake.
   */
  exploracao?: ExploracaoNativa;
}

export interface AIMapeamentoResult {
  /** Resumo em markdown (≤ `maxChars`), pronto para injeção nas triagens. */
  resumo: string;
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

  /**
   * Mapeia o conhecimento do sistema-alvo (D-013): explora o repositório via as
   * ferramentas read-only e devolve um resumo estruturado em markdown. Mesma
   * fronteira injetável/telemetria da triagem.
   */
  mapearSistema(input: AIMapeamentoInput): Promise<AIMapeamentoResult>;
}
