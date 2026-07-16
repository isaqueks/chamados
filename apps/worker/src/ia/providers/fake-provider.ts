import {
  Natureza,
  Prioridade,
  Complexidade,
  VisibilidadeMensagem,
  montarTemplateSpec,
  type AIProvider,
  type AIProviderInput,
  type AIProviderResult,
  type AIMapeamentoInput,
  type AIMapeamentoResult,
} from '@chamados/shared';
import { ErroProviderTimeout, ErroProviderBudget } from '../erros';

/**
 * Provider FAKE, DETERMINÍSTICO — para dev, smokes e testes SEM rede nem custo
 * (specs/10 E-23: abstração com uma impl. real + este fake de apoio). Não chama
 * nenhum modelo: deriva o `AIProviderResult` do texto do chamado, controlado por
 * MARCADORES embutidos no título/mensagens — dirigindo TODOS os fluxos do M7
 * (perguntas, diagnóstico+classificação, SPEC de alteração, falhas). Também
 * EXERCITA um handle de ferramenta real (`repo_buscar`) para provar a injeção.
 *
 * Marcadores reconhecidos (case-insensitive), no título ou em qualquer mensagem:
 *   [[nao-entendeu]]                → compreendido=false + perguntasAoCliente
 *   [[complexidade:facil|medio|dificil]]
 *   [[natureza:problema|alteracao|duvida]] → naturezaAjustada (+ spec quando alteracao;
 *                                     duvida + [[responder-cliente]] → IA resolve sozinha, D-017)
 *   [[prioridade:baixa|media|alta|urgente]]
 *   [[resolver]]                    → tentativaResolucao determinística: USA as
 *                                     ferramentas de escrita (se presentes — só
 *                                     quando o gate do pipeline abriu) p/ gravar
 *                                     um arquivo fixo na working copy descartável.
 *   [[responder-cliente]]           → respostaAoCliente PÚBLICA e LIMPA (sem termo
 *                                     técnico) — o aplicador a publica como mensagem
 *                                     pública do agente_ia (D-015).
 *   [[responder-cliente-tecnico]]   → respostaAoCliente com cara TÉCNICA (cita
 *                                     src/arquivo.js + função()) para exercitar o
 *                                     validador (deve ser REBAIXADA para genérica).
 *   [[falhar]]                      → lança Error genérico (→ status falhou)
 *   [[timeout]]                     → lança ErroProviderTimeout (→ erro='timeout')
 *   [[budget]]                      → lança ErroProviderBudget (→ erro='budget_excedido')
 * Sem marcadores: compreendido=true, confiança 0.9, complexidade 'facil',
 * diagnóstico curto. A telemetria é determinística (derivada do tamanho do texto),
 * exceto `duracaoMs`, medido de fato.
 *
 * CONTINUIDADE (D-015): quando a timeline traz NOTAS INTERNAS (visibilidade
 * interna), o diagnóstico ECOA um trecho da última — prova de que o contexto agora
 * carrega as notas internas (o próprio diagnóstico anterior + orientações da equipe).
 *
 * MAPEAMENTO (D-013): `mapearSistema` produz um resumo markdown determinístico com
 * o marcador `[[mapa-fake]]` (citando o que `repo_buscar('regra')` encontra no
 * fixture). Quando o resumo é injetado na triagem (`contexto.conhecimento`), o
 * diagnóstico o ECOA — o smoke `conhecimento` asserta o marcador para provar a
 * injeção fim-a-fim.
 */
/** Marcador embutido no resumo de mapeamento (o smoke asserta a injeção por ele). */
export const MARCADOR_MAPA_FAKE = '[[mapa-fake]]';
export class FakeProvider implements AIProvider {
  readonly nome = 'fake';
  readonly modelo: string;

  constructor(modelo = 'fake-determinismo-1') {
    this.modelo = modelo;
  }

