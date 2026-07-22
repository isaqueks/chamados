import simpleGit from 'simple-git';
import {
  Natureza,
  Complexidade,
  confiancaAtinge,
  type ConfiancaAnalise,
  nomeBranchResolucao,
  montarMensagemCommit,
  montarTituloPr,
  montarCorpoPr,
  type TentativaResolucao,
} from '@chamados/shared';
import { urlComCredencial } from './ferramentas/repo';
import { arquivosModificados } from './ferramentas/escrita';
import { detectarGithub, tokenDaCredencial, abrirPrGithub, type FetchImpl } from './github-pr';

/**
 * Orquestração da RESOLUÇÃO AUTOMÁTICA (specs/05 §6) — a parte feita pelo WORKER,
 * nunca pelo provider: valida a tentativa, cria a branch a partir do default,
 * commita com mensagem padronizada, faz PUSH com a credencial do cofre (só na
 * URL, nunca logada) e, se o host for GitHub, abre o PR via REST API. A IA NUNCA
 * faz merge/deploy — o PR fica para aprovação humana (guardrail, specs/09 §4).
 *
 * O GATE é decidido AQUI (pipeline), nunca no provider (specs/05 §6):
 *  - PRÉ-call (`portaResolucaoAberta`): decide se as ferramentas de escrita são
 *    sequer injetadas (tenant habilitado + natureza declarada `problema` ou
 *    `alteracao` (D-023) + repo).
 *  - PÓS-call (`deveTentarResolver`): decide se o worker cria branch/push/PR, com
 *    base no resultado real (natureza efetiva `problema`/`alteracao`, complexidade
 *    `facil`, compreendido, confiança ≥ limiar, tentativa presente).
 */

// ---------------------------------------------------------------------------
// Gate (puro, testável)
// ---------------------------------------------------------------------------

export interface EntradaGatePre {
  tenantHabilitado: boolean;
  naturezaDeclarada: Natureza;
  repoConfigurado: boolean;
}

/**
 * Naturezas elegíveis à resolução automática (D-023): `problema` (correção) e
 * `alteracao` (mudança simples, ex.: trocar um texto). O limitador REAL do gate
 * é a complexidade `facil` + confiança (PÓS-call) — `duvida` fica fora (nada a
 * mudar no sistema).
 */
const NATUREZAS_RESOLVIVEIS: readonly Natureza[] = [Natureza.problema, Natureza.alteracao];

/** Gate PRÉ-call: injetar (ou não) as ferramentas de escrita nesta triagem. */
export function portaResolucaoAberta(e: EntradaGatePre): boolean {
  return (
    e.tenantHabilitado && NATUREZAS_RESOLVIVEIS.includes(e.naturezaDeclarada) && e.repoConfigurado
  );
}

export interface EntradaGatePos {
  tenantHabilitado: boolean;
  naturezaEfetiva: Natureza;
  complexidade: Complexidade | null;
  compreendido: boolean;
  /** Confiança CATEGÓRICA (D-025): baixa < media < alta. */
  confianca: ConfiancaAnalise;
  confiancaMin: ConfiancaAnalise;
  temTentativa: boolean;
  repoConfigurado: boolean;
}

/** Gate PÓS-call: o worker deve realmente criar branch/push/PR? (specs/05 §6) */
export function deveTentarResolver(e: EntradaGatePos): boolean {
  return (
    e.tenantHabilitado &&
    e.repoConfigurado &&
    e.compreendido &&
    e.temTentativa &&
    NATUREZAS_RESOLVIVEIS.includes(e.naturezaEfetiva) &&
    e.complexidade === Complexidade.facil &&
    confiancaAtinge(e.confianca, e.confiancaMin)
  );
}

// ---------------------------------------------------------------------------
// Execução da tentativa (branch + commit + push + PR)
// ---------------------------------------------------------------------------

