import { detectarConteudoTecnico, detectarPromessaResolucao } from '@chamados/shared';
import type { RespostaV1, ValidacaoResposta } from '../../comum/contratos';

/**
 * Validador de linguagem da mensagem PÚBLICA (specs/forja/04 §8; 07 §10).
 *
 * POR QUE além dos detectores do servidor: a API não valida linguagem
 * [V: 02 §0.3] e `detectarConteudoTecnico` não pega "fizemos o merge da branch"
 * [V: D6]. A Forja soma:
 *  1. `detectarConteudoTecnico` e `detectarPromessaResolucao` de
 *     `@chamados/shared` (os mesmos do worker do Chamados);
 *  2. o LÉXICO EXTRA (`branch`, `commit`, `merge`, `deploy`, `PR`, `pull
 *     request`, `endpoint`, `migration`, `schema`, `query`, `API`, `worktree`,
 *     `bug`) com fronteira de palavra UNICODE — o `\b` do JavaScript é ASCII e
 *     faria `PR` casar com "**pr**óxima" (07 §10). As siglas `PR`/`API` são
 *     sensíveis a maiúsculas;
 *  3. disponibilidade afirmada ("já está disponível", "já pode usar", "no ar",
 *     "em produção"), só no tipo `aguardando_publicacao` (04 §8.2);
 *  4. tamanho: não vazio e ≤ 1.200 caracteres (04 §8.1).
 *
 * Promessa de resolução BLOQUEIA em todos os tipos: 07 §10 é explícito ("foi
 * corrigido" é reprovado em qualquer modo, porque o detector não sabe se a
 * publicação aconteceu) e prevalece sobre o "só avisa" de 04 §8.2 para
 * `disponivel`. O modelo `disponivel` diz "já está disponível", que não é forma
 * de fato consumado e passa.
 *
 * Não há rebaixamento automático (04 §8.4): o resultado traz motivos LEGÍVEIS,
 * com a posição quando o detector a conhece, e o humano corrige ou marca
 * "publicar mesmo assim" — explícito e pelos MESMOS motivos (`avaliarPublicacao`).
 */

export type TipoResposta = RespostaV1['tipo'];

export const LIMITE_RESPOSTA_PUBLICA = 1200;

export type CategoriaMotivo = 'tecnico' | 'promessa' | 'lexico' | 'disponibilidade' | 'tamanho';

export interface MotivoLinguagem {
  categoria: CategoriaMotivo;
  /** Rótulo estável (ex.: `merge`, `sql`, `correção em 1ª pessoa`). */
  rotulo: string;
  /** Chave usada no "publicar mesmo assim": `<categoria>:<rotulo>`. */
  chave: string;
  /** Texto para a UI. */
  mensagem: string;
  /** Trecho e posição no texto, quando o detector os conhece (léxico e disponibilidade). */
  trecho: string | null;
  inicio: number | null;
  fim: number | null;
}

/** `ValidacaoResposta` (contrato registrado) + motivos detalhados e o problema de tamanho. */
export interface ResultadoValidacaoLinguagem extends ValidacaoResposta {
  tamanho: string[];
  motivos: MotivoLinguagem[];
}

const FRONTEIRA_ANTES = '(?<![\\p{L}\\p{N}_])';
const FRONTEIRA_DEPOIS = '(?![\\p{L}\\p{N}_])';

interface TermoLexico {
  rotulo: string;
  /** Corpo da regex (sem fronteiras). */
  padrao: string;
  /** Sigla: sensível a maiúsculas. */
  sigla?: boolean;
}

/**
 * Léxico extra (04 §8.3). Inclui as flexões comuns em pt-BR do jargão
 * aportuguesado ("mergeado", "commitar", "deployamos") — a fronteira Unicode
 * impede que o radical case dentro de palavras portuguesas.
 */
export const LEXICO_EXTRA: readonly TermoLexico[] = [
  { rotulo: 'branch', padrao: 'branch(?:es|s)?' },
  { rotulo: 'commit', padrao: 'commit(?:s|ar|ado|ados|ada|adas|amos|ei|ou)?' },
  { rotulo: 'merge', padrao: 'merge(?:s|ar|ado|ados|ada|adas|amos|ei|ou)?' },
  { rotulo: 'deploy', padrao: 'deploy(?:s|ar|ado|ados|ada|adas|amos|ei|ou)?' },
  { rotulo: 'PR', padrao: 'PRs?', sigla: true },
  { rotulo: 'pull request', padrao: 'pull\\s+requests?' },
  { rotulo: 'endpoint', padrao: 'endpoints?' },
  { rotulo: 'migration', padrao: 'migrations?' },
  { rotulo: 'schema', padrao: 'schemas?' },
  { rotulo: 'query', padrao: 'quer(?:y|ies)' },
  { rotulo: 'API', padrao: 'APIs?', sigla: true },
  { rotulo: 'worktree', padrao: 'worktrees?' },
  { rotulo: 'bug', padrao: 'bugs?' },
];

/** Disponibilidade afirmada (04 §8.2) — bloqueia só em `aguardando_publicacao`. */
export const LEXICO_DISPONIBILIDADE: readonly TermoLexico[] = [
  { rotulo: 'já está disponível', padrao: 'j[aá]\\s+est[aá]\\s+dispon[ií]ve(?:l|is)' },
  { rotulo: 'já estão disponíveis', padrao: 'j[aá]\\s+est[aã]o\\s+dispon[ií]ve(?:l|is)' },
  { rotulo: 'já pode usar', padrao: 'j[aá]\\s+(?:pode|podem|podemos)\\s+(?:usar|utilizar)' },
  { rotulo: 'no ar', padrao: 'no\\s+ar' },
  { rotulo: 'em produção', padrao: 'em\\s+produ[cç][aã]o' },
];

