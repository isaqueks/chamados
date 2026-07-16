import type { EntityManager } from 'typeorm';
import { IsNull } from 'typeorm';
import type { AIProviderInput } from '@chamados/shared';
import { SistemaAlvoSchema, criarSecretStore, type SecretStore } from '@chamados/db';
import type { Registrar } from './config';
import { criarHandlesRepo, sincronizarRepo, type ConfigRepo } from './repo';
import { criarHandleLogs, type ConfigLogs } from './logs';
import { criarFerramentaBd, type ConfigBd } from './bd';
import { criarHandlesEscrita, criarCopiaDescartavel, type CopiaDescartavel } from './escrita';

/**
 * Montagem das FERRAMENTAS REAIS read-only (M7) e sua injeção como HANDLES no
 * `AIProviderInput` (specs/01 §4.1, specs/05 §4.2). Toda credencial vive APENAS
 * aqui, no worker: é decifrada do cofre em `resolverConfigFerramentas` (dentro do
 * `runInTenantContext`, RLS ativa) e capturada em closures — o provider recebe
 * só funções, jamais conexões/credenciais cruas (guardrail de menor privilégio).
 */

export interface ConfigFerramentas {
  /** Config do repositório; `null` quando o chamado não tem sistema-alvo com git. */
  repo: ConfigRepo | null;
  logs: ConfigLogs;
  bd: ConfigBd;
}

export interface FerramentasReais {
  ferramentas: AIProviderInput['ferramentas'];
  /** Sincroniza a working copy (clone/pull). No-op se não há repo (specs/05 §3.2). */
  sincronizar(): Promise<void>;
  /**
   * Prepara a WORKING COPY DESCARTÁVEL (specs/05 §6): clona o checkout do cache
   * para um diretório temp e habilita as ferramentas de escrita a apontarem para
   * ela. No-op se a resolução não está habilitada ou não há repo sincronizado.
   * Chamado pelo pipeline DEPOIS de `sincronizar()` e ANTES do provider.
   */
  prepararResolucao(): Promise<void>;
  /** Cópia descartável preparada (ou null) — o worker commita/faz push a partir dela. */
  copiaResolucao(): CopiaDescartavel | null;
  /** Diretório do checkout sincronizado (ou null se não há repo / antes do sync). */
  checkout(): string | null;
  /** Libera recursos (BD + destrói a cópia descartável) ao fim do job. */
  encerrar(): Promise<void>;
}

/**
 * Resolve a configuração das ferramentas para o sistema-alvo do chamado,
 * DECIFRANDO as credenciais do cofre (só aqui, no worker). Roda dentro do
 * `runInTenantContext` (RLS garante que só resolve segredos do tenant do job).
 * Sem sistema-alvo (chamado só com categoria), devolve tudo "não configurado".
 */
export async function resolverConfigFerramentas(
  em: EntityManager,
  tenantId: string,
  sistemaAlvoId: string | null,
  store: SecretStore = criarSecretStore(),
): Promise<ConfigFerramentas> {
  if (!sistemaAlvoId) {
    return { repo: null, logs: { tipo: null, config: {}, credencial: null }, bd: emptyBd() };
  }
  const s = await em.findOne(SistemaAlvoSchema, {
    where: { id: sistemaAlvoId, deleted_at: IsNull() },
  });
  if (!s) {
    return { repo: null, logs: { tipo: null, config: {}, credencial: null }, bd: emptyBd() };
  }

  const [gitCred, logsCred, bdCred] = await Promise.all([
    s.git_credencial_ref ? store.ler(em, s.git_credencial_ref) : Promise.resolve(null),
    s.logs_credencial_ref ? store.ler(em, s.logs_credencial_ref) : Promise.resolve(null),
    s.bd_credencial_ref ? store.ler(em, s.bd_credencial_ref) : Promise.resolve(null),
  ]);

  return {
    repo: s.git_repo_url
      ? {
          tenantId,
          sistemaAlvoId: s.id,
          repoUrl: s.git_repo_url,
          branchPadrao: s.git_branch_padrao,
          credencial: gitCred,
        }
      : null,
    logs: { tipo: s.logs_tipo, config: s.logs_config, credencial: logsCred },
    bd: {
      tipo: s.bd_tipo,
      host: s.bd_host,
      porta: s.bd_porta,
      nome: s.bd_nome,
      credencial: bdCred,
    },
  };
}

function emptyBd(): ConfigBd {
  return { tipo: null, host: null, porta: null, nome: null, credencial: null };
}

/**
 * Constrói os HANDLES injetáveis no `AIProviderInput.ferramentas` a partir da
 * config já resolvida/decifrada. O checkout do repo é preenchido por
 * `sincronizar()` (chamado pelo pipeline ANTES do provider — specs/05 §3.1). As
 * ferramentas de ESCRITA só são incluídas quando `resolucaoHabilitada` (o gate
 * PRÉ-call do pipeline autorizou — specs/05 §6); do contrário são `undefined`.
 */
export function montarFerramentasReais(
  cfg: ConfigFerramentas,
  registrar: Registrar,
  opcoes: { resolucaoHabilitada?: boolean } = {},
): FerramentasReais {
  let checkoutDir: string | null = null;
  let copia: CopiaDescartavel | null = null;
  const repo = criarHandlesRepo(() => checkoutDir, registrar);
  const logs = criarHandleLogs(cfg.logs, registrar);
  const bd = criarFerramentaBd(cfg.bd, registrar);
  const escrita = criarHandlesEscrita(() => copia?.dir ?? null, registrar);

  const habilitada = opcoes.resolucaoHabilitada === true && cfg.repo !== null;

  return {
    ferramentas: {
      repo_buscar: repo.repo_buscar,
      repo_ler_arquivo: repo.repo_ler_arquivo,
      repo_arvore: repo.repo_arvore,
      logs_consultar: logs,
      bd_consultar: bd.bd_consultar,
      // Escrita SÓ quando o gate PRÉ-call passou (specs/05 §6).
      ...(habilitada
        ? {
            repo_escrever_arquivo: escrita.repo_escrever_arquivo,
            repo_criar_arquivo: escrita.repo_criar_arquivo,
          }
        : {}),
    },
    async sincronizar() {
      if (cfg.repo) checkoutDir = await sincronizarRepo(cfg.repo);
    },
    async prepararResolucao() {
      if (!habilitada || !checkoutDir) return;
      copia = await criarCopiaDescartavel(checkoutDir);
    },
    copiaResolucao() {
      return copia;
    },
    checkout() {
      return checkoutDir;
    },
    async encerrar() {
      await bd.encerrar();
      if (copia) {
        await copia.destruir();
        copia = null;
      }
    },
  };
}
