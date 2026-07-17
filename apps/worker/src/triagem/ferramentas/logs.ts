import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { FiltroLogs, LinhaLog } from '@chamados/shared';
import { ferramentasConfig, type Registrar } from './config';
import type { LogsConfig } from '@chamados/db';

/**
 * Ferramenta LOGS (read-only, specs/05 §4.2). Adapter por `logs_tipo` do
 * sistema-alvo:
 *
 * - `arquivo` (M7): lê o(s) arquivo(s) locais apontado(s) por
 *   `logs_config.caminho` (arquivo único, diretório ou glob de 1 nível).
 * - `sftp` (D-021): conecta ao servidor do cliente (host/porta/usuario de
 *   `logs_config`, credencial do COFRE — senha ou chave privada PEM) e lê os
 *   arquivos do diretório remoto configurado (`caminho`, com glob de 1 nível),
 *   mais recentes primeiro.
 *
 * Ambos fazem TAIL limitado por bytes/linhas e filtram por substring — janela e
 * volume sempre limitados. Tipos NÃO suportados retornam erro CLARO ao modelo
 * (não silencioso), para ele saber que a evidência de logs não está disponível.
 *
 * O CAMINHO vem de `logs_config` (configurado pelo admin do tenant), não do
 * modelo — o modelo só controla o filtro/limite. Ainda assim tudo é bounded.
 */

export interface ConfigLogs {
  tipo: string | null;
  config: LogsConfig;
  /** Credencial decifrada (ou null), efêmera e nunca logada. `arquivo` não usa;
   * `sftp` interpreta como SENHA ou, se começar com "-----BEGIN", chave privada. */
  credencial: string | null;
}

/** Lê no máximo os últimos `maxBytes` de um arquivo (tail sem carregar tudo). */
async function lerCauda(caminho: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(caminho, 'r');
  try {
    const { size } = await fh.stat();
    const inicio = size > maxBytes ? size - maxBytes : 0;
    const tamanho = Number(size) - Number(inicio);
    if (tamanho <= 0) return '';
    const buf = Buffer.alloc(tamanho);
    await fh.read(buf, 0, tamanho, inicio);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Converte um glob simples de 1 nível (`dir/*.log`) em teste de basename. */
function testeGlob(padraoBasename: string): (nome: string) => boolean {
  const re = new RegExp(
    '^' +
      padraoBasename
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return (nome) => re.test(nome);
}

/**
 * Resolve o caminho de `logs_config.caminho` em uma lista de arquivos: arquivo
 * único, todos os arquivos de um diretório, ou um glob simples `dir/*.ext`.
 */
async function resolverArquivos(caminho: string, maxArquivos: number): Promise<string[]> {
  if (caminho.includes('*')) {
    const dir = dirname(caminho);
    const teste = testeGlob(basename(caminho));
    const entradas = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entradas
      .filter((e) => e.isFile() && teste(e.name))
      .map((e) => join(dir, e.name))
      .slice(0, maxArquivos);
  }
  const st = await fs.stat(caminho).catch(() => null);
  if (!st) throw new Error(`arquivo de log não encontrado: ${caminho}`);
  if (st.isDirectory()) {
    const entradas = await fs.readdir(caminho, { withFileTypes: true }).catch(() => []);
    return entradas
      .filter((e) => e.isFile())
      .map((e) => join(caminho, e.name))
      .slice(0, maxArquivos);
  }
  return [caminho];
}

/** Extrai timestamp/nível de forma heurística; o resto vira a mensagem crua. */
function parseLinha(linha: string): LinhaLog {
  const ts = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]\s]*)\]?/.exec(linha);
  const nivel = /\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b/i.exec(linha);
  return {
    timestamp: ts?.[1] ?? '',
    nivel: nivel ? nivel[1]!.toUpperCase() : null,
    mensagem: linha,
  };
}

/** Aplica filtro de substring + limite e converte em `LinhaLog[]` (pipeline comum). */
function filtrarELimitar(linhas: string[], filtro: FiltroLogs, maxLinhas: number): LinhaLog[] {
  let out = linhas;
  if (filtro.consulta) {
    const termo = filtro.consulta.toLowerCase();
    out = out.filter((l) => l.toLowerCase().includes(termo));
  }
  const limite = Math.min(
    filtro.limite && filtro.limite > 0 ? filtro.limite : maxLinhas,
    maxLinhas,
  );
  return out.slice(-limite).map(parseLinha);
}

/** Leitura local (tipo `arquivo`): arquivos resolvidos do caminho configurado. */
async function lerLinhasArquivo(caminho: string, maxArquivos: number, maxBytes: number) {
  const arquivos = await resolverArquivos(caminho, maxArquivos);
  const linhas: string[] = [];
  for (const arq of arquivos) {
    const conteudo = await lerCauda(arq, maxBytes).catch(() => '');
    for (const l of conteudo.split(/\r?\n/)) if (l.length > 0) linhas.push(l);
  }
  return linhas;
}

// --- SFTP (D-021) ------------------------------------------------------------

/**
 * Superfície MÍNIMA do cliente SFTP usada pelo adapter — espelha
 * `ssh2-sftp-client` e permite injetar um fake nos testes.
 */
