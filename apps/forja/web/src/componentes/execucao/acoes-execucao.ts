import type { AcaoExecucao, ExecucaoDto } from '@comum/dto';
import { CLASSE_ESTADO_EXECUCAO, type EstadoExecucao } from '@comum/estados';

/**
 * Mapeamento `ExecucaoDto.acoes` → botões (specs/forja/06 §4.2, §4.3, §5.3;
 * 03 §2.4). A REGRA de quando cada ação cabe é do servidor
 * (`acoesDisponiveis`); a UI só decide ONDE cada ação aparece e nunca mostra
 * um botão que não veio em `acoes`. Puro — testado em `acoes-execucao.test.ts`.
 */

type ComAcoes = Pick<ExecucaoDto, 'acoes'>;

export function temAcao(ex: ComAcoes | null | undefined, acao: AcaoExecucao): boolean {
  return !!ex && ex.acoes.includes(acao);
}

/** Execução encerrada (concluída, descartada, cancelada): a tela fica em modo leitura (06 §4.11). */
export function execucaoEncerrada(estado: EstadoExecucao): boolean {
  return CLASSE_ESTADO_EXECUCAO[estado] === 'terminal';
}

/**
 * O cartão "Decisão necessária" fica na coluna do plano em Gdec E enquanto a
 * pergunta aguarda o cliente — é ali que aparece [Replanejar] quando a resposta
 * chega (06 §5.3 passo 4).
 */
export function mostraCartaoDecisao(ex: Pick<ExecucaoDto, 'estado' | 'decisao'>): boolean {
  return (
    !!ex.decisao &&
    (ex.estado === 'aguardando_decisao' || ex.estado === 'aguardando_cliente_resposta')
  );
}

export interface BotoesDecisao {
  perguntar: boolean;
  decidir: boolean;
  replanejar: boolean;
  descartar: boolean;
}

export function botoesDecisao(ex: Pick<ExecucaoDto, 'acoes' | 'decisao'>): BotoesDecisao {
  const decidir = temAcao(ex, 'decidir');
  return {
    perguntar: decidir && (ex.decisao?.perguntas.length ?? 0) > 0,
    decidir,
    replanejar: temAcao(ex, 'replanejar'),
    descartar: temAcao(ex, 'descartar'),
  };
}

export interface AcoesAprovacao {
  /** A execução está em `aguardando_aprovacao` (ou ainda carregando: assume que sim). */
  aguardando: boolean;
  aprovar: boolean;
  pedirAjustes: boolean;
  assumir: boolean;
  descartar: boolean;
  recapturar: boolean;
}

/**
 * Ações da Aprovação (06 §4.3). `abrir_aprovacao` só vem em
 * `aguardando_aprovacao` — Aprovar e Pedir ajustes valem só nele; fora dele a
 * tela abre em modo leitura (o relatório e o diff continuam visíveis). Sem a
 * execução carregada, nada fica acionável.
 */
export function acoesAprovacao(
  ex: Pick<ExecucaoDto, 'estado' | 'acoes'> | null | undefined,
): AcoesAprovacao {
  if (!ex) {
    return {
      aguardando: true,
      aprovar: false,
      pedirAjustes: false,
      assumir: false,
      descartar: false,
      recapturar: false,
    };
  }
  const aberta = temAcao(ex, 'abrir_aprovacao');
  return {
    aguardando: ex.estado === 'aguardando_aprovacao',
    aprovar: aberta,
    pedirAjustes: aberta,
    assumir: temAcao(ex, 'assumir'),
    descartar: temAcao(ex, 'descartar'),
    recapturar: temAcao(ex, 'recapturar_prints'),
  };
}

/**
 * "Pausar e enviar" da Conversa (06 §4.2): com a etapa rodando e `pausar`
 * oferecido, o campo fica liberado — o envio pausa antes. O
 * `conversa_bloqueada` genérico do servidor ("pause para conversar") não vale
 * aqui; o do terminal assumido (lock da sessão) vale sempre.
 */
export type ModoConversa =
  { tipo: 'enviar' } | { tipo: 'pausar_e_enviar' } | { tipo: 'bloqueada'; motivo: string };

export function modoConversa(
  ex: Pick<ExecucaoDto, 'acoes' | 'grupo' | 'conversa_bloqueada' | 'sessao_assumida'>,
): ModoConversa {
  if (ex.sessao_assumida) {
    return {
      tipo: 'bloqueada',
      motivo: ex.conversa_bloqueada ?? 'a sessão está assumida no terminal',
    };
  }
  if (temAcao(ex, 'conversar')) return { tipo: 'enviar' };
  if (ex.grupo === 'trabalhando' && temAcao(ex, 'pausar')) return { tipo: 'pausar_e_enviar' };
  return {
    tipo: 'bloqueada',
    motivo: ex.conversa_bloqueada ?? 'a conversa não está disponível neste estado',
  };
}

/**
 * Orquestra "Pausar e enviar": pausa, espera a execução chegar a
 * `pausado_usuario` (a pausa de verificação/integração vale ao fim do passo) e
 * então envia. `conversar` pode recusar por um instante com "sessão ocupada"
 * enquanto o processo pausado termina: tenta de novo até o prazo.
 */
export async function pausarEEnviar(
  deps: {
    pausar: () => Promise<{ estado?: EstadoExecucao }>;
    estadoAtual: () => Promise<EstadoExecucao>;
    conversar: () => Promise<unknown>;
    esperar?: (ms: number) => Promise<void>;
  },
  opcoes: { intervaloMs?: number; prazoMs?: number } = {},
): Promise<void> {
  const esperar = deps.esperar ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalo = opcoes.intervaloMs ?? 1000;
  const tentativas = Math.max(1, Math.ceil((opcoes.prazoMs ?? 60_000) / intervalo));
  const r = await deps.pausar();
  let estado = r.estado;
  for (let i = 0; estado !== 'pausado_usuario'; i += 1) {
    if (i >= tentativas) {
      throw new Error('A etapa não pausou a tempo; a mensagem não foi enviada. Tente de novo.');
    }
    await esperar(intervalo);
    estado = await deps.estadoAtual();
  }
  for (let i = 0; ; i += 1) {
    try {
      await deps.conversar();
      return;
    } catch (erro) {
      const ocupada = (erro as { status?: number } | null)?.status === 409;
      if (!ocupada || i + 1 >= tentativas) throw erro;
      await esperar(intervalo);
    }
  }
}
