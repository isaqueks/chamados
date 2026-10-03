import type { AprovacaoDto, AvisoAprovacaoDto, DiffArquivoDto, SeloArquivo } from '@comum/dto';

/**
 * Regras do botão "Aprovar e mergear" (specs/forja/06 §4.3; FJ-034, 2026-10-03
 * — "dois cliques"). O botão fica SEMPRE habilitado em `aguardando_aprovacao`
 * (a ação vem de `ExecucaoDto.acoes`): não há mais itens a cumprir (abrir
 * Diff/Interdiff/Evidências, marcar vistos, "li a mensagem nova", "aprovar sem
 * prints", confirmar achados, diálogo com o patch-id). O que era exigência
 * chega do servidor como `AprovacaoDto.avisos` e é mostrado empilhado acima do
 * botão; a única linha local é a resposta ao cliente editada com violação sem
 * "publicar mesmo assim" (o servidor recusa — F-16 — e a tela avisa antes).
 *
 * O servidor confere dado velho (relatório, `patch_id`, `sha`, mensagem nova
 * chegada depois de abrir): recusa com 409 e a tela recarrega. Pura — testada.
 */

export interface LinhaAviso {
  tipo: AvisoAprovacaoDto['tipo'] | 'resposta_violada';
  mensagem: string;
  /** Só informativo (o patch curto): tom neutro. */
  informativo: boolean;
}

/** Avisos empilhados acima do botão: os do servidor + a resposta violada local. */
export function avisosDoBotao(
  a: Pick<AprovacaoDto, 'avisos'>,
  resposta: { violada: boolean; publicarMesmoAssim: boolean },
): LinhaAviso[] {
  const linhas: LinhaAviso[] = a.avisos.map((x) => ({
    tipo: x.tipo,
    mensagem: x.mensagem,
    informativo: x.tipo === 'patch',
  }));
  if (resposta.violada && !resposta.publicarMesmoAssim) {
    linhas.unshift({
      tipo: 'resposta_violada',
      mensagem:
        'A resposta editada tem violações: corrija ou marque "publicar mesmo assim" na aba Resposta.',
      informativo: false,
    });
  }
  return linhas;
}

export function arquivosSeloNaoVistos(
  arquivosSelo: readonly string[],
  vistos: ReadonlySet<string>,
): string[] {
  return arquivosSelo.filter((c) => !vistos.has(c));
}

/** `patch-id` curto, informativo (05 §7.1): 6 caracteres. */
export function patchCurto(patchId: string | null | undefined): string {
  return (patchId ?? '').slice(0, 6) || '—';
}

export function shaCurto(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 7) || '—';
}

const PRIORIDADE_SELO: Record<SeloArquivo, number> = {
  sensivel: 0,
  banco: 1,
  regra_negocio: 2,
  frontend: 3,
};

/**
 * Arquivos com selo primeiro (06 §4.3), na ordem sensível → banco → regra →
 * interface; depois o resto pelo caminho. O servidor já ordena; a UI reordena
 * por segurança (ordem estável).
 */
export function ordenarArquivosDiff(arquivos: readonly DiffArquivoDto[]): DiffArquivoDto[] {
  const peso = (a: DiffArquivoDto) =>
    a.selos.length === 0 ? 99 : Math.min(...a.selos.map((s) => PRIORIDADE_SELO[s]));
  return [...arquivos].sort((a, b) => peso(a) - peso(b) || a.caminho.localeCompare(b.caminho));
}

/** Índice do próximo/anterior arquivo (atalhos `n`/`p`), sem dar a volta. */
export function proximoIndice(atual: number, total: number, direcao: 1 | -1): number {
  if (total === 0) return 0;
  return Math.min(total - 1, Math.max(0, atual + direcao));
}
