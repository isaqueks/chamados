import { isIP } from 'node:net';

/**
 * Validação anti-SSRF da URL de webhook (specs/06 §3.2, specs/09 §2/§5 — hardening
 * M10 frente B). O webhook é uma URL controlada pelo TENANT para onde a plataforma
 * faz POST — um vetor clássico de SSRF (forçar o servidor a bater em serviços
 * internos: metadata da nuvem 169.254.169.254, Redis/Postgres locais, painel de
 * admin em rede privada, etc.).
 *
 * Regras (aplicadas no SALVAMENTO da config, no ENVIO pelo worker e no evento de
 * TESTE — que lê a URL já persistida, logo herda a validação):
 *  - só `http(s)` (sem `file:`, `gopher:`, `ftp:`…);
 *  - sem credenciais embutidas (`user:pass@`);
 *  - bloqueia hosts privados/loopback/link-local/metadata:
 *      127.0.0.0/8 · 10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16 · 169.254.0.0/16
 *      · 100.64.0.0/10 (CGNAT) · 0.0.0.0/8 · ::1 · fc00::/7 · fe80::/10 · IPv4
 *      mapeado em IPv6 · `localhost` e sufixos `.localhost`/`.local`/`.internal`;
 *  - bloqueia formas ofuscadas de IP (decimal/hex sem pontos).
 *
 * Em DEV, `NOTIFICACOES_WEBHOOK_PERMITIR_PRIVADO=true` libera hosts privados
 * (para testar contra um receptor local, ex.: `http://localhost:4000/hook`).
 *
 * Módulo PURO (sem I/O de rede — NÃO resolve DNS): decide pela URL. A resolução
 * DNS→IP privado (rebinding) é risco residual documentado; o adapter de envio usa
 * timeout curto e sem redirect como mitigações adicionais.
 */

export type MotivoUrlWebhook =
  'malformada' | 'esquema_invalido' | 'credenciais' | 'host_ausente' | 'host_privado';

export type ResultadoUrlWebhook =
  { ok: true; url: URL } | { ok: false; motivo: MotivoUrlWebhook; mensagem: string };

const MENSAGENS: Record<MotivoUrlWebhook, string> = {
  malformada: 'URL inválida. Informe um endereço http(s) válido.',
  esquema_invalido: 'A URL do webhook deve começar com http:// ou https://.',
  credenciais: 'A URL do webhook não pode conter usuário/senha embutidos.',
  host_ausente: 'URL inválida: host ausente.',
  host_privado:
    'Endereço de rede interna/privada não é permitido no webhook (proteção contra SSRF). ' +
    'Use um endpoint público acessível pela internet.',
};

/** Flag de dev que libera hosts privados. */
export function permitirWebhookPrivado(): boolean {
  return process.env.NOTIFICACOES_WEBHOOK_PERMITIR_PRIVADO === 'true';
}

/** Um octeto/inteiro de IPv4 (0-255)? */
function octetoValido(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 255;
}

/** IPv4 (dotted) em faixa privada/reservada/loopback/link-local/metadata? */
function ipv4Privado(host: string): boolean {
  const partes = host.split('.');
  if (partes.length !== 4) return false;
  const oct = partes.map((p) => Number(p));
  if (!oct.every(octetoValido)) return false;
  const [a, b] = oct as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (this host)
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local + metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  return false;
}

/**
 * Expande um IPv6 (incl. `::` e IPv4 embutido/mapeado) para os 16 bytes. `null`
 * se malformado. Necessário porque o parser de URL do Node normaliza formas
 * diferentes (ex.: `::ffff:127.0.0.1` → `::ffff:7f00:1`).
 */
