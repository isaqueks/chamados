import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { FiltroLogs, LinhaLog } from '@chamados/shared';
import { ferramentasConfig, type Registrar } from './config';
import type { LogsConfig } from '@chamados/db';

/**
 * Ferramenta LOGS (read-only, specs/05 §4.2). Adapter por `logs_tipo` do
 * sistema-alvo. No M7 implementa o tipo `arquivo`: lê o(s) arquivo(s) apontado(s)
 * por `logs_config.caminho` (arquivo único, diretório ou glob de 1 nível), faz
 * TAIL limitado por bytes/linhas e filtra por substring — janela e volume
 * sempre limitados. Tipos NÃO suportados retornam erro CLARO ao modelo (não
 * silencioso), para ele saber que a evidência de logs não está disponível.
 *
 * O CAMINHO vem de `logs_config` (configurado pelo admin do tenant), não do
 * modelo — o modelo só controla o filtro/limite. Ainda assim tudo é bounded.
 */

export interface ConfigLogs {
  tipo: string | null;
  config: LogsConfig;
  /** Credencial decifrada (ou null). O adapter `arquivo` não usa; reservada a
   * adapters futuros (cloudwatch, loki, etc.). Efêmera, nunca logada. */
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

/** Cria o handle `logs_consultar` do sistema-alvo (adapter por `logs_tipo`). */
export function criarHandleLogs(
  cfg: ConfigLogs,
  registrar: Registrar,
): (filtro: FiltroLogs) => Promise<LinhaLog[]> {
  const { maxLinhas, maxBytes, maxArquivos } = ferramentasConfig.logs;

  return async (filtro) => {
    registrar('logs_consultar', filtro);

    if (cfg.tipo == null) {
      throw new Error('fonte de logs não configurada para este sistema-alvo');
    }
    if (cfg.tipo !== 'arquivo') {
      throw new Error(`logs_tipo '${cfg.tipo}' não suportado (apenas 'arquivo' no M7)`);
    }

    const caminho = String(cfg.config.caminho ?? cfg.config.path ?? '');
    if (!caminho) throw new Error("logs_config.caminho não configurado (tipo 'arquivo')");

    const arquivos = await resolverArquivos(caminho, maxArquivos);
    let linhas: string[] = [];
    for (const arq of arquivos) {
      const conteudo = await lerCauda(arq, maxBytes).catch(() => '');
      for (const l of conteudo.split(/\r?\n/)) if (l.length > 0) linhas.push(l);
    }

    if (filtro.consulta) {
      const termo = filtro.consulta.toLowerCase();
      linhas = linhas.filter((l) => l.toLowerCase().includes(termo));
    }

    const limite = Math.min(
      filtro.limite && filtro.limite > 0 ? filtro.limite : maxLinhas,
      maxLinhas,
    );
    return linhas.slice(-limite).map(parseLinha);
  };
}
