import {
  Natureza,
  Prioridade,
  Complexidade,
  type AIProvider,
  type AIProviderInput,
  type AIProviderResult,
} from '@chamados/shared';
import { ErroProviderTimeout, ErroProviderBudget } from '../erros';

/**
 * Provider FAKE, DETERMINÍSTICO — para dev, smokes e testes SEM rede nem custo
 * (specs/10 E-23: abstração com uma impl. real + este fake de apoio). Não chama
 * nenhum modelo: deriva o `AIProviderResult` do texto do chamado, controlado por
 * MARCADORES embutidos no título/mensagens. Também EXERCITA os handles de
 * ferramentas (chama `repo_buscar` uma vez) para provar que o worker os injeta e
 * loga como stub no M6.
 *
 * Marcadores reconhecidos (case-insensitive), no título ou em qualquer mensagem:
 *   [[nao-entendeu]]                → compreendido=false + perguntasAoCliente
 *   [[complexidade:facil|medio|dificil]]
 *   [[natureza:problema|alteracao]] → naturezaAjustada (+ spec quando alteracao)
 *   [[prioridade:baixa|media|alta|urgente]]
 *   [[falhar]]                      → lança Error genérico (→ status falhou)
 *   [[timeout]]                     → lança ErroProviderTimeout (→ erro='timeout')
 *   [[budget]]                      → lança ErroProviderBudget (→ erro='budget_excedido')
 * Sem marcadores: compreendido=true, confiança 0.9, complexidade 'facil',
 * diagnóstico curto. A telemetria é determinística (derivada do tamanho do texto),
 * exceto `duracaoMs`, medido de fato.
 */
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
        perguntasAoCliente: [
          'Você poderia detalhar em qual tela o problema acontece?',
          'Qual mensagem de erro exata aparece (se houver)?',
        ],
        complexidade: null,
        naturezaAjustada: null,
        prioridadeSugerida: null,
        diagnostico: null,
        spec: null,
        tentativaResolucao: null,
        telemetria,
      };
    }

    const ehAlteracao = naturezaAjustada === Natureza.alteracao;
    return {
      compreendido: true,
      confianca: 0.9,
      perguntasAoCliente: null,
      complexidade: complexidade ?? Complexidade.facil,
      naturezaAjustada,
      prioridadeSugerida,
      diagnostico: `[fake] Análise determinística de "${input.contexto.titulo}". Sem execução real de modelo (M6).`,
      spec: ehAlteracao
        ? `# SPEC — ${input.contexto.titulo}\n\n(SPEC de exemplo gerada pelo FakeProvider no M6.)`
        : null,
      tentativaResolucao: null,
      telemetria,
    };
  }
}

/** Concatena título + corpos da timeline (a fonte dos marcadores). */
function textoDoContexto(input: AIProviderInput): string {
  const corpos = input.contexto.timeline.map((m) => m.corpo).join('\n');
  return `${input.contexto.titulo}\n${corpos}`;
}

function extrairComplexidade(texto: string): Complexidade | null {
  const m = /\[\[complexidade:(facil|medio|dificil)\]\]/.exec(texto);
  return m ? (m[1] as Complexidade) : null;
}

function extrairNatureza(texto: string): Natureza | null {
  const m = /\[\[natureza:(problema|alteracao)\]\]/.exec(texto);
  return m ? (m[1] as Natureza) : null;
}

function extrairPrioridade(texto: string): Prioridade | null {
  const m = /\[\[prioridade:(baixa|media|alta|urgente)\]\]/.exec(texto);
  return m ? (m[1] as Prioridade) : null;
}
