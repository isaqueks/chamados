import { readFileSync } from 'node:fs';
import { escaparHtml } from '@chamados/db';

/**
 * Layout único dos e-mails (D-047): o visual da "Cobrança de Serviços" da
 * consultoria — logo no topo, título grande + metadados à direita, régua
 * azul-marinho, seções separadas por linhas finas, linha de destaque no estilo
 * "Total" e rodapé com os dados do emitente. Identidade FIXA da plataforma (não
 * usa cor/logo do tenant), na mesma linha dos PDFs da IA.
 *
 * Só HTML compatível com clientes de e-mail: tabelas, estilos inline, fonte de
 * sistema; o `<style>` do `<head>` serve apenas para empilhar colunas no celular.
 * Os blocos recebem HTML JÁ ESCAPADO — quem chama escapa o conteúdo de usuário.
 */

/** Paleta extraída do PDF de referência. */
export const COR = {
  marinho: '#0b4189',
  tinta: '#18212b',
  texto: '#3a4550',
  suave: '#6b7480',
  linha: '#d7dce2',
  fundo: '#eef0f3',
} as const;

const FONTE = "Arial,Helvetica,'Liberation Sans',sans-serif";

/** Dados do emitente impressos no rodapé (D-047). */
export const EMITENTE = {
  empresa: 'Isaque Schluter Consultoria em TI',
  cnpj: 'CNPJ 51.943.042/0001-05',
  pessoa: 'Isaque Schluter',
  email: 'iskschluter@gmail.com',
  telefone: '51 98953 7060',
} as const;

/** Content-ID do logo, anexado inline em todo e-mail (`<img src="cid:…">`). */
export const LOGO_CID = 'logo@chamados';

/** Imagem embutida no e-mail por Content-ID (multipart/related). */
export interface ImagemInline {
  cid: string;
  nomeArquivo: string;
  contentType: string;
  conteudo: Buffer;
}

let logoCache: Buffer | null = null;

/**
 * Logo como anexo inline. Vai embutido (e não por URL) porque vários clientes
 * escondem imagens remotas por padrão e o Gmail bloqueia `data:` URI.
 */
export function logoInline(): ImagemInline {
  logoCache ??= readFileSync(new URL('../../assets/email/logo.png', import.meta.url));
  return {
    cid: LOGO_CID,
    nomeArquivo: 'logo.png',
    contentType: 'image/png',
    conteudo: logoCache,
  };
}

