import type { ComandoClaude } from './perfis';
import { montarB4, montarPromptRetomada, type SecaoInsumo } from './prompts';
import type { EntradaProcesso, ExecucaoProcesso, ResultadoProcesso, Runner } from './runner';

/**
 * Retomada de uma etapa de agente (specs/forja/01 §6.7; 03 §3.3).
 *
 * Ordem (para `interrompido`, `cota` após `resetsAt`, `pausado` e reboot):
 * 1. worktree suja → commit de checkpoint do app (`forja: estado ao interromper`);
 * 2. `--resume <session_id>` com o MESMO perfil e schema +
 *    `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` + prompt curto "retome; estado atual:";
 * 3. se o resume falhar (sessão não encontrada, erro antes do `init`, ou
 *    `erro_execucao` em menos de 60 s) → SESSÃO NOVA (`--session-id` novo) com o
 *    prompt "estado atual" montado só do SQLite, dos commits e dos artefatos;
 * 4. dois resumes seguidos falhando na mesma etapa → falha (03).
 *
 * POR QUE o disco é o ponto de partida e não a memória da sessão: o app commita
 * a cada implementador que retorna (F-08), então uma etapa perdida custa no
 * máximo um passo; a sessão nova não depende de transcript nenhum.
 *
 * O git (checkpoint), o SQLite (resumo do estado) e a montagem do comando do
 * perfil chegam por injeção (`DepsRetomada`): a ligação é da integração.
 */

/** `erro_execucao` mais rápido que isto conta como resume que falhou (01 §6.7 passo 3). */
export const LIMITE_ERRO_RAPIDO_MS = 60_000;
/** Passo 4: segunda falha seguida de retomada na mesma etapa leva à falha (03 §3.3). */
export const MAX_RETOMADAS_FALHAS_SEGUIDAS = 2;

const SESSAO_NAO_ENCONTRADA = /no conversation found|session .* not found|could not find session/i;

/** O resume não pegou e a etapa precisa de sessão nova? */
export function resumeFalhou(r: ResultadoProcesso): boolean {
  // Sem login ou sem cota, uma sessão nova falharia igual e ainda trocaria a
  // `session_id` do condutor (perdendo a memória do T1): não é resume falho.
  if (r.classificacao === 'autenticacao' || r.classificacao === 'cota') return false;
  if (SESSAO_NAO_ENCONTRADA.test(r.stderrFinal)) return true;
  const paradaPedida = r.classificacao === 'pausado' || r.classificacao === 'cancelado';
  if (!r.init && !paradaPedida && r.classificacao !== 'timeout') return true;
  return r.classificacao === 'erro_execucao' && r.duracaoMs < LIMITE_ERRO_RAPIDO_MS;
}

export function deveFalharAposRetomadas(falhasSeguidas: number): boolean {
  return falhasSeguidas >= MAX_RETOMADAS_FALHAS_SEGUIDAS;
}

/** Fatos para a sessão nova, só do SQLite, dos commits e dos artefatos (01 §6.7 passo 3). */
export interface EstadoAtualSessao {
  /** `git log` dos checkpoints do app desde o commit base. */
  passosConcluidos: string;
  /** `git diff --stat` atual contra o commit base. */
  diffAtual: string;
  vereditosAnteriores: string | null;
  comentariosAnteriores: readonly string[];
}

/**
 * stdin da sessão nova: os insumos do turno (com o plano aprovado) precedidos
 * do estado atual. A sessão não tem memória: tudo o que importa vai aqui.
 */
export function montarPromptSessaoNova(
  insumosTurno: readonly SecaoInsumo[],
  estado: EstadoAtualSessao,
): string {
  const secaoEstado: SecaoInsumo = {
    titulo: 'Estado atual (sessão nova continuando um trabalho interrompido)',
    origem: 'app',
    conteudo: [
      'Esta sessão substitui uma que não pôde ser retomada. O que já foi feito está no disco:',
      '',
      'Passos concluídos (commits do app):',
      '```',
      estado.passosConcluidos.trim() || '(nenhum)',
      '```',
      '',
      'Diff atual:',
      '```',
      estado.diffAtual.trim() || '(vazio)',
      '```',
      '',
      'Vereditos anteriores:',
      estado.vereditosAnteriores?.trim() || '(nenhum)',
      '',
      'Comentários anteriores:',
      estado.comentariosAnteriores.length
        ? estado.comentariosAnteriores.map((c) => `- ${c}`).join('\n')
        : '(nenhum)',
    ].join('\n'),
  };
  return montarB4([secaoEstado, ...insumosTurno]);
}

export interface DepsRetomada {
  runner: Runner;
  /** Passo 1: commit de checkpoint se a worktree estiver suja; devolve o sha ou null. */
  checkpointSeSujo(): Promise<string | null>;
  /** Comando do MESMO perfil e schema da etapa, para a sessão indicada. */
  montarComando(
    sessao: { modo: 'novo' | 'resume'; sessionId: string },
    retomarTurnoInterrompido: boolean,
  ): ComandoClaude;
  /** Passo 2: resumo curto do estado para "retome; estado atual:". */
  resumoEstado(): Promise<string>;
  /** Passo 3: stdin completo da sessão nova (`montarPromptSessaoNova`). */
  promptSessaoNova(): Promise<string>;
  novoSessionId(): string;
  entrada: Omit<EntradaProcesso, 'prompt'>;
  /** Para a integração gravar pid/pgid, assinar `eventos` e apontar a etapa para a sessão nova. */
  aoIniciar?(processo: ExecucaoProcesso, info: { sessaoNova: boolean; sessionId: string }): void;
}

export interface ResultadoRetomada {
  resultado: ResultadoProcesso;
  sessionId: string;
  sessaoNova: boolean;
  shaCheckpoint: string | null;
  /** O resume original (se a sessão nova foi aberta depois dele). */
  resumeFalho: ResultadoProcesso | null;
}

export async function retomarEtapa(
  sessionId: string,
  deps: DepsRetomada,
): Promise<ResultadoRetomada> {
  const shaCheckpoint = await deps.checkpointSeSujo();
  const comandoResume = deps.montarComando({ modo: 'resume', sessionId }, true);
  const processo = deps.runner.iniciar(comandoResume, {
    ...deps.entrada,
    prompt: montarPromptRetomada(await deps.resumoEstado()),
  });
  deps.aoIniciar?.(processo, { sessaoNova: false, sessionId });
  const resultado = await processo.resultado;
  if (!resumeFalhou(resultado)) {
    return { resultado, sessionId, sessaoNova: false, shaCheckpoint, resumeFalho: null };
  }
  const novo = deps.novoSessionId();
  const comandoNovo = deps.montarComando({ modo: 'novo', sessionId: novo }, false);
  const processoNovo = deps.runner.iniciar(comandoNovo, {
    ...deps.entrada,
    prompt: await deps.promptSessaoNova(),
  });
  deps.aoIniciar?.(processoNovo, { sessaoNova: true, sessionId: novo });
  return {
    resultado: await processoNovo.resultado,
    sessionId: novo,
    sessaoNova: true,
    shaCheckpoint,
    resumeFalho: resultado,
  };
}
