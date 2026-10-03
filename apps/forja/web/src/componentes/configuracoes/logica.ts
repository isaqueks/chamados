import type { ConfiguracoesGlobaisDto } from '@comum/dto';
import { ConfiguracoesGlobaisSchema } from '@comum/config-projeto';
import { caminhoLegivel, mensagemLegivel } from '../apoio/zod-legivel';

/**
 * Lógica pura da tela Configurações (FJ-030 §2): as preferências GLOBAIS que
 * saíram da config do projeto — modelos, cota, concorrência, limites e gates.
 * Valida pelo MESMO zod do servidor (`ConfiguracoesGlobaisSchema`), com as
 * mensagens traduzidas e chaveadas pelo caminho do campo
 * (`limites.timeout_min.planejar`) para ficarem embaixo do controle.
 */

export type ErrosConfiguracoes = Record<string, string>;

export function validarConfiguracoes(
  form: ConfiguracoesGlobaisDto,
): { ok: true; dto: ConfiguracoesGlobaisDto } | { ok: false; erros: ErrosConfiguracoes } {
  const r = ConfiguracoesGlobaisSchema.safeParse(form);
  if (!r.success) {
    const erros: ErrosConfiguracoes = {};
    for (const i of r.error.issues) {
      const chave = caminhoLegivel(i.path);
      if (!(chave in erros)) erros[chave] = mensagemLegivel(i);
    }
    return { ok: false, erros };
  }
  const erros = regrasEntreCampos(r.data);
  if (Object.keys(erros).length > 0) return { ok: false, erros };
  return { ok: true, dto: r.data };
}

/** O que o schema não diz (só roda quando a forma já passou). */
function regrasEntreCampos(c: ConfiguracoesGlobaisDto): ErrosConfiguracoes {
  const erros: ErrosConfiguracoes = {};
  const o = c.limites.orcamento_usd;
  if (o.por_chamado < Math.max(o.planejar, o.implementar, o.revisar, o.relatar)) {
    erros['limites.orcamento_usd.por_chamado'] = 'menor que o orçamento de uma etapa';
  }
  return erros;
}

/** Quantos valores diferem do padrão (para o resumo "N ajustes"; 0 = usando os padrões). */
export function contarAjustes(c: unknown, padrao: unknown): number {
  if (typeof c !== 'object' || c === null || typeof padrao !== 'object' || padrao === null) {
    return Object.is(c, padrao) ? 0 : 1;
  }
  const a = c as Record<string, unknown>;
  const b = padrao as Record<string, unknown>;
  let n = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) n += contarAjustes(a[k], b[k]);
  return n;
}