/** Data de emissão (dd/mm/aaaa, horário de Brasília). */
export function dataEmissao(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

/** Texto em negrito na cor de título (para valores dentro de parágrafos/bullets). */
export function negrito(htmlEscapado: string): string {
  return `<b style="color:${COR.tinta};">${htmlEscapado}</b>`;
}

export function divisoria(): string {
  return `<tr><td style="padding:0;"><div style="height:1px;line-height:1px;font-size:0;background:${COR.linha};">&nbsp;</div></td></tr>`;
}

/** Seção: título opcional + parágrafo, citação (pre-line) e/ou tópicos. */
export function secao(s: {
  titulo?: string;
  paragrafo?: string;
  citacao?: string;
  bullets?: string[];
}): string {
  const h = s.titulo
    ? `<p style="margin:0 0 8px;font-size:16px;font-weight:bold;color:${COR.tinta};">${s.titulo}</p>`
    : '';
  const p = s.paragrafo
    ? `<p style="margin:0 0 ${s.bullets ? 10 : 0}px;font-size:15px;line-height:1.6;color:${COR.texto};">${s.paragrafo}</p>`
    : '';
  const q = s.citacao
    ? `<p style="margin:0;font-size:15px;line-height:1.6;color:${COR.texto};white-space:pre-line;border-left:3px solid ${COR.marinho};padding:2px 0 2px 14px;">${s.citacao}</p>`
    : '';
  const ul = s.bullets?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${s.bullets
        .map(
          (b) =>
            `<tr><td valign="top" width="22" style="font-size:15px;line-height:1.6;color:${COR.marinho};padding:2px 0;">&bull;</td><td style="font-size:15px;line-height:1.6;color:${COR.texto};padding:2px 0;">${b}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  return `<tr><td style="padding:22px 0;">${h}${p}${ul}${q}</td></tr>`;
}

/** Linha de destaque (o "Total" do PDF): a 1ª linha em valor grande marinho. */
export function destaque(linhas: Array<{ rotulo: string; valor: string }>): string {
  if (linhas.length === 0) return '';
  const tr = linhas
    .map((l, i) =>
      i === 0
        ? `<tr><td style="font-size:17px;font-weight:bold;color:${COR.tinta};padding:0 0 14px;">${l.rotulo}</td><td align="right" style="font-size:28px;font-weight:bold;color:${COR.marinho};padding:0 0 14px 16px;">${l.valor}</td></tr>`
        : `<tr><td style="font-size:15px;color:${COR.texto};padding:0 0 10px;">${l.rotulo}</td><td align="right" style="font-size:15px;font-weight:bold;color:${COR.tinta};padding:0 0 10px 16px;">${l.valor}</td></tr>`,
    )
    .join('');
  return `<tr><td style="padding:26px 0 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tr}</table></td></tr>`;
}

/** Botão de ação; com `mostrarUrl`, imprime a URL para copiar/colar. */
export function botao(rotulo: string, url: string, mostrarUrl = false): string {
  const href = escaparHtml(url);
  const fallback = mostrarUrl
    ? `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:${COR.suave};word-break:break-all;">Se o botão não funcionar, copie e cole: ${href}</p>`
    : '';
  return `<tr><td style="padding:18px 0 30px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${COR.marinho};border-radius:4px;"><a href="${href}" style="display:inline-block;padding:12px 24px;font-family:${FONTE};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;">${escaparHtml(rotulo)}</a></td></tr></table>${fallback}</td></tr>`;
}

/** Documento completo. `titulo`, metadados e `nota` em texto puro (escapados aqui). */
export function documento(d: {
  titulo: string;
  meta: Array<{ rotulo: string; valor: string }>;
  corpo: string;
  nota?: string | null;
}): string {
  const titulo = escaparHtml(d.titulo);
  const metas = d.meta
    .map(
      (m) =>
        `<td class="meta" valign="top" style="padding:0 0 0 28px;white-space:nowrap;"><p style="margin:0 0 4px;font-size:12px;color:${COR.suave};">${escaparHtml(m.rotulo)}</p><p style="margin:0;font-size:14px;font-weight:bold;color:${COR.tinta};">${escaparHtml(m.valor)}</p></td>`,
    )
    .join('');
  const nota = d.nota
    ? `<p style="max-width:600px;margin:16px auto 0;font-size:11px;line-height:1.5;color:#8a929c;text-align:center;">${escaparHtml(d.nota)}</p>`
    : '';
  const e = EMITENTE;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${titulo}</title>
<style>
  @media (max-width:600px){
    .folha{padding:28px 22px !important}
    .empilha{display:block !important;width:100% !important}
    .metas{padding-top:16px !important;text-align:left !important}
    .meta:first-child{padding-left:0 !important}
    .titulo{font-size:24px !important}
    .rodape-d{text-align:left !important;padding-top:10px !important}
  }
</style></head>
<body style="margin:0;padding:0;background:${COR.fundo};font-family:${FONTE};color:${COR.texto};-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COR.fundo};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;">
<tr><td class="folha" style="padding:44px 48px 36px;font-family:${FONTE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:0 0 40px;"><img src="cid:${LOGO_CID}" width="300" alt="Isaque Kanitz Schluter — Consultoria em Tecnologia da Informação" style="display:block;width:300px;max-width:100%;height:auto;border:0;"></td></tr>
    <tr><td style="padding:0 0 22px;border-bottom:2px solid ${COR.marinho};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="empilha" valign="middle"><h1 class="titulo" style="margin:0;font-size:28px;line-height:1.2;font-weight:bold;color:${COR.tinta};">${titulo}</h1></td>
        <td class="empilha metas" valign="middle" align="right"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${metas}</tr></table></td>
      </tr></table>
    </td></tr>
    ${d.corpo}
    <tr><td style="padding:22px 0 0;border-top:1px solid ${COR.linha};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td class="empilha" valign="top" style="font-size:12px;line-height:1.6;"><b style="color:${COR.tinta};">${e.empresa}</b><br><span style="color:${COR.suave};">${e.cnpj}</span></td>
        <td class="empilha rodape-d" valign="top" align="right" style="font-size:12px;line-height:1.6;"><b style="color:${COR.tinta};">${e.pessoa}</b><br><span style="color:${COR.suave};">${e.email} &nbsp;|&nbsp; ${e.telefone}</span></td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>
</table>
${nota}
</td></tr></table>
</body></html>`;
}

/** Rodapé do fallback texto/plain. */
export function rodapeTexto(): string {
  const e = EMITENTE;
  return `--\n${e.empresa} · ${e.cnpj}\n${e.pessoa} · ${e.email} · ${e.telefone}`;
}
