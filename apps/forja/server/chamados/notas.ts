import type { EvidenciaVisual, ModoEntrega, NivelVerificacao } from '../../comum/estados';
import type { RespostaV1 } from '../../comum/contratos';
import { normalizarCorpo } from './normalizacao';

/**
 * Textos que a Forja escreve no Chamados (specs/forja/07 §3, §9, §10; 03 §9).
 *
 * Notas INTERNAS (início, conclusão, descarte): formato próximo de
 * `montarNotaResolucaoPr` de `@chamados/shared`, para o painel e a equipe
 * reconhecerem, e SEMPRE com o rodapé `[forja:<execucao_id>:<momento>]` — é por
 * ele que o outbox sabe, depois de um timeout ou crash, se a nota já foi
 * (03 §9.2). A pública não leva marcador (o cliente a lê).
 *
 * Limite da API: 50.000 caracteres de texto [V: 02 §1.5]. Acima disso, o
 * relatório é truncado com "relatório completo na Forja, execução <id>", sem
 * nunca perder o rodapé.
 *
 * Mensagens-modelo PÚBLICAS (07 §10): as três do `resposta.v1.tipo`, já
 * rodadas contra os detectores e o léxico (teste em `notas.test.ts`). A
 * validação roda DEPOIS da substituição dos `{{campos}}`.
 */

export const LIMITE_CORPO_API = 50_000;

export type MomentoMarcador = 'inicio' | 'conclusao' | 'descarte';

/** `[forja:<execucao_id>:<momento>]` (02 §4.13). */
export function marcadorForja(execucaoId: string, momento: MomentoMarcador): string {
  return `[forja:${execucaoId}:${momento}]`;
}

/** O corpo (já normalizado ou não) contém o marcador? Compara normalizado (07 §9). */
export function contemMarcador(
  corpo: string,
  execucaoId: string,
  momento: MomentoMarcador,
): boolean {
  return normalizarCorpo(corpo).includes(normalizarCorpo(marcadorForja(execucaoId, momento)));
}

/** Qualquer marcador da Forja (mensagem escrita pela Forja, de qualquer execução). */
export function temMarcadorForja(corpo: string): boolean {
  return /\[forja:[^\s:\]]+:[a-z_]+\]/.test(normalizarCorpo(corpo));
}

/**
 * Trunca `corpo` para caber em `limite`, preservando o `rodape` e avisando onde
 * está o resto. Corta em fim de linha quando possível.
 */
export function truncarComRodape(
  corpo: string,
  rodape: string,
  execucaoId: string,
  limite = LIMITE_CORPO_API,
): string {
  const completo = `${corpo}\n\n${rodape}`;
  if (completo.length <= limite) return completo;
  const aviso = `\n\n(…) Relatório truncado: relatório completo na Forja, execução ${execucaoId}.`;
  const espaco = limite - aviso.length - rodape.length - 2;
  let corte = corpo.slice(0, Math.max(0, espaco));
  const quebra = corte.lastIndexOf('\n');
  if (quebra > espaco * 0.8) corte = corte.slice(0, quebra);
  return `${corte}${aviso}\n\n${rodape}`;
}

// ---------------------------------------------------------------------------
// Notas internas
// ---------------------------------------------------------------------------

export interface DadosNotaInicio {
  execucaoId: string;
  branch: string;
}

/** Nota interna de início (07 §3 "Início"). Não notifica ninguém [V: 02 §5.1]. */
export function montarNotaInicio(d: DadosNotaInicio): string {
  return [
    'Implementação local iniciada (Forja)',
    '',
    `Branch: ${d.branch}`,
    'Enquanto esta implementação estiver em andamento, a Forja acompanha o chamado.',
    '',
    marcadorForja(d.execucaoId, 'inicio'),
  ].join('\n');
}

export interface TelaAlteradaNota {
  titulo: string;
  o_que_mudou_para_quem_usa: string;
}

export interface DadosNotaConclusao {
  execucaoId: string;
  branch: string;
  shaMerge: string;
  destino: string;
  modoEntrega: ModoEntrega;
  nivelVerificacao: NivelVerificacao;
  resumo: string;
  arquivos: readonly string[];
  /** Selo `altera_ui` (FJ-026). */
  alteraUi: boolean;
  evidenciaVisual: EvidenciaVisual;
  /** Telas com prints antes/depois (só com `alteraUi`). */
  telas: readonly TelaAlteradaNota[];
  /** Sem prints: por quê (FJ-026). */
  motivoSemPrints?: string | null;
  /** O humano aprovou explicitamente sem prints no G2. */
  aprovadoSemPrints?: boolean;
}

const ROTULO_NIVEL: Record<NivelVerificacao, string> = {
  verificado_pelo_revisor: 'verificado pelo revisor (comandos vistos)',
  declarado: 'declarado pelo revisor (não confirmado)',
  nao_verificado: 'não verificado',
  // Anteriores a FJ-032 (verificação pelo app):
  e2e_automatizado: 'e2e automatizado',
  e2e_roteiro: 'e2e por roteiro',
  verificacao_estatica: 'verificação estática',
};

const ROTULO_ENTREGA: Record<ModoEntrega, string> = {
  merge_local: 'merge local',
  merge_e_push: 'merge e push',
  pull_request: 'pull request',
};

