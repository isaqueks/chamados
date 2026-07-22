import type { ArtefatoConfirmado, FormatoArtefato, PedidoArtefato } from '@chamados/shared';
import { detectarTipo, type ArquivoUpload } from '@chamados/db';
import { ferramentasConfig, type Registrar } from './config';
import { gerarPdfDeMarkdown } from './pdf';

/**
 * Ferramenta `artefato_gerar` (D-026): a IA produz um ARQUIVO entregável ao
 * cliente (relatório em PDF, extração em CSV, texto) durante a triagem. O handle
 * materializa o conteúdo em buffer AQUI (worker), valida-o com o MESMO
 * `detectarTipo` do upload de usuário (magic bytes/heurística de texto — erro
 * volta ao MODELO, que pode corrigir e tentar de novo, em vez de estourar a
 * aplicação em Tx2) e acumula por execução. O APLICADOR anexa os artefatos à
 * mensagem pública de resposta via `criarMensagem({ anexos })` — mesmo pipeline
 * de anexo/storage/download de sempre; nada de canal paralelo.
 *
 * Guardrails: tetos de quantidade e de tamanho de conteúdo por execução; nome de
 * arquivo sanitizado (sem diretórios/controle) com extensão FORÇADA ao formato;
 * mesmo nome repetido SUBSTITUI o anterior (retentativa do modelo, não duplica).
 */

const FORMATOS: readonly FormatoArtefato[] = ['pdf', 'csv', 'md', 'txt'];

export interface FerramentaArtefatos {
  /** Handle injetado no `AIProviderInput.ferramentas.artefato_gerar`. */
  gerar(pedido: PedidoArtefato): Promise<ArtefatoConfirmado>;
  /** Artefatos acumulados na execução, prontos para `criarMensagem({ anexos })`. */
  coletar(): ArquivoUpload[];
}

/** Sanitiza o nome: sem diretórios/controle, tamanho contido, extensão do formato. */
export function sanitizarNomeArtefato(nome: string, formato: FormatoArtefato): string {
  const base = nome
    .replace(/[\\/]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  const semExt = base.replace(new RegExp(`\\.${formato}$`, 'i'), '');
  const nomeUtil = (semExt.length > 0 ? semExt : 'artefato').slice(0, 100);
  return `${nomeUtil}.${formato}`;
}

export function criarFerramentaArtefatos(registrar: Registrar): FerramentaArtefatos {
  const { maxPorExecucao, maxConteudoChars } = ferramentasConfig.artefatos;
  const acumulados = new Map<string, ArquivoUpload>();

  return {
    async gerar(pedido: PedidoArtefato): Promise<ArtefatoConfirmado> {
      const formato = pedido.formato;
      registrar('artefato_gerar', {
        nome_arquivo: pedido.nome_arquivo,
        formato,
        chars: pedido.conteudo?.length ?? 0,
      });
      if (!FORMATOS.includes(formato)) {
        throw new Error(`formato inválido: use um de ${FORMATOS.join('|')}`);
      }
      const conteudo = (pedido.conteudo ?? '').trim();
      if (conteudo.length === 0) throw new Error('conteudo vazio');
      if (conteudo.length > maxConteudoChars) {
        throw new Error(`conteudo excede o limite de ${maxConteudoChars} caracteres`);
      }
      const nome = sanitizarNomeArtefato(pedido.nome_arquivo ?? '', formato);
      if (!acumulados.has(nome) && acumulados.size >= maxPorExecucao) {
        throw new Error(`limite de ${maxPorExecucao} artefatos por execução excedido`);
      }

      const buffer =
        formato === 'pdf'
          ? await gerarPdfDeMarkdown(pedido.titulo?.trim() || null, conteudo)
          : // BOM no CSV: Excel/LibreOffice abrem UTF-8 (acentos pt-BR) sem mojibake.
            Buffer.from(formato === 'csv' ? '\ufeff' + conteudo : conteudo, 'utf8');

      // MESMA validação do upload de usuário: se não passaria como anexo, falha
      // AQUI (o modelo vê o motivo) — nunca lá na Tx2 de aplicação.
      const validacao = detectarTipo(buffer, nome);
      if (!validacao.ok) {
        throw new Error(`conteudo rejeitado pela validação de anexos: ${validacao.motivo}`);
      }

      acumulados.set(nome, { nome_arquivo: nome, buffer });
      return { nome_arquivo: nome, formato, tamanho_bytes: buffer.length };
    },
    coletar(): ArquivoUpload[] {
      return Array.from(acumulados.values());
    },
  };
}