function compilar(t: TermoLexico): RegExp {
  return new RegExp(`${FRONTEIRA_ANTES}(?:${t.padrao})${FRONTEIRA_DEPOIS}`, t.sigla ? 'gu' : 'giu');
}

const LEXICO_COMPILADO = LEXICO_EXTRA.map((t) => ({ t, re: compilar(t) }));
const DISPONIBILIDADE_COMPILADA = LEXICO_DISPONIBILIDADE.map((t) => ({ t, re: compilar(t) }));

function ocorrencias(
  texto: string,
  lista: ReadonlyArray<{ t: TermoLexico; re: RegExp }>,
  categoria: 'lexico' | 'disponibilidade',
): MotivoLinguagem[] {
  const saida: MotivoLinguagem[] = [];
  const alvo = texto.normalize('NFC');
  for (const { t, re } of lista) {
    re.lastIndex = 0;
    for (const m of alvo.matchAll(re)) {
      const inicio = m.index ?? 0;
      saida.push({
        categoria,
        rotulo: t.rotulo,
        chave: `${categoria}:${t.rotulo}`,
        mensagem:
          categoria === 'lexico'
            ? `Termo técnico "${m[0]}": o cliente não precisa saber como a mudança foi feita.`
            : `"${m[0]}" afirma que a mudança já está no ar, mas ela ainda não foi publicada.`,
        trecho: m[0],
        inicio,
        fim: inicio + m[0].length,
      });
    }
  }
  return saida.sort((a, b) => (a.inicio ?? 0) - (b.inicio ?? 0));
}

const unicos = (xs: string[]): string[] => [...new Set(xs)];

/** `validarRespostaPublica(texto, tipo)` de 04 §8.3. Pura e determinística. */
export function validarRespostaPublica(
  texto: string,
  tipo: TipoResposta,
): ResultadoValidacaoLinguagem {
  const motivos: MotivoLinguagem[] = [];
  const t = texto ?? '';

  const tamanho: string[] = [];
  if (t.trim().length === 0) tamanho.push('vazia');
  else if (t.length > LIMITE_RESPOSTA_PUBLICA) tamanho.push('acima_do_limite');
  for (const rotulo of tamanho) {
    motivos.push({
      categoria: 'tamanho',
      rotulo,
      chave: `tamanho:${rotulo}`,
      mensagem:
        rotulo === 'vazia'
          ? 'A mensagem está vazia.'
          : `A mensagem tem ${t.length} caracteres; o limite é ${LIMITE_RESPOSTA_PUBLICA}.`,
      trecho: null,
      inicio: null,
      fim: null,
    });
  }

  const tecnico = detectarConteudoTecnico(t).motivos;
  for (const rotulo of tecnico) {
    motivos.push({
      categoria: 'tecnico',
      rotulo,
      chave: `tecnico:${rotulo}`,
      mensagem: `Conteúdo técnico (${rotulo}): detalhe de implementação vai na nota interna.`,
      trecho: null,
      inicio: null,
      fim: null,
    });
  }

  const promessa = detectarPromessaResolucao(t).motivos;
  for (const rotulo of promessa) {
    motivos.push({
      categoria: 'promessa',
      rotulo,
      chave: `promessa:${rotulo}`,
      mensagem: `Afirma correção já concluída (${rotulo}): use "já está disponível" ou o futuro.`,
      trecho: null,
      inicio: null,
      fim: null,
    });
  }

  const lexico = ocorrencias(t, LEXICO_COMPILADO, 'lexico');
  motivos.push(...lexico);
  const disponibilidade =
    tipo === 'aguardando_publicacao'
      ? ocorrencias(t, DISPONIBILIDADE_COMPILADA, 'disponibilidade')
      : [];
  motivos.push(...disponibilidade);

  return {
    tecnico,
    promessa,
    lexico: unicos(lexico.map((m) => m.rotulo)),
    disponibilidade: unicos(disponibilidade.map((m) => m.rotulo)),
    tamanho,
    ok: motivos.length === 0,
    motivos,
  };
}

/** Chaves (`<categoria>:<rotulo>`) dos motivos de uma validação, sem repetição. */
export function chavesDosMotivos(v: Pick<ResultadoValidacaoLinguagem, 'motivos'>): string[] {
  return unicos(v.motivos.map((m) => m.chave));
}

export interface DecisaoPublicacao {
  permitido: boolean;
  /** Motivos atuais não cobertos pela confirmação humana (motivo novo → nova confirmação). */
  motivos_nao_confirmados: string[];
}

/**
 * Pode publicar? Sim se a validação passou, ou se há um "publicar mesmo assim"
 * EXPLÍCITO cobrindo TODOS os motivos atuais (04 §8.4). Motivo de tamanho nunca
 * é dispensável: a API recusaria (≤ 50.000) ou o texto não diz nada.
 */
export function avaliarPublicacao(
  validacao: ResultadoValidacaoLinguagem,
  publicarMesmoAssim: { motivos: readonly string[] } | null,
): DecisaoPublicacao {
  if (validacao.ok) return { permitido: true, motivos_nao_confirmados: [] };
  const confirmados = new Set(publicarMesmoAssim?.motivos ?? []);
  const faltam = chavesDosMotivos(validacao).filter(
    (c) => c.startsWith('tamanho:') || !confirmados.has(c),
  );
  return { permitido: faltam.length === 0, motivos_nao_confirmados: faltam };
}
