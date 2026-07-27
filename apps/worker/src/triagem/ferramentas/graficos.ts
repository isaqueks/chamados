import type PDFDocument from 'pdfkit';

/**
 * Gráficos VETORIAIS nativos dos PDFs de artefato (D-027): a IA descreve o
 * gráfico num bloco de código ```grafico com JSON e o worker o DESENHA com as
 * primitivas do pdfkit (retângulos/linhas/arcos) — nenhum chromium, canvas ou
 * binário externo. Erros de spec lançam `grafico_invalido:<motivo>` — que volta
 * ao MODELO como erro de tool corrigível (mesmo contrato do resto do pdf.ts).
 */

export interface PontoGrafico {
  rotulo: string;
  valor: number;
}

export type TipoGrafico = 'barras' | 'linhas' | 'pizza';

export interface GraficoSpec {
  tipo: TipoGrafico;
  titulo: string | null;
  dados: PontoGrafico[];
}

/** Cores usadas no desenho — derivadas da marca do tenant (ver pdf.ts/cores.ts). */
export interface TemaGrafico {
  /** Cor primária (barras, linha, primeira fatia). */
  cor: string;
  /** Paleta multi-cor (fatias da pizza). */
  paleta: string[];
}

const TIPOS: readonly TipoGrafico[] = ['barras', 'linhas', 'pizza'];
/** Máximo de pontos em barras/linhas (mais que isso vira ruído em A4). */
export const MAX_PONTOS = 24;
/** Máximo de fatias na pizza (legibilidade; o modelo agrega o resto em "Outros"). */
export const MAX_FATIAS = 8;

const FORMA_ESPERADA =
  '{"tipo":"barras"|"linhas"|"pizza","titulo":"...","dados":[{"rotulo":"Jan","valor":12}]}';

function falha(motivo: string): never {
  throw new Error(`grafico_invalido: ${motivo} — forma esperada: ${FORMA_ESPERADA}`);
}

/** Valida o JSON de um bloco ```grafico e devolve a spec normalizada. */
export function validarGrafico(json: string): GraficoSpec {
  let cru: unknown;
  try {
    cru = JSON.parse(json);
  } catch {
    falha('JSON malformado');
  }
  if (typeof cru !== 'object' || cru === null || Array.isArray(cru)) falha('esperado um objeto');
  const o = cru as Record<string, unknown>;

  const tipo = o.tipo;
  if (typeof tipo !== 'string' || !TIPOS.includes(tipo as TipoGrafico)) {
    falha(`tipo deve ser um de ${TIPOS.join('|')}`);
  }
  const titulo = typeof o.titulo === 'string' && o.titulo.trim() !== '' ? o.titulo.trim() : null;

  if (!Array.isArray(o.dados) || o.dados.length === 0) falha('dados deve ser uma lista não vazia');
  const max = tipo === 'pizza' ? MAX_FATIAS : MAX_PONTOS;
  if (o.dados.length > max) {
    falha(`no máximo ${max} itens para "${tipo}" (agregue o restante em uma categoria "Outros")`);
  }
  const dados: PontoGrafico[] = o.dados.map((p, i) => {
    if (typeof p !== 'object' || p === null) falha(`dados[${i}] deve ser um objeto`);
    const { rotulo, valor } = p as Record<string, unknown>;
    if (typeof rotulo !== 'string' || rotulo.trim() === '') {
      falha(`dados[${i}].rotulo deve ser um texto`);
    }
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      falha(`dados[${i}].valor deve ser um número`);
    }
    if (valor < 0) falha(`dados[${i}].valor negativo não é suportado`);
    return { rotulo: rotulo.trim().slice(0, 40), valor };
  });
  if (tipo === 'pizza' && dados.every((d) => d.valor === 0)) {
    falha('pizza precisa de ao menos um valor > 0');
  }
  return { tipo: tipo as TipoGrafico, titulo, dados };
}

type Doc = InstanceType<typeof PDFDocument>;

const H_PLOT = 150;
const H_ROTULOS = 30;
const PAD_ESQ = 46;
const H_TITULO = 20;
const RAIO_PIZZA = 72;

