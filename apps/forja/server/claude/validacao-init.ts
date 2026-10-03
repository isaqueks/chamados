import { SERVIDOR_MCP_CHAMADOS, type ExpectativaInit } from './perfis';
import type { InitCli } from './stream';

/**
 * Validação de todo `system/init` contra o perfil do spawn (specs/forja/01
 * §6.4; 05 §4.10).
 *
 * POR QUE conferir a cada turno: o `init` é a única prova, vinda da própria
 * CLI, de que as flags surtiram efeito — modo de permissão, ferramentas, só o
 * MCP do Chamados quando pedido (FJ-030 §4), credencial e modelo. Uma versão nova da CLI que ignore `--tools`, um
 * `.mcp.json` que escape do `--strict-mcp-config` ou um agente plantado no repo
 * aparecem aqui ANTES da primeira ferramenta, e o runner aborta (SIGTERM no
 * grupo, `perfil_divergente`).
 *
 * Detalhes da CLI 2.1.288 (fixtures): `Agent` aparece em `init.tools` como
 * `Task`; com `--json-schema` a CLI acrescenta `StructuredOutput`; plugins
 * embutidos vêm com `path: "builtin"` e não contam como plugin carregado.
 */

export interface RecorteInit {
  model: string | null;
  tools: string[];
  permissionMode: string | null;
  apiKeySource: string | null;
  mcp_servers: string[];
  agents: string[];
  claude_code_version: string | null;
}

export interface ResultadoValidacaoInit {
  ok: boolean;
  /** Motivos de aborto (`perfil_divergente`). */
  divergencias: string[];
  /** Versão da CLI ≠ fixada: além de abortar, bloqueia o pipeline (Diagnóstico). */
  versaoDivergente: boolean;
  /** T1: agentes listados fora do papel e não negados — mata, atualiza a lista e reinicia 1× (01 §6.2). */
  agentesForaDoPapel: string[];
  /** Não abortam (plano B de S2): plugins carregados apesar de `--setting-sources ""`. */
  alertas: string[];
  capabilities: string[];
  /** Gravado em `etapa.init` (02 §4.7). */
  recorte: RecorteInit;
}

function normalizarFerramenta(nome: string): string {
  return nome === 'Task' ? 'Agent' : nome;
}

function mesmoModelo(recebido: string | undefined, esperado: string): boolean {
  if (!recebido) return false;
  return (
    recebido === esperado ||
    recebido.startsWith(`${esperado}-`) ||
    recebido.startsWith(`${esperado}[`)
  );
}

export function validarInit(
  init: InitCli,
  esperado: ExpectativaInit,
  versaoFixada: string,
): ResultadoValidacaoInit {
  const divergencias: string[] = [];
  const alertas: string[] = [];

  const versao = init.claude_code_version ?? null;
  const versaoDivergente = versao !== versaoFixada;
  if (versaoDivergente)
    divergencias.push(`versão da CLI ${versao ?? '?'} ≠ fixada ${versaoFixada}`);

  if (init.permissionMode !== esperado.permissionMode) {
    divergencias.push(`permissionMode ${init.permissionMode ?? '?'} ≠ ${esperado.permissionMode}`);
  }

  // As ferramentas do MCP do Chamados aparecem em `init.tools` como
  // `mcp__chamados__*`: esperadas quando o spawn levou `--mcp-config`.
  const prefixoMcp = `mcp__${SERVIDOR_MCP_CHAMADOS}__`;
  const recebidas = new Set(
    (init.tools ?? [])
      .map(normalizarFerramenta)
      .filter((f) => !(esperado.mcpChamados && f.startsWith(prefixoMcp))),
  );
  const esperadas = new Set(esperado.ferramentas);
  if (esperado.comSchema) esperadas.add('StructuredOutput');
  const faltando = [...esperadas].filter((f) => !recebidas.has(f));
  const sobrando = [...recebidas].filter((f) => !esperadas.has(f));
  if (faltando.length || sobrando.length) {
    divergencias.push(
      `ferramentas diferentes do perfil (faltando: ${faltando.join(',') || '—'}; sobrando: ${sobrando.join(',') || '—'})`,
    );
  }

  const mcp = (init.mcp_servers ?? []).map((m) => m.name);
  const estranhos = (init.mcp_servers ?? []).filter(
    (m) => !(esperado.mcpChamados && m.name === SERVIDOR_MCP_CHAMADOS),
  );
  if (estranhos.length) {
    divergencias.push(`servidores MCP carregados: ${estranhos.map((m) => m.name).join(', ')}`);
  }
  if (esperado.mcpChamados) {
    // MCP fora do ar não aborta (o app ainda grava `entrada/`): só avisa (FJ-030 §4).
    const chamados = (init.mcp_servers ?? []).find((m) => m.name === SERVIDOR_MCP_CHAMADOS);
    if (!chamados) {
      alertas.push('MCP do Chamados ausente no init (os agentes seguem sem ele)');
    } else if (chamados.status && chamados.status !== 'connected') {
      alertas.push(`MCP do Chamados ${chamados.status} (os agentes seguem sem ele)`);
    }
  }

  const fonte = init.apiKeySource ?? null;
  if (esperado.apiKeySource === 'none' ? fonte !== 'none' : fonte === 'none' || fonte === null) {
    divergencias.push(`credencial inesperada (apiKeySource ${fonte ?? '?'})`);
  }

  if (!mesmoModelo(init.model, esperado.modelo)) {
    divergencias.push(`modelo ${init.model ?? '?'} ≠ ${esperado.modelo}`);
  }

  let agentesForaDoPapel: string[] = [];
  if (esperado.agentesAceitos) {
    const aceitos = new Set(esperado.agentesAceitos);
    agentesForaDoPapel = (init.agents ?? []).filter((a) => !aceitos.has(a));
  }

  const usaSettingSourcesVazio =
    esperado.perfil === 'condutor_t1' || esperado.perfil === 'condutor_t2';
  const plugins = (init.plugins ?? []).filter((p) => p.path !== 'builtin');
  if (usaSettingSourcesVazio && plugins.length) {
    alertas.push(
      `plugins carregados apesar de --setting-sources "": ${plugins.map((p) => p.name).join(', ')}`,
    );
  }

  return {
    ok: divergencias.length === 0 && agentesForaDoPapel.length === 0,
    divergencias,
    versaoDivergente,
    agentesForaDoPapel,
    alertas,
    capabilities: init.capabilities ?? [],
    recorte: {
      model: init.model ?? null,
      tools: init.tools ?? [],
      permissionMode: init.permissionMode ?? null,
      apiKeySource: fonte,
      mcp_servers: mcp,
      agents: init.agents ?? [],
      claude_code_version: versao,
    },
  };
}
