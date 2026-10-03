import { z } from 'zod';
import type { CodigoErroConexao, ConexaoDto, SalvarConexaoDto } from '@comum/dto';

/**
 * Formulário da Conexão com o Chamados (specs/forja/06 §4.9; entidade em
 * 02 §4.1; credencial em F-20). Fica junto do Projeto porque todo projeto
 * aponta para uma conexão (`projeto.conexao_id`).
 *
 * Regras que a UI antecipa (o servidor confere de novo no login):
 * - em dev, `http://localhost:3000` + slug, NUNCA `127.0.0.1` [V 02 §8]: o
 *   cookie de sessão do Chamados é emitido para `localhost`;
 * - URL base é só a origem (sem caminho, query ou fragmento);
 * - em produção, `https` (a senha e o token trafegam por ela);
 * - a senha só é obrigatória ao criar: ao editar, vazio = manter a guardada.
 *   Ela vai direto ao keyring (fallback arquivo 0600) e nunca volta em DTO.
 *
 * FJ-030 §5 (Conexão simplificada): a tela pede só URL, e-mail e senha — e o
 * tenant apenas quando o host é `localhost` (em produção o host identifica o
 * tenant). Nome, ambiente e onde guardar a senha são DERIVADOS
 * (`montarConexaoSimples`); o DTO do servidor (`SalvarConexaoDto`) não mudou.
 */

const HOSTS_IP_LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** Mensagem de erro da URL base, ou `null` se estiver boa. */
export function problemaUrlBase(
  texto: string,
  ambiente: SalvarConexaoDto['ambiente'],
): string | null {
  const t = texto.trim();
  if (!t) return 'obrigatório';
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return 'URL inválida (ex.: https://chamados.suaempresa.com.br)';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'use http:// ou https://';
  if (HOSTS_IP_LOOPBACK.has(url.hostname)) {
    return 'use http://localhost:3000, nunca 127.0.0.1 (o cookie do Chamados é emitido para localhost)';
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return 'informe só a origem, sem caminho (ex.: https://chamados.suaempresa.com.br)';
  }
  if (url.username || url.password) return 'não coloque credenciais na URL';
  if (ambiente === 'producao' && url.protocol !== 'https:') {
    return 'em produção, use https://';
  }
  return null;
}

/** Origem normalizada (sem barra final), como o `validarBaseUrl` do cliente da API. */
export function normalizarUrlBase(texto: string): string {
  return texto.trim().replace(/\/+$/, '');
}

export function esquemaConexao(criando: boolean) {
  return z
    .object({
      nome: z
        .string()
        .trim()
        .min(1, 'obrigatório')
        .max(60, 'no máximo 60 caracteres')
        .regex(/^[a-z0-9][a-z0-9-]*$/i, 'use letras, números e "-" (ex.: prod-acme)'),
      url_base: z.string(),
      tenant_slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug do tenant: minúsculas, números e "-"')
        .nullable(),
      ambiente: z.enum(['dev', 'producao']),
      email: z.string().trim().pipe(z.email('e-mail inválido')),
      senha: z.string().optional(),
      local_senha: z.enum(['keyring', 'arquivo', 'nao_guardada']),
    })
    .superRefine((v, ctx) => {
      const problema = problemaUrlBase(v.url_base, v.ambiente);
      if (problema) ctx.addIssue({ code: 'custom', path: ['url_base'], message: problema });
      if (criando && !v.senha) {
        ctx.addIssue({
          code: 'custom',
          path: ['senha'],
          message: 'obrigatória para o primeiro login',
        });
      }
    });
}

export function validarConexao(
  form: SalvarConexaoDto,
  criando: boolean,
): { ok: true; dto: SalvarConexaoDto } | { ok: false; erros: Record<string, string> } {
  const entrada: SalvarConexaoDto = {
    ...form,
    tenant_slug: form.tenant_slug?.trim() ? form.tenant_slug.trim() : null,
    senha: form.senha ? form.senha : undefined,
  };
  const r = esquemaConexao(criando).safeParse(entrada);
  if (!r.success) {
    const erros: Record<string, string> = {};
    for (const i of r.error.issues) {
      const chave = i.path.map(String).join('.');
      if (!(chave in erros)) erros[chave] = i.message;
    }
    return { ok: false, erros };
  }
  const dto: SalvarConexaoDto = {
    nome: r.data.nome,
    url_base: normalizarUrlBase(r.data.url_base),
    tenant_slug: r.data.tenant_slug,
    ambiente: r.data.ambiente,
    email: r.data.email,
    local_senha: r.data.local_senha,
    ...(r.data.senha ? { senha: r.data.senha } : {}),
  };
  return { ok: true, dto };
}

export function formularioConexaoNovo(): SalvarConexaoDto {
  return {
    nome: 'dev-local',
    url_base: 'http://localhost:3000',
    tenant_slug: null,
    ambiente: 'dev',
    email: '',
    senha: '',
    local_senha: 'keyring',
  };
}

