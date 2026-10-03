import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  montarComando,
  type ComandoClaude,
  type EntradaPerfil,
  type Esforco,
  type NomePerfil,
} from '../../claude/perfis';
import {
  gerarAgentesT1,
  gerarAgentesT2,
  gerarSettings,
  gravarArquivosEtapa,
  type ArquivoAgentes,
  type ArquivosGravados,
} from '../../claude/settings-gerados';
import { MODELO_MECANICA, MODELO_MECANICA_ID } from './apoio';

/**
 * Monta um spawn de spike com os MÓDULOS DE PRODUÇÃO (`gerarSettings`,
 * `gerarAgentesT1/T2`, `gravarArquivosEtapa`, `montarComando`): o spike prova a
 * CLI e, de quebra, o que a R2 gera. Só o modelo e o orçamento mudam (haiku
 * para a mecânica, 08 §2), e o env é a mesma allowlist do runner.
 */

export interface AmbienteEtapa {
  /** `<tmp>/dados` (fora do clone): settings/agentes/sistema da etapa ficam aqui. */
  dirDados: string;
  execucaoId: string;
  /** Worktree desta execução (o clone descartável). */
  worktree: string;
  /** "Checkout do usuário" fictício: o T1 nega `Edit` nele, então NÃO pode ser o clone. */
  repoUsuario: string;
}

export interface OpcoesEtapaSpike {
  perfil: NomePerfil;
  n: number;
  sessao: EntradaPerfil['sessao'];
  jsonSchema: Record<string, unknown> | null;
  modelo?: string;
  esforco?: Esforco;
  /** Modelo do `CLAUDE_CODE_SUBAGENT_MODEL` (+ FORCE). */
  modeloSubagentes?: string;
  /** Modelo gravado no `agentes.json` (o FORCE deve sobrepor). */
  modeloAgentes?: string;
  orcamentoUsd?: number;
  maxTurns?: number | null;
  agentesNegados?: readonly string[];
  conversar?: boolean;
  retomarTurnoInterrompido?: boolean;
  /** Bloco do `--append-system-prompt-file`. */
  sistema?: string;
  /**
   * Mantém `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` da base da R2. Padrão `false`:
   * o S2 provou que ele força `permissionMode: default` (anula bypass e
   * `dontAsk`); sem tirá-lo, nenhum outro critério do perfil é observável.
   */
  manterScrub?: boolean;
}

export interface EtapaSpike {
  comando: ComandoClaude;
  arquivos: ArquivosGravados;
}

export async function prepararEtapa(amb: AmbienteEtapa, o: OpcoesEtapaSpike): Promise<EtapaSpike> {
  const dirExec = join(amb.dirDados, 'execucoes', amb.execucaoId);
  await mkdir(dirExec, { recursive: true });
  const modeloAgentes = o.modeloAgentes ?? MODELO_MECANICA_ID;
  const esforco = o.esforco ?? 'low';
  let agentes: ArquivoAgentes | null = null;
  if (o.perfil === 'condutor_t1') {
    agentes = gerarAgentesT1({
      modelo: modeloAgentes,
      esforco,
      promptImplementador:
        'Você é o implementador de um teste automatizado. Faça exatamente o que o pedido diz, com o mínimo de passos, e responda em uma frase.',
    });
  } else if (o.perfil === 'condutor_t2') {
    agentes = gerarAgentesT2({
      modelo: modeloAgentes,
      esforco,
      promptRevisorCorrecao:
        'Você é o revisor de correção de um teste automatizado. Faça exatamente os comandos pedidos, um por vez, e responda em uma frase.',
      promptRevisorSeguranca:
        'Você é o revisor de segurança de um teste automatizado. Faça exatamente os comandos pedidos, um por vez, e responda em uma frase.',
    });
  }
  const settings = gerarSettings({
    perfil: o.perfil,
    dirDados: amb.dirDados,
    execucaoId: amb.execucaoId,
    worktreePropria: amb.worktree,
    worktreesExistentes: [amb.worktree],
    repoDirUsuario: amb.repoUsuario,
    reposOutrosProjetos: [],
    branchDestino: 'main',
  });
  const arquivos = await gravarArquivosEtapa(dirExec, o.n, {
    settings,
    agentes,
    sistema: o.sistema ?? 'Teste automatizado da Forja (spike). Siga o pedido do usuário à risca.',
  });
  const comando = montarComando({
    perfil: o.perfil,
    sessao: o.sessao,
    conversar: o.conversar,
    retomarTurnoInterrompido: o.retomarTurnoInterrompido,
    modelo: o.modelo ?? MODELO_MECANICA,
    esforco,
    modeloSubagentes: o.modeloSubagentes ?? MODELO_MECANICA,
    numeroChamado: 1,
    orcamentoUsd: o.orcamentoUsd ?? 0.5,
    maxTurns: o.maxTurns ?? null,
    arquivos: { settings: arquivos.settings, sistema: arquivos.sistema, agentes: arquivos.agentes },
    jsonSchema: o.jsonSchema,
    dirEntrada: o.perfil === 'planejador' ? join(dirExec, 'entrada') : null,
    agentesNegados: o.agentesNegados,
    cwd: amb.worktree,
    env: { envOrigem: process.env },
  });
  // A allowlist da Forja já é o env do comando; conferimos que nada herdado escapou.
  const herdadas = Object.keys(comando.env).filter(
    (k) =>
      k === 'CLAUDECODE' || k === 'CLAUDE_CODE_CHILD_SESSION' || k === 'CLAUDE_CODE_SESSION_ID',
  );
  if (herdadas.length) throw new Error(`env herdado no spawn: ${herdadas.join(', ')}`);
  if (!o.manterScrub) delete comando.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
  return { comando, arquivos };
}

/** Schema mínimo `{ok: boolean, ...extras}` para os turnos dos spikes. */
export function schemaObjeto(
  propriedades: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: propriedades,
    required: Object.keys(propriedades),
    additionalProperties: false,
  };
}
