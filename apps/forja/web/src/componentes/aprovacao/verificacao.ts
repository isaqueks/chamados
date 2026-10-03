/**
 * "Como foi verificado" (specs/forja/06 §4.3; FJ-032): a Forja não executa
 * comandos do projeto — mostra o que o revisor RELATOU e se o comando apareceu
 * no stream do agente. Artefatos anteriores a FJ-032 (comandos rodados pelo
 * app: `nome`, `duracao_ms`, `instavel`) continuam legíveis.
 */

export type MarcaVerificacao = 'visto' | 'falhou' | 'declarado';

export interface LinhaVerificacao {
  comando: string;
  exit_code: number | null;
  marca: MarcaVerificacao;
  /** Texto curto ao lado do comando ("visto no stream", "não visto no stream"…). */
  detalhe: string;
  resumo: string;
}

interface ComandoNovo {
  comando: string;
  exit_code: number | null;
  resumo?: string;
  no_stream: 'exit_0' | 'erro' | 'nao_visto';
}

interface ComandoAntigo {
  nome: string;
  exit_code: number | null;
  duracao_ms?: number;
  instavel?: boolean;
}

function ehNovo(c: unknown): c is ComandoNovo {
  return typeof c === 'object' && c !== null && 'comando' in c && 'no_stream' in c;
}

function ehAntigo(c: unknown): c is ComandoAntigo {
  return typeof c === 'object' && c !== null && 'nome' in c;
}

export function linhasVerificacao(comandos: readonly unknown[] | undefined): LinhaVerificacao[] {
  const out: LinhaVerificacao[] = [];
  for (const c of comandos ?? []) {
    if (ehNovo(c)) {
      const vermelho = c.no_stream === 'erro' || (c.exit_code !== null && c.exit_code !== 0);
      out.push({
        comando: c.comando,
        exit_code: c.exit_code,
        marca: c.no_stream === 'nao_visto' ? 'declarado' : vermelho ? 'falhou' : 'visto',
        detalhe:
          c.no_stream === 'nao_visto'
            ? 'relatado, não visto no stream'
            : c.no_stream === 'erro'
              ? 'visto no stream com erro'
              : 'visto no stream',
        resumo: c.resumo ?? '',
      });
    } else if (ehAntigo(c)) {
      out.push({
        comando: c.nome,
        exit_code: c.exit_code,
        marca: c.exit_code === 0 ? 'visto' : 'falhou',
        detalhe: `rodado pela Forja (antes de FJ-032)${c.instavel ? ' · instável' : ''}`,
        resumo: '',
      });
    }
  }
  return out;
}
