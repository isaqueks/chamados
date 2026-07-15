import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Configuração/limites das FERRAMENTAS REAIS read-only da triagem (M7 — specs/05
 * §3.2/§4.2, specs/09 §4). Tudo com defaults seguros e sobrescrevível por env. O
 * caminho BASE do cache de working copies é o único obrigatório por spec (§3.2):
 * um diretório de trabalho do worker, chaveado por tenant + sistema-alvo.
 */

function num(nome: string, padrao: number): number {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
}

export const ferramentasConfig = {
  /** Base do cache PERSISTENTE de working copies (specs/05 §3.2). */
  repoCacheDir: process.env.IA_REPO_CACHE_DIR ?? join(tmpdir(), 'chamados-repos'),
  repo: {
    /** Teto de tamanho de arquivo lido/varrido (bytes). */
    maxArquivoBytes: num('IA_REPO_MAX_ARQUIVO_BYTES', 512 * 1024),
    /** Teto de ocorrências devolvidas por `repo_buscar`. */
    maxResultadosBusca: num('IA_REPO_MAX_RESULTADOS', 100),
    /** Teto de arquivos varridos por busca (evita repo gigante travar o job). */
    maxArquivosVarridos: num('IA_REPO_MAX_ARQUIVOS', 5000),
  },
  logs: {
    /** Teto de linhas devolvidas por `logs_consultar`. */
    maxLinhas: num('IA_LOGS_MAX_LINHAS', 200),
    /** Teto de bytes lidos do fim do arquivo de log (tail). */
    maxBytes: num('IA_LOGS_MAX_BYTES', 2 * 1024 * 1024),
    /** Teto de arquivos considerados numa consulta com glob. */
    maxArquivos: num('IA_LOGS_MAX_ARQUIVOS', 20),
  },
  bd: {
    /** `statement_timeout` da transação READ ONLY (ms) — timeout CURTO (specs/05 §4.2). */
    statementTimeoutMs: num('IA_BD_TIMEOUT_MS', 5000),
    /** LIMIT forçado sobre qualquer consulta (nunca despeja tabelas inteiras). */
    maxLinhas: num('IA_BD_MAX_LINHAS', 100),
    /** Timeout de estabelecimento de conexão (ms). */
    conexaoTimeoutMs: num('IA_BD_CONEXAO_TIMEOUT_MS', 5000),
  },
};

/** Trilha de ações (chamadas de ferramenta) — coletada e gravada em `ExecucaoIA.acoes`. */
export type Registrar = (ferramenta: string, args: unknown) => void;