export interface EntradaResolucao {
  /** Working copy DESCARTÁVEL, já com as alterações escritas pelo provider. */
  dir: string;
  repoUrl: string;
  /** Credencial git decifrada (efêmera): "user:token" | "token" | null. */
  credencial: string | null;
  branchPadrao: string;
  chamado: { numero: string | number; titulo: string };
  execucaoId: string;
  tentativaProvider: TentativaResolucao;
  diagnostico: string | null;
  chamadoUrl?: string | null;
}

export interface DepsResolucao {
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Fronteira HTTP do cliente GitHub (injetável no smoke/teste). */
  githubFetch?: FetchImpl;
  webhookTimeoutMs?: number;
}

/** Identidade do committer (o agente_ia). Sem PII de humano. */
const AUTOR_COMMIT = { nome: 'Assistente IA (Chamados)', email: 'agente-ia@chamados.local' };

/**
 * Executa a tentativa: valida que houve alteração real, cria a branch, commita,
 * faz push e (GitHub) abre o PR. Devolve a tentativa REGISTRADA (com branch/prUrl/
 * situacao). LANÇA com motivo normalizado (sem vazar credencial/URL autenticada)
 * se qualquer etapa falhar — o pipeline então registra a falha da tentativa sem
 * derrubar o diagnóstico já aplicado (specs/05 §6/§8).
 */
export async function executarResolucao(
  e: EntradaResolucao,
  deps: DepsResolucao,
): Promise<TentativaResolucao> {
  const git = simpleGit(e.dir);

  // 1) Valida que a tentativa realmente alterou arquivos (fonte da verdade: git).
  const arquivos = await arquivosModificados(e.dir);
  if (arquivos.length === 0) throw new Error('tentativa_sem_alteracoes');

  const branch = nomeBranchResolucao(e.chamado.numero, e.chamado.titulo);

  // 2) Prepara commit na branch de resolução (a partir do default já em HEAD).
  try {
    await git.addConfig('user.name', AUTOR_COMMIT.nome);
    await git.addConfig('user.email', AUTOR_COMMIT.email);
    await git.checkoutLocalBranch(branch);
    await git.add(['--all']);
    await git.commit(
      montarMensagemCommit({
        numero: e.chamado.numero,
        titulo: e.chamado.titulo,
        execucaoId: e.execucaoId,
        resumo: e.tentativaProvider.resumo,
      }),
    );
  } catch {
    throw new Error('commit_falhou'); // nunca ecoa caminho/segredo cru
  }

  // 3) PUSH com a credencial SÓ na URL (nunca logada; nunca gravada no .git/config).
  const authed = urlComCredencial(e.repoUrl, e.credencial);
  try {
    await git.push(authed, `${branch}:${branch}`);
  } catch {
    // A mensagem do git pode conter a URL autenticada — descarta-se por completo.
    throw new Error('push_falhou');
  }
  deps.log('resolucao: branch publicada', { branch });

  // 4) PR: só GitHub abre automaticamente; outros hosts → push + PR manual.
  const gh = detectarGithub(e.repoUrl);
  const token = tokenDaCredencial(e.credencial);
  let prUrl: string | null = null;
  if (gh && token) {
    prUrl = await abrirPrGithub({
      repo: gh,
      token,
      branch,
      base: e.branchPadrao,
      titulo: montarTituloPr({
        numero: e.chamado.numero,
        titulo: e.chamado.titulo,
        resumo: e.tentativaProvider.resumo,
        arquivos,
        execucaoId: e.execucaoId,
      }),
      corpo: montarCorpoPr({
        numero: e.chamado.numero,
        titulo: e.chamado.titulo,
        diagnostico: e.diagnostico,
        resumo: e.tentativaProvider.resumo,
        arquivos,
        execucaoId: e.execucaoId,
        chamadoUrl: e.chamadoUrl ?? null,
      }),
      timeoutMs: deps.webhookTimeoutMs,
      fetchImpl: deps.githubFetch,
    });
    deps.log('resolucao: PR aberto', { branch });
  }

  return {
    resumo: e.tentativaProvider.resumo,
    arquivosAlterados: arquivos,
    branch,
    prUrl,
    situacao: prUrl ? 'pr_aberto' : 'push_sem_pr',
  };
}
