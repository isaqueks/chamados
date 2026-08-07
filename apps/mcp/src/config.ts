/**
 * Configuração do servidor MCP (specs/11 §7.1). Tudo por variável de ambiente —
 * é assim que Claude Code/Desktop passam credenciais a um servidor stdio.
 *
 * A senha vive SÓ na memória deste processo: nunca é logada, nunca volta numa
 * mensagem de erro, nunca é gravada em disco.
 */

export interface ConfigMcp {
  /** Base da instalação, sem barra final (ex.: `https://suporte.empresa.com`). */
  baseUrl: string;
  email: string;
  senha: string;
  /** Slug do tenant, quando o host não o resolve sozinho (dev em `localhost`). */
  tenantSlug: string | null;
  /** Registra apenas as ferramentas de leitura. */
  somenteLeitura: boolean;
}

export class ErroConfig extends Error {}

function obrigatoria(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) {
    throw new ErroConfig(
      `Variável de ambiente ${nome} não definida. Configure CHAMADOS_URL, CHAMADOS_EMAIL e CHAMADOS_SENHA no servidor MCP (ver specs/11 §7.1).`,
    );
  }
  return v;
}

/** `true` só para as grafias explícitas — qualquer outra coisa é `false`. */
function booleana(valor: string | undefined): boolean {
  const v = valor?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'sim';
}

/**
 * Valida a URL base: precisa ser http(s) e, fora de `localhost`, **HTTPS** — a
 * senha vai no corpo do login e o token em header (specs/11 §7.3).
 */
export function validarBaseUrl(bruta: string): string {
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    throw new ErroConfig(
      `CHAMADOS_URL inválida: "${bruta}". Use algo como https://suporte.empresa.com.`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ErroConfig(`CHAMADOS_URL deve usar http ou https (recebido: ${url.protocol}).`);
  }
  const local =
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !local) {
    throw new ErroConfig(
      'CHAMADOS_URL deve ser HTTPS fora de localhost: a senha trafega no corpo do login.',
    );
  }
  return url.origin;
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): ConfigMcp {
  return {
    baseUrl: validarBaseUrl(obrigatoria(env, 'CHAMADOS_URL')),
    email: obrigatoria(env, 'CHAMADOS_EMAIL'),
    senha: obrigatoria(env, 'CHAMADOS_SENHA'),
    tenantSlug: env.CHAMADOS_TENANT?.trim() || null,
    somenteLeitura: booleana(env.CHAMADOS_MCP_SOMENTE_LEITURA),
  };
}