/** Altura total que o gráfico ocupa (para `garantirEspaco` antes de desenhar). */
export function alturaGrafico(spec: GraficoSpec): number {
  const titulo = spec.titulo ? H_TITULO : 0;
  if (spec.tipo === 'pizza') {
    const legenda = spec.dados.length * 16;
    return titulo + Math.max(RAIO_PIZZA * 2 + 16, legenda) + 16;
  }
  return titulo + H_PLOT + H_ROTULOS + 16;
}

const fmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** Teto "bonito" do eixo: menor 1|2|5|10 × 10^k que cobre o máximo. */
function escalaBonita(max: number): number {
  if (max <= 0) return 1;
  const expo = Math.floor(Math.log10(max));
  const base = Math.pow(10, expo);
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= max - 1e-9) return m * base;
  }
  return 10 * base;
}

interface AreaGrafico {
  x: number;
  largura: number;
}

/** Eixos + grade horizontais compartilhados por barras/linhas. Devolve a geometria. */
function desenharEixos(
  doc: Doc,
  area: AreaGrafico,
  teto: number,
): { x0: number; y0: number; plotW: number } {
  const x0 = area.x + PAD_ESQ;
  const y0 = doc.y;
  const plotW = area.largura - PAD_ESQ - 4;
  for (let i = 0; i <= 4; i++) {
    const y = y0 + H_PLOT - (i / 4) * H_PLOT;
    doc
      .lineWidth(0.5)
      .strokeColor(i === 0 ? '#c8c8c8' : '#e8e8e8')
      .moveTo(x0, y)
      .lineTo(x0 + plotW, y)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor('#666666')
      .text(fmt.format((teto * i) / 4), area.x, y - 3, {
        width: PAD_ESQ - 8,
        align: 'right',
        lineBreak: false,
      });
  }
  return { x0, y0, plotW };
}

function rotulosEixoX(doc: Doc, dados: PontoGrafico[], x0: number, y0: number, slot: number): void {
  doc.font('Helvetica').fontSize(7.5).fillColor('#555555');
  dados.forEach((p, i) => {
    doc.text(p.rotulo, x0 + i * slot + 1, y0 + H_PLOT + 5, {
      width: slot - 2,
      align: 'center',
      height: H_ROTULOS - 8,
      ellipsis: true,
    });
  });
}

function desenharTitulo(doc: Doc, area: AreaGrafico, titulo: string | null): void {
  if (!titulo) return;
  doc
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .fillColor('#27272a')
    .text(titulo, area.x, doc.y, { width: area.largura, lineBreak: false });
  doc.y += H_TITULO - 8;
}

function desenharBarras(doc: Doc, spec: GraficoSpec, tema: TemaGrafico, area: AreaGrafico): void {
  const teto = escalaBonita(Math.max(...spec.dados.map((d) => d.valor)));
  const { x0, y0, plotW } = desenharEixos(doc, area, teto);
  const n = spec.dados.length;
  const slot = plotW / n;
  const larguraBarra = Math.min(slot * 0.62, 42);
  spec.dados.forEach((p, i) => {
    const h = (p.valor / teto) * H_PLOT;
    const x = x0 + i * slot + (slot - larguraBarra) / 2;
    if (h > 0) doc.rect(x, y0 + H_PLOT - h, larguraBarra, h).fill(tema.cor);
    if (n <= 16) {
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#444444')
        .text(fmt.format(p.valor), x0 + i * slot, y0 + H_PLOT - h - 10, {
          width: slot,
          align: 'center',
          lineBreak: false,
        });
    }
  });
  rotulosEixoX(doc, spec.dados, x0, y0, slot);
  doc.x = area.x;
  doc.y = y0 + H_PLOT + H_ROTULOS;
}

