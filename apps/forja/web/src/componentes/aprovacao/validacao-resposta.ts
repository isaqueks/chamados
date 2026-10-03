import { detectarConteudoTecnico, detectarPromessaResolucao } from '@chamados/shared';
import type { ValidacaoResposta } from '@comum/contratos';

/**
 * Validação ao vivo da resposta ao cliente (specs/forja/06 §4.3 aba "Resposta
 * ao cliente"; 04 §8; F-16). A fonte da verdade é o servidor
 * (`aprovacao_validar_resposta`, que soma o léxico extra e a regra de
 * disponibilidade ao tipo da resposta) — e ele valida de novo ao publicar.
 *
 * POR QUE existe uma versão local: a validação "ao vivo" não pode esperar a
 * rede a cada tecla, e o editor precisa sublinhar os trechos. Usamos os MESMOS
 * detectores de `@chamados/shared` (D-015, D-022) como prévia instantânea; a
 * resposta do servidor substitui a prévia assim que chega.
 */

/** Prévia local: só os detectores compartilhados (sem léxico extra). */
export function validarLocalmente(texto: string): ValidacaoResposta {
  const tecnico = detectarConteudoTecnico(texto).motivos;
  const promessa = detectarPromessaResolucao(texto).motivos;
  return {
    tecnico,
    promessa,
    lexico: [],
    disponibilidade: [],
    ok: tecnico.length === 0 && promessa.length === 0,
  };
}

export interface ViolacaoExplicada {
  categoria: 'tecnico' | 'promessa' | 'lexico' | 'disponibilidade';
  item: string;
  explicacao: string;
}

const EXPLICACAO: Record<ViolacaoExplicada['categoria'], string> = {
  tecnico: 'conteúdo técnico: o cliente não deve ver código, caminhos ou SQL',
  promessa: 'promete correção já feita: o cliente só vê depois que estiver no ar',
  lexico: 'termo vetado pelo projeto',
  disponibilidade: 'diz que já está disponível, mas o merge não publica (aguardando publicação)',
};

export function explicarViolacoes(v: ValidacaoResposta): ViolacaoExplicada[] {
  const saida: ViolacaoExplicada[] = [];
  for (const categoria of ['tecnico', 'promessa', 'lexico', 'disponibilidade'] as const) {
    for (const item of v[categoria]) {
      saida.push({ categoria, item, explicacao: EXPLICACAO[categoria] });
    }
  }
  return saida;
}

export interface Segmento {
  texto: string;
  marcado: boolean;
}

/**
 * Quebra o texto em segmentos marcados/não marcados para sublinhar as
 * violações. Itens do validador que são trechos literais do texto são
 * sublinhados (sem diferenciar maiúsculas); rótulos genéricos ("sql",
 * "bloco de código") não aparecem no texto e ficam só na lista explicada.
 */
export function marcarTrechos(texto: string, trechos: readonly string[]): Segmento[] {
  const alvos = [...new Set(trechos.map((t) => t.trim()).filter((t) => t.length >= 2))];
  if (alvos.length === 0 || texto.length === 0) return texto ? [{ texto, marcado: false }] : [];
  const minusculo = texto.toLowerCase();
  const marcas = new Array<boolean>(texto.length).fill(false);
  for (const alvo of alvos) {
    const a = alvo.toLowerCase();
    let i = minusculo.indexOf(a);
    while (i !== -1) {
      for (let k = i; k < i + a.length; k += 1) marcas[k] = true;
      i = minusculo.indexOf(a, i + a.length);
    }
  }
  const segmentos: Segmento[] = [];
  let inicio = 0;
  for (let i = 1; i <= texto.length; i += 1) {
    if (i === texto.length || marcas[i] !== marcas[inicio]) {
      segmentos.push({ texto: texto.slice(inicio, i), marcado: marcas[inicio]! });
      inicio = i;
    }
  }
  return segmentos;
}

/** URLs presentes na resposta (05 §6.4 item 4: destacadas antes de publicar). */
export function urlsNoTexto(texto: string): string[] {
  const achadas = texto.match(/\bhttps?:\/\/[^\s<>()"']+/gi) ?? [];
  return [...new Set(achadas.map((u) => u.replace(/[.,;:!?]+$/, '')))];
}
