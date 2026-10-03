/**
 * Detector de segredos antes do outbox (specs/forja/05 §8.2; 03 §9.1).
 *
 * POR QUE bloquear e não só redigir: nota interna e mensagem pública saem da
 * máquina e ficam no Chamados (e, a pública, no e-mail do cliente). Um acerto
 * aqui deixa o passo `bloqueado` (`precisa_humano`) para o humano editar; nunca
 * "manda com «redigido»" sem alguém ver.
 *
 * Cobre:
 *  - valores CONHECIDOS que o app injeta (token da sessão, valores dos `.env`
 *    copiados, `ANTHROPIC_API_KEY`) — o caso mais forte, porque é exato;
 *  - padrões genéricos de 05 §8.2: chave privada PEM, `ghp_`/`gho_`/`ghs_`/
 *    `github_pat_`, `sk-ant-`, `AKIA…`, strings de conexão com senha;
 *  - e alguns extras de alto sinal: JWT, `Bearer <token>`, tokens do Slack,
 *    chaves `sk-`/`sk_live_` e atribuições `senha=`/`password:`/`secret=` com valor.
 *
 * Os achados nunca carregam o valor: só tipo, posição e uma amostra mascarada.
 * `redigirSegredos` faz a substituição por `«redigido»` para o que vai a log,
 * evento ou artefato (05 §8.2).
 */

export const REDIGIDO = '«redigido»';

/** Valores conhecidos menores que isso não são procurados (falso positivo garantido). */
const MINIMO_VALOR_CONHECIDO = 8;

export interface AchadoSegredo {
  tipo: string;
  inicio: number;
  fim: number;
  /** Ex.: `ghp_…(40)` — nunca o valor. */
  amostra: string;
}

export interface ResultadoDeteccaoSegredos {
  ok: boolean;
  achados: AchadoSegredo[];
}

interface PadraoSegredo {
  tipo: string;
  re: RegExp;
  /** Grupo que contém o segredo em si (padrão: o casamento inteiro). */
  grupo?: number;
}

export const PADROES_SEGREDO: readonly PadraoSegredo[] = [
  {
    tipo: 'chave_privada_pem',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  },
  { tipo: 'token_github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { tipo: 'token_github', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { tipo: 'chave_anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { tipo: 'chave_aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { tipo: 'chave_api', re: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { tipo: 'chave_api', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { tipo: 'token_slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  {
    tipo: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // `scheme://usuario:senha@host` — a senha é o grupo 1. `${VAR}`/`***` não contam.
  {
    tipo: 'string_conexao_com_senha',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@[^\s/]+/gi,
    grupo: 1,
  },
  { tipo: 'bearer', re: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, grupo: 1 },
  // `senha = "…"`, `password: …`, `secret=…`, `api_key=…`, `token: …` com valor de verdade.
  {
    tipo: 'atribuicao_de_segredo',
    re: /\b(?:senha|password|passwd|pwd|secret|segredo|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|token)\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    grupo: 1,
  },
];

/** Valores que obviamente não são segredo (placeholder de exemplo/variável). */
function ehPlaceholder(valor: string): boolean {
  return (
    /^\$\{?[A-Z0-9_]+\}?$/.test(valor) ||
    /^<[^>]+>$/.test(valor) ||
    /^(?:\*+|x+|\.{3,}|«redigido»|redacted|changeme|exemplo|example|placeholder)$/i.test(valor)
  );
}

function mascarar(valor: string): string {
  return `${valor.slice(0, 4)}…(${valor.length})`;
}

export interface OpcoesDetector {
  /** Valores sensíveis conhecidos pelo app (token, `.env`, chave da API). */
  valoresConhecidos?: readonly string[];
}

export function detectarSegredos(
  texto: string,
  opcoes: OpcoesDetector = {},
): ResultadoDeteccaoSegredos {
  const alvo = texto ?? '';
  const achados: AchadoSegredo[] = [];

  for (const valor of opcoes.valoresConhecidos ?? []) {
    if (!valor || valor.length < MINIMO_VALOR_CONHECIDO) continue;
    let i = alvo.indexOf(valor);
    while (i !== -1) {
      achados.push({
        tipo: 'valor_conhecido',
        inicio: i,
        fim: i + valor.length,
        amostra: mascarar(valor),
      });
      i = alvo.indexOf(valor, i + valor.length);
    }
  }

  for (const { tipo, re, grupo } of PADROES_SEGREDO) {
    re.lastIndex = 0;
    for (const m of alvo.matchAll(re)) {
      const valor = grupo !== undefined ? m[grupo] : m[0];
      if (!valor || ehPlaceholder(valor)) continue;
      // "senha: expirada" é prosa, não segredo: exige algo além de letras.
      if (tipo === 'atribuicao_de_segredo' && /^[\p{L}-]+$/u.test(valor)) continue;
      const base = m.index ?? 0;
      const inicio = grupo !== undefined ? base + m[0].indexOf(valor) : base;
      achados.push({ tipo, inicio, fim: inicio + valor.length, amostra: mascarar(valor) });
    }
  }

  achados.sort((a, b) => a.inicio - b.inicio || b.fim - a.fim);
  // Remove achados contidos em outro (o mesmo trecho visto por dois padrões).
  const sem: AchadoSegredo[] = [];
  for (const a of achados) {
    const ultimo = sem[sem.length - 1];
    if (ultimo && a.inicio >= ultimo.inicio && a.fim <= ultimo.fim) continue;
    sem.push(a);
  }
  return { ok: sem.length === 0, achados: sem };
}

/** Substitui cada segredo detectado por `«redigido»` (para log, evento, artefato — 05 §8.2). */
export function redigirSegredos(texto: string, opcoes: OpcoesDetector = {}): string {
  const { achados } = detectarSegredos(texto, opcoes);
  let saida = '';
  let cursor = 0;
  for (const a of achados) {
    if (a.inicio < cursor) continue;
    saida += texto.slice(cursor, a.inicio) + REDIGIDO;
    cursor = a.fim;
  }
  return saida + texto.slice(cursor);
}