export interface ClienteSftp {
  connect(opts: Record<string, unknown>): Promise<unknown>;
  list(
    dir: string,
  ): Promise<Array<{ name: string; type: string; size: number; modifyTime: number }>>;
  stat(caminho: string): Promise<{ size: number }>;
  get(
    caminho: string,
    dst?: undefined,
    opts?: { readStreamOptions?: { start?: number } },
  ): Promise<unknown>;
  end(): Promise<unknown>;
}

export type FabricaSftp = () => Promise<ClienteSftp>;

/** Fábrica padrão: `ssh2-sftp-client` (import dinâmico — só carrega se usado). */
async function fabricaSftpPadrao(): Promise<ClienteSftp> {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  return new SftpClient() as unknown as ClienteSftp;
}

/**
 * Lê as linhas de log via SFTP: resolve o diretório/glob remoto, ordena por
 * modificação (mais recentes primeiro), respeita `maxArquivos`/`maxBytes` (tail
 * por leitura com offset) e devolve as linhas em ordem cronológica de arquivo.
 * A credencial vira `password` OU `privateKey` (heurística "-----BEGIN").
 */
async function lerLinhasSftp(
  cfg: ConfigLogs,
  limites: { maxArquivos: number; maxBytes: number; timeoutMs: number },
  fabrica: FabricaSftp,
): Promise<string[]> {
  const host = String(cfg.config.host ?? '').trim();
  const usuario = String(cfg.config.usuario ?? cfg.config.username ?? '').trim();
  const caminho = String(cfg.config.caminho ?? cfg.config.path ?? '').trim();
  const porta = Number(cfg.config.porta ?? cfg.config.port ?? 22);
  if (!host) throw new Error("logs_config.host não configurado (tipo 'sftp')");
  if (!usuario) throw new Error("logs_config.usuario não configurado (tipo 'sftp')");
  if (!caminho) throw new Error("logs_config.caminho não configurado (tipo 'sftp')");
  if (!cfg.credencial) {
    throw new Error("credencial SFTP não configurada (senha ou chave privada — tipo 'sftp')");
  }

  const cliente = await fabrica();
  const auth = cfg.credencial.trimStart().startsWith('-----BEGIN')
    ? { privateKey: cfg.credencial }
    : { password: cfg.credencial };

  await cliente.connect({
    host,
    port: Number.isFinite(porta) && porta > 0 ? porta : 22,
    username: usuario,
    readyTimeout: limites.timeoutMs,
    ...auth,
  });
  try {
    // Glob de 1 nível (`dir/*.log`) ou diretório/arquivo direto.
    let dir = caminho;
    let teste: ((nome: string) => boolean) | null = null;
    if (caminho.includes('*')) {
      dir = dirname(caminho);
      teste = testeGlob(basename(caminho));
    }

    // `list` falha se `dir` for arquivo — nesse caso trata como arquivo único.
    const listagem = await cliente.list(dir).catch(() => null);
    const arquivos =
      listagem === null
        ? [caminho]
        : listagem
            .filter((e) => e.type === '-' && (teste === null || teste(e.name)))
            .sort((a, b) => b.modifyTime - a.modifyTime)
            .slice(0, limites.maxArquivos)
            .map((e) => `${dir.replace(/\/+$/, '')}/${e.name}`)
            // Ordem cronológica (mais antigo → mais novo) para o tail final.
            .reverse();

    const linhas: string[] = [];
    for (const arq of arquivos) {
      try {
        const { size } = await cliente.stat(arq);
        const start = size > limites.maxBytes ? size - limites.maxBytes : 0;
        const bruto = await cliente.get(arq, undefined, {
          readStreamOptions: start > 0 ? { start } : {},
        });
        const conteudo = Buffer.isBuffer(bruto) ? bruto.toString('utf8') : String(bruto);
        for (const l of conteudo.split(/\r?\n/)) if (l.length > 0) linhas.push(l);
      } catch {
        // Arquivo removido/sem permissão no meio do caminho: segue nos demais.
      }
    }
    return linhas;
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

/** Cria o handle `logs_consultar` do sistema-alvo (adapter por `logs_tipo`). */
export function criarHandleLogs(
  cfg: ConfigLogs,
  registrar: Registrar,
  fabricaSftp: FabricaSftp = fabricaSftpPadrao,
): (filtro: FiltroLogs) => Promise<LinhaLog[]> {
  const { maxLinhas, maxBytes, maxArquivos, sftpTimeoutMs } = ferramentasConfig.logs;

  return async (filtro) => {
    registrar('logs_consultar', filtro);

    if (cfg.tipo == null) {
      throw new Error('fonte de logs não configurada para este sistema-alvo');
    }

    if (cfg.tipo === 'arquivo') {
      const caminho = String(cfg.config.caminho ?? cfg.config.path ?? '');
      if (!caminho) throw new Error("logs_config.caminho não configurado (tipo 'arquivo')");
      const linhas = await lerLinhasArquivo(caminho, maxArquivos, maxBytes);
      return filtrarELimitar(linhas, filtro, maxLinhas);
    }

    if (cfg.tipo === 'sftp') {
      const linhas = await lerLinhasSftp(
        cfg,
        { maxArquivos, maxBytes, timeoutMs: sftpTimeoutMs },
        fabricaSftp,
      );
      return filtrarELimitar(linhas, filtro, maxLinhas);
    }

    throw new Error(`logs_tipo '${cfg.tipo}' não suportado (tipos: 'arquivo', 'sftp')`);
  };
}
