import type { z } from 'zod';

/**
 * Mensagens do zod em pt-BR, legíveis por quem não lê schema (06 §6 item 9:
 * "erros dizem a causa e a ação"). Os schemas de `comum/config-projeto.ts`
 * usam as mensagens padrão do zod (em inglês, técnicas); a SPA traduz pelo
 * CÓDIGO do problema em vez de reescrever os schemas — o contrato fica um só.
 */

type Problema = z.core.$ZodIssue;

/** `['comandos','verificacao',0,'timeout_s']` → `comandos.verificacao[0].timeout_s`. */
export function caminhoLegivel(path: readonly PropertyKey[]): string {
  let s = '';
  for (const p of path) {
    if (typeof p === 'number') s += `[${p}]`;
    else s += s ? `.${String(p)}` : String(p);
  }
  return s;
}

/** Só a mensagem (sem o caminho): para ficar embaixo do campo. */
export function mensagemLegivel(p: Problema): string {
  switch (p.code) {
    case 'unrecognized_keys': {
      const varias = p.keys.length > 1;
      return `chave${varias ? 's' : ''} desconhecida${varias ? 's' : ''}: ${p.keys.map((k) => `"${k}"`).join(', ')}`;
    }
    case 'invalid_value':
      return `use um de: ${p.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'invalid_type':
      switch (p.expected) {
        case 'object':
          return 'precisa ser um objeto { … }';
        case 'array':
          return 'precisa ser uma lista [ … ]';
        case 'boolean':
          return 'use true ou false';
        case 'number':
          return 'informe um número';
        case 'int':
          return 'precisa ser um número inteiro';
        case 'string':
          return 'precisa ser texto entre aspas';
        default:
          return `tipo inválido (esperado ${p.expected})`;
      }
    case 'too_small':
      if (p.origin === 'string')
        return Number(p.minimum) <= 1 ? 'não pode ser vazio' : `pelo menos ${p.minimum} caracteres`;
      if (p.origin === 'array')
        return `pelo menos ${p.minimum} ${Number(p.minimum) === 1 ? 'item' : 'itens'}`;
      return p.inclusive === false ? `precisa ser maior que ${p.minimum}` : `mínimo ${p.minimum}`;
    case 'too_big':
      if (p.origin === 'string') return `no máximo ${p.maximum} caracteres`;
      if (p.origin === 'array') return `no máximo ${p.maximum} itens`;
      return p.inclusive === false ? `precisa ser menor que ${p.maximum}` : `máximo ${p.maximum}`;
    case 'invalid_format':
      if (p.format === 'starts_with' && 'prefix' in p)
        return `precisa começar com "${String(p.prefix)}"`;
      return 'formato inválido';
    default:
      return p.message;
  }
}

/** Uma linha por problema, com o caminho da chave (para o texto do Avançado). */
export function problemaLegivel(p: Problema): string {
  const onde = caminhoLegivel(p.path);
  return onde ? `${onde}: ${mensagemLegivel(p)}` : mensagemLegivel(p);
}