/** Nota interna de conclusão (07 §9 "Nota interna"). */
export function montarNotaConclusao(d: DadosNotaConclusao): string {
  const arquivos = d.arquivos.map((a) => a.trim()).filter(Boolean);
  const linhas: string[] = [
    'Implementação local (Forja) — aprovada e integrada',
    '',
    `Branch: ${d.branch}`,
    `Commit: ${d.shaMerge}`,
    `Destino: ${d.destino} (${ROTULO_ENTREGA[d.modoEntrega]})`,
    `Nível de verificação: ${ROTULO_NIVEL[d.nivelVerificacao]}`,
  ];
  if (d.alteraUi) {
    const comPrints = d.telas.length > 0 && d.evidenciaVisual !== 'sem_evidencia_visual';
    if (comPrints) {
      linhas.push(
        `Prints antes/depois em ${d.telas.length} ${d.telas.length === 1 ? 'tela' : 'telas'}, disponíveis na Forja (execução ${d.execucaoId}):`,
      );
      for (const t of d.telas)
        linhas.push(`- ${t.titulo.trim()}: ${t.o_que_mudou_para_quem_usa.trim()}`);
      if (d.evidenciaVisual === 'parcial') linhas.push('(evidência visual parcial)');
    } else {
      linhas.push(
        `Alteração de interface sem prints: ${d.motivoSemPrints?.trim() || 'motivo não informado'}` +
          (d.aprovadoSemPrints ? ' (aprovado sem prints)' : ''),
      );
    }
  }
  linhas.push(
    '',
    'Resumo da mudança:',
    d.resumo.trim() || '(sem resumo)',
    '',
    'Arquivos alterados:',
    arquivos.length > 0 ? arquivos.map((a) => `- ${a}`).join('\n') : '- (nenhum listado)',
  );
  return truncarComRodape(
    linhas.join('\n'),
    marcadorForja(d.execucaoId, 'conclusao'),
    d.execucaoId,
  );
}

export interface DadosNotaDescarte {
  execucaoId: string;
  motivo?: string | null;
}

/** Nota interna de descarte (07 §3 "Descartar"). */
export function montarNotaDescarte(d: DadosNotaDescarte): string {
  const linhas = ['Implementação local descartada (Forja)', ''];
  if (d.motivo?.trim()) linhas.push(`Motivo: ${d.motivo.trim()}`, '');
  linhas.push('Nada foi integrado ao sistema a partir desta implementação.');
  return truncarComRodape(linhas.join('\n'), marcadorForja(d.execucaoId, 'descarte'), d.execucaoId);
}

// ---------------------------------------------------------------------------
// Mensagens-modelo públicas (07 §10)
// ---------------------------------------------------------------------------

export type TipoMensagemModelo = RespostaV1['tipo'];

export interface CamposMensagemModelo {
  /** `solicitante_nome` do chamado; só o primeiro nome entra. */
  solicitanteNome: string | null;
  /** `pergunta`: uma por item. */
  perguntas?: readonly string[];
  /** `aguardando_publicacao`/`disponivel`: `o_que_muda` do `resposta.v1`. */
  oQueMuda?: string;
}

export function primeiroNome(nome: string | null | undefined): string | null {
  const p = (nome ?? '').trim().split(/\s+/)[0] ?? '';
  return p.length > 0 ? p : null;
}

function saudacao(nome: string | null): string {
  const p = primeiroNome(nome);
  return p ? `Olá, ${p}!` : 'Olá!';
}

/** Monta a mensagem-modelo de 07 §10. Lança se faltar o campo exigido pelo tipo. */
export function montarMensagemModelo(tipo: TipoMensagemModelo, c: CamposMensagemModelo): string {
  const ola = saudacao(c.solicitanteNome);
  if (tipo === 'pergunta') {
    const perguntas = (c.perguntas ?? []).map((p) => p.trim()).filter(Boolean);
    if (perguntas.length === 0) throw new Error('mensagem "pergunta" sem perguntas');
    return [
      `${ola} Para seguirmos com o seu pedido, precisamos de uma confirmação:`,
      '',
      perguntas.map((p, i) => `${i + 1}. ${p}`).join('\n'),
      '',
      'Assim que você responder por aqui, damos continuidade.',
    ].join('\n');
  }
  const oQueMuda = c.oQueMuda?.trim();
  if (!oQueMuda) throw new Error(`mensagem "${tipo}" sem "o que muda"`);
  if (tipo === 'aguardando_publicacao') {
    return [
      `${ola} A mudança que você pediu foi preparada e aprovada pela nossa equipe e entra no sistema na próxima atualização.`,
      '',
      `O que muda para você: ${oQueMuda}`,
      '',
      'Se, depois da atualização, algo não ficar como esperado, é só responder a esta mensagem.',
    ].join('\n');
  }
  return [
    `${ola} A mudança que você pediu já está disponível no sistema.`,
    '',
    `O que muda para você: ${oQueMuda}`,
    '',
    'Por favor, confira e, se algo não estiver como esperado, é só responder a esta mensagem: o chamado volta para a nossa equipe.',
  ].join('\n');
}
