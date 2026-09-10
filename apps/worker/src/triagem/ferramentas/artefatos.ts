import type {
  ArtefatoConfirmado,
  ArtefatoConsultaConfirmado,
  FormatoArtefato,
  FormatoArtefatoConsulta,
  Linha,
  PedidoArtefato,
  PedidoArtefatoConsulta,
} from '@chamados/shared';
import { detectarTipo, type ArquivoUpload } from '@chamados/db';
import { ferramentasConfig, type Registrar } from './config';
import { gerarPdfDeMarkdown } from './pdf';
import { formatarDataPlanilha, gerarXlsx } from './xlsx';

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
 * Ferramenta `artefato_consulta` (D-034 — EXTRAÇÃO POR CONSULTA): para despejos
 * tabulares grandes ("a lista de todos os clientes da carteira X"), o modelo
 * entrega SÓ o SELECT e o worker executa a consulta (mesma validação read-only
 * do `bd_consultar`, com teto próprio de linhas) e materializa CSV/XLSX direto
 * do resultado. O modelo NÃO pagina nem redigita as linhas: recebe de volta
 * apenas um resumo (linhas/colunas/amostra) — é o que evita o timeout de 10 min.
 *
 * Guardrails: tetos de quantidade e de tamanho de conteúdo por execução; nome de
 * arquivo sanitizado (sem diretórios/controle) com extensão FORÇADA ao formato;
 * mesmo nome repetido SUBSTITUI o anterior (retentativa do modelo, não duplica).
 */

const FORMATOS: readonly FormatoArtefato[] = ['pdf', 'csv', 'md', 'txt'];
const FORMATOS_CONSULTA: readonly FormatoArtefatoConsulta[] = ['csv', 'xlsx'];

/** Quantas linhas da extração voltam ao modelo como amostra (nunca o resultado inteiro). */
const LINHAS_AMOSTRA = 5;

/** Executor da extração injetado pelo `index.ts` (o `bd_extrair` da ferramenta de BD). */
export interface DepsArtefatos {
  extrair?: (sql: string, maxLinhas: number) => Promise<Linha[]>;
}

export interface FerramentaArtefatos {
  /** Handle injetado no `AIProviderInput.ferramentas.artefato_gerar`. */
  gerar(pedido: PedidoArtefato): Promise<ArtefatoConfirmado>;
  /** Handle injetado no `AIProviderInput.ferramentas.artefato_consulta` (D-034). */
  consultar(pedido: PedidoArtefatoConsulta): Promise<ArtefatoConsultaConfirmado>;
  /** Artefatos acumulados na execução, prontos para `criarMensagem({ anexos })`. */
  coletar(): ArquivoUpload[];
}

/** Sanitiza o nome: sem diretórios/controle, tamanho contido, extensão do formato. */
export function sanitizarNomeArtefato(
  nome: string,
  formato: FormatoArtefato | FormatoArtefatoConsulta,
): string {
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

/** Valor de célula em texto puro para o CSV (mesmas regras do XLSX, sem tipagem). */
function textoCelulaCsv(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? '' : formatarDataPlanilha(valor);
  }
  if (typeof valor === 'object') {
    try {
      return JSON.stringify(valor) ?? '';
    } catch {
      return String(valor);
    }
  }
  return String(valor);
}

/**
 * CSV conforme RFC 4180: aspeia o campo quando ele contém o separador, aspas ou
 * quebra de linha (aspas internas DOBRADAS) e separa as linhas com CRLF. O BOM
 * UTF-8 é acrescentado na materialização (como já se faz no `artefato_gerar`).
 */
export function gerarCsv(colunas: string[], linhas: unknown[][], separador: string): string {
  const precisaAspas = (campo: string): boolean =>
    campo.includes(separador) ||
    campo.includes('"') ||
    campo.includes('\n') ||
    campo.includes('\r');
  const escapar = (valor: unknown): string => {
    const campo = textoCelulaCsv(valor);
    return precisaAspas(campo) ? `"${campo.replace(/"/g, '""')}"` : campo;
  };

  const partes: string[] = [colunas.map(escapar).join(separador)];
  for (const linha of linhas) {
    partes.push(colunas.map((_c, i) => escapar(linha[i])).join(separador));
  }
  return partes.join('\r\n');
}

export function criarFerramentaArtefatos(
  registrar: Registrar,
  deps: DepsArtefatos = {},
): FerramentaArtefatos {
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

    async consultar(pedido: PedidoArtefatoConsulta): Promise<ArtefatoConsultaConfirmado> {
      const formato = pedido.formato;
      // Registrar SEM segredos: o SQL pedido é a própria ação auditada. O
      // `bd_extrair` NÃO registra — a trilha desta chamada é só esta.
      registrar('artefato_consulta', {
        nome_arquivo: pedido.nome_arquivo,
        formato,
        sql: pedido.consulta,
      });
      if (!FORMATOS_CONSULTA.includes(formato)) {
        throw new Error(`formato inválido: use ${FORMATOS_CONSULTA.join('|')}`);
      }
      const extrair = deps.extrair;
      if (!extrair) throw new Error('conexão de BD do sistema-alvo não configurada');

      const nome = sanitizarNomeArtefato(pedido.nome_arquivo ?? '', formato);
      if (!acumulados.has(nome) && acumulados.size >= maxPorExecucao) {
        throw new Error(`limite de ${maxPorExecucao} artefatos por execução excedido`);
      }

      // Lido AQUI (e não na criação) para respeitar env sobrescrita em runtime/teste.
      const { maxLinhasExtracao, csvSeparador } = ferramentasConfig.artefatos;
      // A validação SELECT-only acontece dentro do `bd_extrair`; o erro volta ao modelo.
      const linhas = await extrair(pedido.consulta, maxLinhasExtracao);
      const primeira = linhas[0];
      if (!primeira) {
        throw new Error(
          'a consulta não retornou linhas — revise o filtro antes de gerar o arquivo',
        );
      }

      const colunas = Object.keys(primeira);
      const valores = linhas.map((linha) => colunas.map((coluna) => linha[coluna]));
      const buffer =
        formato === 'csv'
          ? // BOM no CSV: Excel/LibreOffice abrem UTF-8 (acentos pt-BR) sem mojibake.
            Buffer.from('﻿' + gerarCsv(colunas, valores, csvSeparador), 'utf8')
          : gerarXlsx({ nomeAba: pedido.titulo, colunas, linhas: valores });

      // MESMA validação do upload de usuário (a allowlist reconhece o xlsx pela
      // assinatura ZIP + extensão): falha aqui volta ao MODELO, nunca na Tx2.
      const validacao = detectarTipo(buffer, nome);
      if (!validacao.ok) {
        throw new Error(`conteudo rejeitado pela validação de anexos: ${validacao.motivo}`);
      }

      acumulados.set(nome, { nome_arquivo: nome, buffer });
      return {
        nome_arquivo: nome,
        formato,
        tamanho_bytes: buffer.length,
        linhas: linhas.length,
        colunas,
        amostra: linhas.slice(0, LINHAS_AMOSTRA),
        truncado: linhas.length >= maxLinhasExtracao,
      };
    },

    coletar(): ArquivoUpload[] {
      return Array.from(acumulados.values());
    },
  };
}
