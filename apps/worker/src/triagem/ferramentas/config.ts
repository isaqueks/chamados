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

/** Número dentro de [min, max] (aceita 0 e frações — ex.: limiar de confiança). */
function numMin(nome: string, padrao: number, min: number, max: number): number {
  const raw = process.env[nome];
  if (raw === undefined || raw.trim() === '') return padrao;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : padrao;
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
    /** Timeout de conexão/handshake do adapter SFTP (ms) — D-021. */
    sftpTimeoutMs: num('IA_LOGS_SFTP_TIMEOUT_MS', 8000),
  },
  bd: {
    /** `statement_timeout` da transação READ ONLY (ms) — timeout CURTO (specs/05 §4.2). */
    statementTimeoutMs: num('IA_BD_TIMEOUT_MS', 5000),
    /** LIMIT forçado sobre qualquer consulta (nunca despeja tabelas inteiras). */
    maxLinhas: num('IA_BD_MAX_LINHAS', 100),
    /** Timeout de estabelecimento de conexão (ms). */
    conexaoTimeoutMs: num('IA_BD_CONEXAO_TIMEOUT_MS', 5000),
  },
  /**
   * RESOLUÇÃO automática (specs/05 §6): limites das ferramentas de ESCRITA na
   * working copy descartável + limiar de confiança do gate. `IA_RESOLUCAO_*`.
   */
  resolucao: {
    /** Confiança mínima do gate (specs/05 §5.1: default 0.7). */
    confiancaMin: numMin('IA_RESOLUCAO_CONFIANCA_MIN', 0.7, 0, 1),
    /** Teto de arquivos que a tentativa pode criar/alterar (correção pontual). */
    maxArquivos: num('IA_RESOLUCAO_MAX_ARQUIVOS', 10),
    /** Teto de tamanho de cada arquivo escrito (bytes). */
    maxArquivoBytes: num('IA_RESOLUCAO_MAX_ARQUIVO_BYTES', 256 * 1024),
    /** Teto de bytes totais escritos na tentativa. */
    maxBytesTotal: num('IA_RESOLUCAO_MAX_BYTES_TOTAL', 1024 * 1024),
  },
};

/** Trilha de ações (chamadas de ferramenta) — coletada e gravada em `ExecucaoIA.acoes`. */
export type Registrar = (ferramenta: string, args: unknown) => void;