  async executarTriagem(input: AIProviderInput): Promise<AIProviderResult> {
    const inicio = Date.now();
    const texto = textoDoContexto(input).toLowerCase();

    // Falhas simuladas (antes de qualquer "trabalho").
    if (texto.includes('[[timeout]]')) throw new ErroProviderTimeout();
    if (texto.includes('[[budget]]')) throw new ErroProviderBudget();
    if (texto.includes('[[falhar]]')) throw new Error('falha simulada do provider fake');

    // Exercita uma ferramenta read-only (stub no M6): prova a injeção + o log.
    await input.ferramentas.repo_buscar('erro').catch(() => []);

    const compreendido = !texto.includes('[[nao-entendeu]]');
    const complexidade = extrairComplexidade(texto);
    const naturezaAjustada = extrairNatureza(texto);
    const prioridadeSugerida = extrairPrioridade(texto);

    const tokensEntrada = Math.max(1, texto.length);
    const tokensSaida = compreendido ? 120 : 40;

    const telemetria = {
      custoUsd: Number((tokensEntrada * 0.000003 + tokensSaida * 0.000015).toFixed(6)),
      duracaoMs: Date.now() - inicio,
      tokensEntrada,
      tokensSaida,
    };

    if (!compreendido) {
      return {
        compreendido: false,
        confianca: 0.35,
        // No fluxo "não entendeu", perguntasAoCliente é o canal (D-015): não duplica
        // com respostaAoCliente.
        perguntasAoCliente: [
          'Você poderia detalhar em qual tela o problema acontece?',
          'Qual mensagem de erro exata aparece (se houver)?',
        ],
        respostaAoCliente: null,
        complexidade: null,
        // #19 (meta-análise): a classificação de intenção vale mesmo sem
        // compreensão — o marcador [[natureza:...]] é honrado aqui também.
        naturezaAjustada,
        prioridadeSugerida: null,
        diagnostico: null,
        spec: null,
        tentativaResolucao: null,
        telemetria,
      };
    }

    const ehAlteracao = naturezaAjustada === Natureza.alteracao;
    const compl = complexidade ?? Complexidade.facil;

    // [[resolver]]: tentativa de resolução determinística. Usa as ferramentas de
    // ESCRITA (presentes SÓ quando o gate do pipeline abriu — specs/05 §6) para
    // gravar um arquivo fixo na working copy DESCARTÁVEL. Sem as ferramentas
    // (gate fechado), NÃO tenta — devolve tentativaResolucao=null.
    let tentativaResolucao = null as AIProviderResult['tentativaResolucao'];
    if (texto.includes('[[resolver]]') && input.ferramentas.repo_escrever_arquivo) {
      try {
        await input.ferramentas.repo_escrever_arquivo(
          'CORRECAO-IA.md',
          '# Correção automática (fake)\n\n' +
            'Ajuste determinístico aplicado pelo FakeProvider para o smoke de resolução.\n',
        );
        tentativaResolucao = {
          resumo: 'Correção determinística: adiciona CORRECAO-IA.md com a nota da correção.',
          arquivosAlterados: ['CORRECAO-IA.md'],
        };
      } catch {
        tentativaResolucao = null; // ferramenta indisponível/erro → sem tentativa
      }
    }

    // Continuidade (D-015): ecoa a última NOTA INTERNA da timeline — prova de que o
    // contexto agora carrega as notas internas (diagnóstico anterior + orientações).
    const notaAnterior = ultimaNotaInterna(input);

    return {
      compreendido: true,
      confianca: 0.9,
      perguntasAoCliente: null,
      // respostaAoCliente PÚBLICA (D-015): dirigida por marcador. Técnica → o
      // validador do aplicador a rebaixa; limpa → publicada como está.
      respostaAoCliente: derivarRespostaCliente(texto),
      complexidade: compl,
      naturezaAjustada,
      prioridadeSugerida,
      diagnostico:
        `[fake] Diagnóstico determinístico de "${input.contexto.titulo}". ` +
        'Resumo: análise simulada sem execução de modelo. Evidências: (fake). ' +
        'Causa provável: cenário controlado de teste.' +
        // Ecoa as imagens do contexto multimodal (#16): prova a injeção no smoke.
        ((input.contexto.imagens?.length ?? 0) > 0
          ? ` Imagens no contexto: ${input.contexto.imagens!.length}.`
          : '') +
        // Ecoa o conhecimento injetado (D-013): prova a injeção fim-a-fim no smoke.
        (input.contexto.conhecimento
          ? ` Conhecimento do sistema injetado: ${input.contexto.conhecimento.resumo.slice(0, 60)}`
          : '') +
        // Ecoa a nota interna anterior (D-015): prova a continuidade no smoke.
        (notaAnterior ? ` Continuidade: nota interna anterior observada — "${notaAnterior}".` : ''),
      // Para natureza=alteracao, gera a SPEC COMPLETA no template de specs/05 §7
      // (M7): prova determinística de que o fluxo produz uma SPEC utilizável.
      spec: ehAlteracao
        ? montarTemplateSpec({
            titulo: input.contexto.titulo,
            sistemaAlvoNome: input.contexto.sistemaAlvo.nome,
            sistemaAlvoStack: input.contexto.sistemaAlvo.stack,
            chamadoNumero: 'N/A',
            complexidade: compl,
            pedidoResumo: `Pedido (resumo neutro): ${input.contexto.titulo}`,
            analise: '[fake] análise determinística do estado atual.',
            mudancasPropostas: ['[fake] módulo alvo: aplicar a alteração pedida'],
            criteriosAceite: ['[fake] a alteração pedida passa a valer'],
          })
        : null,
      tentativaResolucao,
      telemetria,
    };
  }

