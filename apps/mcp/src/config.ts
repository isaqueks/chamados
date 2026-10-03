import { validarBaseUrl, ErroUrlBase, type ConfigCliente } from '@chamados/cliente-api';

/**
 * Configuração do servidor MCP (specs/11 §7.1). Tudo por variável de ambiente —
 * é assim que Claude Code/Desktop passam credenciais a um servidor stdio.
 *
 * A validação da URL e o cliente HTTP vivem em `@chamados/cliente-api`
 * (specs/forja/01 §5.2); aqui fica só a leitura do env e o mapeamento para
 * `ConfigCliente`.
 *
 * Credencial: `CHAMADOS_SENHA` (login normal) **ou** `CHAMADOS_TOKEN` (sessão já
 * aberta — é como a Forja dá aos seus agentes este MCP em modo somente leitura,
 * reaproveitando o token da própria conexão; specs/forja FJ-030 §4). Com os dois,
 * o token vale primeiro e a senha só serve para relogar quando ele cair.
 *
 * Senha e token vivem SÓ na memória deste processo: nunca são logados, nunca
 * voltam numa mensagem de erro, nunca são gravados em disco.
 */

export interface ConfigMcp {
  /** Base da instalação, sem barra final (ex.: `https://suporte.empresa.com`). */
  baseUrl: string;
  email: string;
  /** `null` quando só há token — aí a sessão não se renova sozinha. */
  senha: string | null;
  /** Token de sessão já aberta (`CHAMADOS_TOKEN`), ou `null`. */
  token: string | null;
  /** Slug do tenant, quando o host não o resolve sozinho (dev em `localhost`). */
  tenantSlug: string | null;
  /** Registra apenas as ferramentas de leitura. */
  somenteLeitura: boolean;
  /** Avisos não bloqueantes da URL (ex.: `127.0.0.1`) — o `index.ts` os loga no stderr. */
  avisos: string[];
}

export class ErroConfig extends Error {}

function obrigatoria(env: NodeJS.ProcessEnv, nome: string): string {
  const v = env[nome]?.trim();
  if (!v) {
    throw new ErroConfig(
      `Variável de ambiente ${nome} não definida. Configure CHAMADOS_URL, CHAMADOS_EMAIL e CHAMADOS_SENHA (ou CHAMADOS_TOKEN) no servidor MCP (ver specs/11 §7.1).`,
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
 * Valida `CHAMADOS_URL` (http(s); HTTPS fora de localhost — specs/11 §7.3).
 * O erro do pacote vira `ErroConfig` para o `index.ts` sair com código 2.
 */
function urlBase(bruta: string): { origem: string; avisos: string[] } {
  try {
    const r = validarBaseUrl(bruta);
    return { origem: r.origem, avisos: r.avisos.map((a) => `CHAMADOS_URL: ${a.mensagem}`) };
  } catch (e) {
    if (e instanceof ErroUrlBase) throw new ErroConfig(`CHAMADOS_URL: ${e.message}`);
    throw e;
  }
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): ConfigMcp {
  const { origem, avisos } = urlBase(obrigatoria(env, 'CHAMADOS_URL'));
  const email = obrigatoria(env, 'CHAMADOS_EMAIL');
  // Aparadas como sempre foram (lixo de copiar/colar); vazio conta como ausente.
  const senha = env.CHAMADOS_SENHA?.trim() || null;
  const token = env.CHAMADOS_TOKEN?.trim() || null;
  if (!senha && !token) {
    throw new ErroConfig(
      'Defina CHAMADOS_SENHA ou CHAMADOS_TOKEN (um dos dois é obrigatório) no servidor MCP (ver specs/11 §7.1).',
    );
  }
  return {
    baseUrl: origem,
    email,
    senha,
    token,
    tenantSlug: env.CHAMADOS_TENANT?.trim() || null,
    somenteLeitura: booleana(env.CHAMADOS_MCP_SOMENTE_LEITURA),
    avisos,
  };
}

/**
 * Mapeia para o cliente HTTP: token inicial (se houver), senha do env só por
 * função (ausente no modo só-token — o cliente então não reloga), prazos padrão.
 */
export function configCliente(cfg: ConfigMcp): ConfigCliente {
  const senha = cfg.senha;
  return {
    baseUrl: cfg.baseUrl,
    email: cfg.email,
    ...(senha !== null ? { obterSenha: () => senha } : {}),
    tokenInicial: cfg.token,
    tenantSlug: cfg.tenantSlug,
  };
}