export function formularioDeConexao(c: ConexaoDto): SalvarConexaoDto {
  return {
    nome: c.nome,
    url_base: c.url_base,
    tenant_slug: c.tenant_slug,
    ambiente: c.ambiente,
    email: c.email,
    senha: '',
    local_senha: c.local_senha,
  };
}

// ---------------------------------------------------------------------------
// Formulário simples (FJ-030 §5)
// ---------------------------------------------------------------------------

export interface FormConexaoSimples {
  url_base: string;
  email: string;
  senha: string;
  tenant_slug: string;
}

function hostDe(texto: string): string | null {
  try {
    return new URL(texto.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** O tenant só aparece em `localhost` (dev: o host não identifica o tenant). */
export function ehLocalhost(urlBase: string): boolean {
  const h = hostDe(urlBase);
  return h === 'localhost' || (h?.endsWith('.localhost') ?? false);
}

/** `https` = produção (confirmações em vermelho); `http` só existe em dev. */
export function ambienteDaUrl(urlBase: string): SalvarConexaoDto['ambiente'] {
  return urlBase.trim().toLowerCase().startsWith('https://') && !ehLocalhost(urlBase)
    ? 'producao'
    : 'dev';
}

/** Rótulo da conexão a partir do host: "chamados.acme.com.br" → "chamados-acme-com-br". */
export function nomeDaConexao(urlBase: string): string {
  const h = hostDe(urlBase);
  if (!h || ehLocalhost(urlBase)) return 'dev-local';
  const nome = h
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return nome || 'chamados';
}

export function formularioSimplesDe(c: ConexaoDto | null): FormConexaoSimples {
  return c
    ? { url_base: c.url_base, email: c.email, senha: '', tenant_slug: c.tenant_slug ?? '' }
    : { url_base: 'http://localhost:3000', email: '', senha: '', tenant_slug: '' };
}

/**
 * Formulário simples → `SalvarConexaoDto` validado. Ao editar, o nome e o
 * local da senha que já existem são preservados (o usuário não os vê mais,
 * então não podem mudar por baixo dele); o tenant some fora de `localhost`.
 */
export function montarConexaoSimples(
  form: FormConexaoSimples,
  existente: ConexaoDto | null,
): { ok: true; dto: SalvarConexaoDto } | { ok: false; erros: Record<string, string> } {
  const local = ehLocalhost(form.url_base);
  return validarConexao(
    {
      nome: existente?.nome ?? nomeDaConexao(form.url_base),
      url_base: form.url_base,
      tenant_slug: local && form.tenant_slug.trim() ? form.tenant_slug.trim() : null,
      ambiente: ambienteDaUrl(form.url_base),
      email: form.email,
      senha: form.senha,
      local_senha: existente?.local_senha ?? 'keyring',
    },
    !existente,
  );
}

/** Causa legível + o que fazer, por código (06 §4.9: "erros com causa legível"). */
export const EXPLICACAO_ERRO_CONEXAO: Record<CodigoErroConexao, { causa: string; acao: string }> = {
  credencial_invalida: {
    causa: 'E-mail ou senha recusados pelo Chamados.',
    acao: 'Confira a senha do operador dedicado e use [Relogar].',
  },
  limite_login: {
    causa: 'O Chamados bloqueou novos logins por excesso de tentativas.',
    acao: 'Aguarde alguns minutos antes de tentar de novo.',
  },
  rede: {
    causa: 'O Chamados não respondeu (rede fora ou endereço errado).',
    acao: 'Confira a URL base e se o servidor está de pé.',
  },
  tls: {
    causa: 'O certificado TLS do servidor não foi aceito.',
    acao: 'Confira o https:// e o certificado da instalação.',
  },
  tenant_inexistente: {
    causa: 'O tenant informado não existe nesta instalação.',
    acao: 'Confira o slug do tenant (em dev ele vai no cabeçalho x-tenant-slug).',
  },
  papel_recusado: {
    causa: 'O usuário não é operador: a Forja precisa de um operador.',
    acao: 'Crie um operador dedicado no Chamados e use as credenciais dele.',
  },
  url_loopback_ip: {
    causa: 'A URL usa 127.0.0.1: o cookie do Chamados é emitido para localhost.',
    acao: 'Troque para http://localhost:3000.',
  },
  outro: {
    causa: 'O Chamados recusou a conexão.',
    acao: 'Veja o detalhe abaixo e tente de novo.',
  },
};

export const ROTULO_LOCAL_SENHA: Record<SalvarConexaoDto['local_senha'], string> = {
  keyring: 'Chaveiro do sistema (recomendado)',
  arquivo: 'Arquivo local com permissão 0600',
  nao_guardada: 'Não guardar (pede a senha a cada relogin)',
};

/** Aviso de papel (F-20): admin funciona, mas o recomendado é um operador dedicado. */
export function avisoPapel(papel: string | null | undefined): string | null {
  if (!papel) return null;
  if (papel === 'admin') {
    return 'Conectado como admin: recomendamos um operador dedicado (as mensagens públicas saem em nome dele).';
  }
  if (papel === 'cliente') return 'Papel cliente é recusado: a Forja precisa de um operador.';
  return null;
}