function desenharLinhas(doc: Doc, spec: GraficoSpec, tema: TemaGrafico, area: AreaGrafico): void {
  const teto = escalaBonita(Math.max(...spec.dados.map((d) => d.valor)));
  const { x0, y0, plotW } = desenharEixos(doc, area, teto);
  const n = spec.dados.length;
  const slot = plotW / n;
  const pontos = spec.dados.map((p, i) => ({
    x: x0 + i * slot + slot / 2,
    y: y0 + H_PLOT - (p.valor / teto) * H_PLOT,
  }));

  if (pontos.length > 1) {
    // Preenchimento suave sob a linha (área), depois a linha por cima.
    const primeiro = pontos[0]!;
    const ultimo = pontos[pontos.length - 1]!;
    doc.moveTo(primeiro.x, y0 + H_PLOT);
    for (const p of pontos) doc.lineTo(p.x, p.y);
    doc.lineTo(ultimo.x, y0 + H_PLOT).closePath();
    doc.fillOpacity(0.08).fill(tema.cor).fillOpacity(1);

    doc.moveTo(primeiro.x, primeiro.y);
    for (const p of pontos.slice(1)) doc.lineTo(p.x, p.y);
    doc.lineWidth(1.8).strokeColor(tema.cor).lineJoin('round').stroke();
  }
  for (const p of pontos) doc.circle(p.x, p.y, 2.2).fill(tema.cor);
  if (n <= 12) {
    spec.dados.forEach((p, i) => {
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#444444')
        .text(fmt.format(p.valor), x0 + i * slot, pontos[i]!.y - 11, {
          width: slot,
          align: 'center',
          lineBreak: false,
        });
    });
  }
  rotulosEixoX(doc, spec.dados, x0, y0, slot);
  doc.x = area.x;
  doc.y = y0 + H_PLOT + H_ROTULOS;
}

/** Ponto na circunferência (ângulo em graus, 0° = topo, sentido horário). */
function noCirculo(
  cx: number,
  cy: number,
  r: number,
  anguloGraus: number,
): { x: number; y: number } {
  const rad = ((anguloGraus - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function desenharPizza(doc: Doc, spec: GraficoSpec, tema: TemaGrafico, area: AreaGrafico): void {
  const total = spec.dados.reduce((s, d) => s + d.valor, 0);
  const r = RAIO_PIZZA;
  const cx = area.x + r + 8;
  const topo = doc.y + 8;
  const cy = topo + r;

  let angulo = 0;
  spec.dados.forEach((p, i) => {
    const cor = tema.paleta[i % tema.paleta.length]!;
    const varre = (p.valor / total) * 360;
    if (varre <= 0) return;
    if (varre >= 360) {
      doc.circle(cx, cy, r).fill(cor);
    } else {
      const a = noCirculo(cx, cy, r, angulo);
      const b = noCirculo(cx, cy, r, angulo + varre);
      const arcoGrande = varre > 180 ? 1 : 0;
      doc
        .path(`M ${cx} ${cy} L ${a.x} ${a.y} A ${r} ${r} 0 ${arcoGrande} 1 ${b.x} ${b.y} Z`)
        .fill(cor);
    }
    angulo += varre;
  });
  // Contorno sutil para fatias adjacentes de tons próximos.
  doc.circle(cx, cy, r).lineWidth(0.5).strokeColor('#ffffff').stroke();

  const lx = cx + r + 26;
  const larguraLegenda = area.x + area.largura - lx;
  let ly = cy - (spec.dados.length * 16) / 2 + 2;
  spec.dados.forEach((p, i) => {
    const cor = tema.paleta[i % tema.paleta.length]!;
    doc.rect(lx, ly + 1, 8, 8).fill(cor);
    const pct = total > 0 ? Math.round((p.valor / total) * 1000) / 10 : 0;
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#333333')
      .text(`${p.rotulo} — ${fmt.format(p.valor)} (${fmt.format(pct)}%)`, lx + 14, ly, {
        width: larguraLegenda,
        height: 12,
        ellipsis: true,
      });
    ly += 16;
  });

  doc.x = area.x;
  doc.y = Math.max(cy + r, ly) + 8;
}

/**
 * Desenha o gráfico na posição vertical atual do documento. O chamador garante o
 * espaço na página (`alturaGrafico`) ANTES — aqui não há quebra de página.
 */
export function renderizarGrafico(
  doc: Doc,
  spec: GraficoSpec,
  tema: TemaGrafico,
  area: AreaGrafico,
): void {
  desenharTitulo(doc, area, spec.titulo);
  if (spec.tipo === 'barras') desenharBarras(doc, spec, tema, area);
  else if (spec.tipo === 'linhas') desenharLinhas(doc, spec, tema, area);
  else desenharPizza(doc, spec, tema, area);
  doc.fillColor('#111111');
}