  /**
   * MAPEAMENTO determinístico (D-013): EXERCITA `repo_buscar('regra')` (prova a
   * injeção real dos handles) e devolve um resumo markdown com o marcador
   * `[[mapa-fake]]`, citando o(s) arquivo(s) onde a "regra de negócio" aparece.
   * Respeita `maxChars`. Sem exceções de rede/custo (é o caminho de apoio dos smokes).
   */
  async mapearSistema(input: AIMapeamentoInput): Promise<AIMapeamentoResult> {
    const inicio = Date.now();
    const achados = await input.ferramentas.repo_buscar('regra').catch(() => []);
    const linhas = achados.slice(0, 5).map((a) => `- ${a.caminho}:${a.linha} — ${a.trecho}`);

    const resumo = [
      `# Mapa do sistema (fake) ${MARCADOR_MAPA_FAKE}`,
      `Sistema: ${input.sistemaAlvo.nome}`,
      `Stack: ${input.sistemaAlvo.stack ?? '—'}`,
      '',
      '## Regras de negócio encontradas',
      ...(linhas.length > 0 ? linhas : ['- (nenhuma regra localizada no fixture)']),
      '',
      '## Estrutura',
      '- Resumo determinístico gerado pelo FakeProvider para os smokes.',
    ]
      .join('\n')
      .slice(0, input.maxChars);

    const tokensEntrada = Math.max(1, resumo.length);
    const tokensSaida = 200;
    return {
      resumo,
      telemetria: {
        custoUsd: Number((tokensEntrada * 0.000003 + tokensSaida * 0.000015).toFixed(6)),
        duracaoMs: Date.now() - inicio,
        tokensEntrada,
        tokensSaida,
      },
    };
  }
}

/**
 * Concatena título + DESCRIÇÃO + corpos da timeline (a fonte dos marcadores).
 * D-014: a descrição passa a ser considerada — antes os marcadores embutidos na
 * descrição do chamado eram ignorados (limitação conhecida do fake).
 */
function textoDoContexto(input: AIProviderInput): string {
  const corpos = input.contexto.timeline.map((m) => m.corpo).join('\n');
  return `${input.contexto.titulo}\n${input.contexto.descricao}\n${corpos}`;
}

/**
 * Deriva a respostaAoCliente PÚBLICA a partir dos marcadores (D-015). `[[responder-
 * cliente-tecnico]]` produz uma mensagem com cara técnica (caminho + função) para
 * o validador do aplicador rebaixar; `[[responder-cliente]]` produz uma mensagem
 * LIMPA de atendimento. Sem marcador → null.
 */
function derivarRespostaCliente(texto: string): string | null {
  if (texto.includes('[[responder-cliente-tecnico]]')) {
    return (
      'Encontrei a origem no arquivo src/pedidos/salvar.js: a função salvarPedido() ' +
      'não valida o valor informado. Vou ajustar esse trecho do código.'
    );
  }
  if (texto.includes('[[responder-cliente]]')) {
    return (
      'Olá! Entendi seu pedido e já identifiquei o que precisa ser ajustado. ' +
      'Nossa equipe está cuidando disso e retornaremos em breve. Obrigado pelo contato!'
    );
  }
  return null;
}

/** Corpo da última NOTA INTERNA da timeline (ou null) — apoia o eco de continuidade. */
function ultimaNotaInterna(input: AIProviderInput): string | null {
  const internas = input.contexto.timeline.filter(
    (m) => m.visibilidade === VisibilidadeMensagem.interna,
  );
  const ultima = internas[internas.length - 1];
  return ultima ? ultima.corpo : null;
}

function extrairComplexidade(texto: string): Complexidade | null {
  const m = /\[\[complexidade:(facil|medio|dificil)\]\]/.exec(texto);
  return m ? (m[1] as Complexidade) : null;
}

function extrairNatureza(texto: string): Natureza | null {
  const m = /\[\[natureza:(problema|alteracao|duvida)\]\]/.exec(texto);
  return m ? (m[1] as Natureza) : null;
}

function extrairPrioridade(texto: string): Prioridade | null {
  const m = /\[\[prioridade:(baixa|media|alta|urgente)\]\]/.exec(texto);
  return m ? (m[1] as Prioridade) : null;
}