function expandirIPv6(host: string): number[] | null {
  let h = host.toLowerCase();
  const pct = h.indexOf('%'); // remove zona de escopo (%eth0)
  if (pct >= 0) h = h.slice(0, pct);

  const paraGrupos = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g.includes('.')) {
        const oct = g.split('.').map((p) => Number(p));
        if (oct.length !== 4 || !oct.every(octetoValido)) return null;
        out.push((oct[0]! << 8) | oct[1]!, (oct[2]! << 8) | oct[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  const dupla = h.split('::');
  if (dupla.length > 2) return null;
  let grupos: number[];
  if (dupla.length === 2) {
    const head = paraGrupos(dupla[0]!);
    const tail = paraGrupos(dupla[1]!);
    if (!head || !tail) return null;
    const faltam = 8 - head.length - tail.length;
    if (faltam < 0) return null;
    grupos = [...head, ...Array<number>(faltam).fill(0), ...tail];
  } else {
    const g = paraGrupos(h);
    if (!g) return null;
    grupos = g;
  }
  if (grupos.length !== 8) return null;

  const bytes: number[] = [];
  for (const w of grupos) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

/** IPv6 loopback/ULA/link-local/mapeado/não-especificado? Host SEM colchetes. */
function ipv6Privado(host: string): boolean {
  const b = expandirIPv6(host);
  if (!b) return true; // não parseou → trata como suspeito (fail-closed).
  if (b.every((x) => x === 0)) return true; // :: (unspecified)
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 (ULA)
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 (link-local)
  // IPv4-mapeado ::ffff:a.b.c.d — reavalia o IPv4 embutido.
  const mapeado = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (mapeado) return ipv4Privado(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  return false;
}

/**
 * Hostname textual (não-IP) considerado interno? `localhost` e sufixos comuns de
 * rede interna. Nomes DNS públicos passam (a resolução para IP privado é risco
 * residual — ver cabeçalho).
 */
function hostnameInterno(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

/** Host privado/interno/ofuscado? (não considera a flag de dev). */
export function hostWebhookPrivado(hostname: string): boolean {
  if (!hostname) return true;
  // URL com IPv6 vem com colchetes no `hostname`? Node remove os colchetes em
  // `URL.hostname`; garantimos aqui por robustez.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');

  const tipo = isIP(host);
  if (tipo === 4) return ipv4Privado(host);
  if (tipo === 6) return ipv6Privado(host);

  // IP ofuscado (decimal/hex/octal sem os 4 octetos) — ex.: http://2130706433/
  // (=127.0.0.1) ou http://0x7f000001/. Tratamos como suspeito → privado.
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^\d+$/.test(host)) return true;

  return hostnameInterno(host);
}

/**
 * Valida a URL do webhook. `opts.permitirPrivado` sobrepõe a flag de env (default:
 * `permitirWebhookPrivado()`). Retorna a `URL` normalizada quando OK.
 */
export function validarUrlWebhook(
  bruta: string,
  opts: { permitirPrivado?: boolean } = {},
): ResultadoUrlWebhook {
  const texto = (bruta ?? '').trim();
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return { ok: false, motivo: 'malformada', mensagem: MENSAGENS.malformada };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, motivo: 'esquema_invalido', mensagem: MENSAGENS.esquema_invalido };
  }
  if (url.username || url.password) {
    return { ok: false, motivo: 'credenciais', mensagem: MENSAGENS.credenciais };
  }
  if (!url.hostname) {
    return { ok: false, motivo: 'host_ausente', mensagem: MENSAGENS.host_ausente };
  }

  const permitir = opts.permitirPrivado ?? permitirWebhookPrivado();
  if (!permitir && hostWebhookPrivado(url.hostname)) {
    return { ok: false, motivo: 'host_privado', mensagem: MENSAGENS.host_privado };
  }

  return { ok: true, url };
}

/** Erro lançado quando uma URL de webhook privada/inválida tenta ser persistida. */
export class WebhookUrlInvalidaError extends Error {
  readonly motivo: MotivoUrlWebhook;
  constructor(motivo: MotivoUrlWebhook, mensagem: string) {
    super(mensagem);
    this.name = 'WebhookUrlInvalidaError';
    this.motivo = motivo;
  }
}
