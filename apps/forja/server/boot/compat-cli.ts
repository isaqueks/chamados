import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiagnosticoDto, ItemDiagnosticoDto } from '../../comum/dto';
import {
  avaliarSmoke,
  comandoSmokePerfil,
  itensDiagnosticoCli,
  PROMPT_SMOKE,
  VERSAO_CLI_FIXADA,
  verificarAuthCli,
  verificarGit,
  verificarVersaoCli,
  type AuthVerificada,
  type FuncaoExec,
  type ResultadoSmoke,
  type VersaoVerificada,
} from '../claude/compat';
import { NomePerfil, type ComandoClaude, type Env } from '../claude/perfis';
import {
  gerarAgentesT1,
  gerarAgentesT2,
  gerarSettings,
  gravarArquivosEtapa,
  type ArquivoAgentes,
} from '../claude/settings-gerados';
import { ErroForja } from '../dominio/nucleo';
import type { PortaDiagnostico } from '../dominio/servicos';
import { headlessShellInstalado } from '../verificacao/navegador';

/**
 * Compatibilidade da CLI e Diagnóstico em produção (specs/forja/01 §7; 06 §4.10).
 *
 * - **Boot** (custo zero): `claude --version` × fixada, `claude auth status`,
 *   `git --version`. O pipeline só anda com os três OK — ou com a versão
 *   diferente ACEITA pelo humano e o smoke de perfis dela APROVADO (A9).
 * - **Aceitar versão X** dispara o smoke de perfis: um `claude -p` por perfil
 *   de 01 §6.2 com as MESMAS flags, mas `--model haiku --max-turns 1
 *   --max-budget-usd 0.05` e schema trivial (≈ US$ 0,01 por perfil). O
 *   resultado fica gravado por versão em `<dados>/compat-cli.json`.
 * - **Diagnóstico** = essas checagens + identidade do git, `gh`, ANTHROPIC_API_KEY
 *   no ambiente, conexões com o Chamados, autoteste do servidor local
 *   (Host/Origin forjados), módulos nativos e disco. "Rodar tudo" refaz só o
 *   que é de custo zero; o smoke de perfis só roda ao aceitar uma versão.
 */

export const FAIXA_SEM_SANDBOX =
  'Os agentes rodam sem sandbox: um script escrito a partir de um chamado malicioso pode ler o que seu usuário lê e acessar a rede. Compensam: regras deny, planejador só leitura, revisão independente com os comandos conferidos no stream, aprovação do diff.';

export const ARQUIVO_COMPAT = 'compat-cli.json';

/**
 * Modelo dos subagentes no smoke. O `--model` do perfil vai como `haiku`
 * (alias aceito pela CLI, 01 §7), mas o `agentes.json` exige ID completo
 * (`settings-gerados.ts`: "nunca alias") — o mesmo que os spikes usam (08 §2).
 */
export const MODELO_SMOKE_ID = 'claude-haiku-4-5-20251001';

/** Disco livre abaixo disso vira aviso (worktrees + node_modules por execução). */
export const DISCO_MINIMO_BYTES = 5 * 1024 ** 3;

export interface RegistroSmokeVersao {
  smoke_aprovado: boolean;
  em: string;
  falhas: string[];
}

interface ArquivoCompat {
  versoes: Record<string, RegistroSmokeVersao>;
}

export type RodarSmokePerfis = (versao: string) => Promise<{ ok: boolean; falhas: string[] }>;

export interface DepsCompatCli {
  exec: FuncaoExec;
  dirDados: string;
  fixada?: string;
  agora?: () => Date;
  /** Smoke de perfis (custa cota). Ausente = "aceitar versão" responde 501. */
  rodarSmoke?: RodarSmokePerfis;
}

export class CompatCli {
  versao: VersaoVerificada = { encontrada: null, ok: false, erro: 'ainda não verificado' };
  auth: AuthVerificada = {
    ok: false,
    authMethod: null,
    subscriptionType: null,
    erro: 'ainda não verificado',
  };
  git: VersaoVerificada = { encontrada: null, ok: false, erro: 'ainda não verificado' };
  verificadoEm: string | null = null;
  readonly fixada: string;
  private registro: ArquivoCompat;

  constructor(private readonly deps: DepsCompatCli) {
    this.fixada = deps.fixada ?? VERSAO_CLI_FIXADA;
    this.registro = this.lerRegistro();
  }

  private get caminho(): string {
    return join(this.deps.dirDados, ARQUIVO_COMPAT);
  }

  private lerRegistro(): ArquivoCompat {
    try {
      if (!existsSync(this.caminho)) return { versoes: {} };
      const bruto = JSON.parse(readFileSync(this.caminho, 'utf8')) as Partial<ArquivoCompat>;
      return { versoes: bruto.versoes ?? {} };
    } catch {
      return { versoes: {} };
    }
  }

  /** As três checagens de custo zero (boot e "Rodar tudo"). */
  async checar(): Promise<void> {
    const [versao, auth, git] = await Promise.all([
      verificarVersaoCli(this.deps.exec, this.fixada),
      verificarAuthCli(this.deps.exec),
      verificarGit(this.deps.exec),
    ]);
    this.versao = versao;
    this.auth = auth;
    this.git = git;
    this.verificadoEm = (this.deps.agora?.() ?? new Date()).toISOString();
  }

  /** Smoke aprovado para a versão encontrada (a fixada dispensa: foi validada na spec). */
  smokeAprovado(): boolean {
    const v = this.versao.encontrada;
    if (!v) return false;
    if (v === this.fixada) return true;
    return this.registro.versoes[v]?.smoke_aprovado === true;
  }

  /** CLI utilizável pelo pipeline (03 §11 "CLI atualizada"; 01 §7 A9). */
  versaoLiberada(): boolean {
    return this.versao.encontrada !== null && (this.versao.ok || this.smokeAprovado());
  }

  pipelineLiberado(): boolean {
    return this.versaoLiberada() && this.auth.ok && this.git.ok;
  }

  ultimoSmoke(versao: string): RegistroSmokeVersao | null {
    return this.registro.versoes[versao] ?? null;
  }

  /** "Aceitar versão X" (06 §4.10): só a versão ENCONTRADA, e só com smoke aprovado. */
  async aceitarVersao(versao: string): Promise<RegistroSmokeVersao> {
    if (!this.versao.encontrada || versao !== this.versao.encontrada) {
      throw new ErroForja(
        'conflito',
        `a versão instalada é ${this.versao.encontrada ?? 'nenhuma'}, não ${versao}`,
        409,
      );
    }
    if (!this.deps.rodarSmoke) {
      throw new ErroForja('nao_implementado', 'smoke de perfis indisponível nesta instância', 501);
    }
    const r = await this.deps.rodarSmoke(versao);
    const reg: RegistroSmokeVersao = {
      smoke_aprovado: r.ok,
      em: (this.deps.agora?.() ?? new Date()).toISOString(),
      falhas: r.falhas,
    };
    this.registro.versoes[versao] = reg;
    await writeFile(this.caminho, `${JSON.stringify(this.registro, null, 2)}\n`, { mode: 0o600 });
    return reg;
  }
}

// ---------------------------------------------------------------------------
// Smoke de perfis (01 §7, linhas "Versão nova / sob demanda")
// ---------------------------------------------------------------------------

export interface ResultadoSmokePerfil extends ResultadoSmoke {
  perfil: NomePerfil;
  exitCode: number | null;
  stderr: string;
}

/** Roda um comando da CLI com o prompt no stdin (como o runner) e devolve stdout/stderr. */
export function executarComandoCli(
  comando: ComandoClaude,
  prompt: string,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((ok) => {
    const filho = spawn(comando.executavel, comando.args, {
      cwd: comando.cwd,
      env: comando.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    filho.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    filho.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    filho.stdin.on('error', () => {});
    filho.stdin.end(prompt);
    const timer = setTimeout(() => {
      try {
        if (filho.pid) process.kill(-filho.pid, 'SIGKILL');
      } catch {
        // já saiu
      }
    }, timeoutMs);
    filho.on('error', (e) => {
      clearTimeout(timer);
      ok({ stdout, stderr: `${stderr}${e.message}`, exitCode: null });
    });
    filho.on('close', (codigo) => {
      clearTimeout(timer);
      ok({ stdout, stderr, exitCode: codigo });
    });
  });
}

/**
 * Monta os arquivos de etapa reais (settings/agentes/sistema) numa área
 * descartável `<dados>/compat/<versao>/` e roda cada perfil com
 * `comandoSmokePerfil`. A área é apagada no fim.
 */
export async function rodarSmokePerfis(opcoes: {
  dirDados: string;
  versao: string;
  envOrigem: Env;
  perfis?: readonly NomePerfil[];
  executar?: typeof executarComandoCli;
}): Promise<{ ok: boolean; falhas: string[]; perfis: ResultadoSmokePerfil[] }> {
  const raiz = join(opcoes.dirDados, 'compat', opcoes.versao.replace(/[^\w.-]/g, '_'));
  const execucaoId = `smoke-${randomUUID()}`;
  const worktree = join(raiz, 'worktree');
  const repoUsuario = join(raiz, 'repo-usuario');
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  await mkdir(repoUsuario, { recursive: true, mode: 0o700 });
  const executar = opcoes.executar ?? executarComandoCli;
  const perfis = opcoes.perfis ?? (Object.values(NomePerfil) as NomePerfil[]);
  const resultados: ResultadoSmokePerfil[] = [];
  try {
    let n = 0;
    for (const perfil of perfis) {
      n += 1;
      let agentes: ArquivoAgentes | null = null;
      if (perfil === 'condutor_t1') {
        agentes = gerarAgentesT1({
          modelo: MODELO_SMOKE_ID,
          esforco: 'low',
          promptImplementador: 'Smoke de compatibilidade: responda em uma frase.',
        });
      } else if (perfil === 'condutor_t2') {
        agentes = gerarAgentesT2({
          modelo: MODELO_SMOKE_ID,
          esforco: 'low',
          promptRevisorCorrecao: 'Smoke de compatibilidade: responda em uma frase.',
          promptRevisorSeguranca: 'Smoke de compatibilidade: responda em uma frase.',
        });
      }
      const dirExec = join(opcoes.dirDados, 'execucoes', execucaoId);
      const arquivos = await gravarArquivosEtapa(dirExec, n, {
        settings: gerarSettings({
          perfil,
          dirDados: opcoes.dirDados,
          execucaoId,
          worktreePropria: worktree,
          worktreesExistentes: [worktree],
          repoDirUsuario: repoUsuario,
          reposOutrosProjetos: [],
          branchDestino: 'main',
        }),
        agentes,
        sistema: 'Smoke de compatibilidade da Forja. Siga o pedido à risca.',
      });
      const comando = comandoSmokePerfil({
        perfil,
        sessao: { modo: 'novo', sessionId: randomUUID() },
        modelo: 'haiku',
        esforco: 'low',
        modeloSubagentes: MODELO_SMOKE_ID,
        numeroChamado: 0,
        orcamentoUsd: 0.05,
        arquivos: {
          settings: arquivos.settings,
          sistema: arquivos.sistema,
          agentes: arquivos.agentes,
        },
        jsonSchema: null,
        dirEntrada: perfil === 'planejador' ? join(dirExec, 'entrada') : null,
        cwd: worktree,
        env: { envOrigem: opcoes.envOrigem },
      });
      const saida = await executar(comando, PROMPT_SMOKE);
      const avaliado = avaliarSmoke({ perfil, ...saida });
      resultados.push({ ...avaliado, perfil, exitCode: saida.exitCode, stderr: saida.stderr });
    }
  } finally {
    await rm(raiz, { recursive: true, force: true }).catch(() => {});
    await rm(join(opcoes.dirDados, 'execucoes', execucaoId), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
  const falhas = resultados.flatMap((r) => r.falhas.map((f) => `${r.perfil}: ${f}`));
  return { ok: falhas.length === 0 && resultados.length > 0, falhas, perfis: resultados };
}

// ---------------------------------------------------------------------------
// Diagnóstico (06 §4.10)
// ---------------------------------------------------------------------------

export interface ConexaoParaDiagnostico {
  nome: string;
  estado: 'ok' | 'sem_login' | 'erro';
  erro: string | null;
}

export interface DepsDiagnostico {
  compat: CompatCli;
  exec: FuncaoExec;
  dirDados: string;
  env: Env;
  /** `null` = `node-pty` carregou; texto = por que não. */
  falhaPty: string | null;
  conexoes: () => ConexaoParaDiagnostico[];
  /** Autoteste do servidor local (Host/Origin forjados). Ausente antes do `listen`. */
  autoteste?: () => Promise<{ ok: boolean; detalhe: string }>;
  host: string;
  /** "MCP do Chamados para os agentes" (FJ-030 §4). Ausente = item não aparece. */
  mcpChamados?: () => Promise<{ ok: boolean; detalhe: string }>;
}

function item(
  codigo: string,
  titulo: string,
  estado: ItemDiagnosticoDto['estado'],
  detalhe: string,
  bloqueia: ItemDiagnosticoDto['bloqueia'] = null,
  acao: ItemDiagnosticoDto['acao'] = null,
): ItemDiagnosticoDto {
  return { codigo, titulo, estado, detalhe, bloqueia, acao };
}

export class DiagnosticoForja implements PortaDiagnostico {
  private ultimo: DiagnosticoDto | null = null;

  constructor(private readonly deps: DepsDiagnostico) {}

  /** Liga o autoteste depois do `listen` (o boot roda o Diagnóstico antes de ter porta). */
  definirAutoteste(fn: DepsDiagnostico['autoteste']): void {
    this.deps.autoteste = fn;
  }

  async obter(): Promise<DiagnosticoDto> {
    return this.ultimo ?? this.rodar();
  }

  async rodar(): Promise<DiagnosticoDto> {
    await this.deps.compat.checar();
    this.ultimo = await this.montar();
    return this.ultimo;
  }

  async aceitarVersaoCli(versao: string): Promise<DiagnosticoDto> {
    await this.deps.compat.aceitarVersao(versao);
    this.ultimo = await this.montar();
    return this.ultimo;
  }

  private async montar(): Promise<DiagnosticoDto> {
    const { compat, exec } = this.deps;
    const itens = itensDiagnosticoCli(compat.versao, compat.auth, compat.git, compat.fixada);
    const versao = compat.versao.encontrada;
    // Versão diferente com smoke aprovado libera o pipeline (A9): o item deixa de bloquear.
    if (versao && !compat.versao.ok) {
      const ultimo = compat.ultimoSmoke(versao);
      const cli = itens.find((i) => i.codigo === 'cli_versao');
      if (cli && compat.smokeAprovado()) {
        cli.estado = 'aviso';
        cli.bloqueia = null;
        cli.detalhe = `claude ${versao} aceita (smoke de perfis aprovado em ${ultimo?.em ?? '?'}).`;
      }
      itens.push(
        item(
          'cli_smoke',
          'Smoke de perfis da versão nova',
          ultimo?.smoke_aprovado ? 'ok' : ultimo ? 'aviso' : 'pendente',
          ultimo
            ? ultimo.smoke_aprovado
              ? `Aprovado em ${ultimo.em}.`
              : `Reprovado em ${ultimo.em}: ${ultimo.falhas.slice(0, 3).join('; ')}`
            : `Opcional: aceite a versão ${versao} para rodar o smoke de perfis (≈ US$ 0,04 equivalente, haiku).`,
          // Smoke de perfis é opcional: nunca bloqueia (ver cli_versao).
          null,
        ),
      );
    }

    if (this.deps.env.ANTHROPIC_API_KEY) {
      itens.push(
        item(
          'api_key_ambiente',
          'ANTHROPIC_API_KEY no ambiente',
          'aviso',
          'A variável existe no ambiente da Forja, mas não é repassada aos agentes (allowlist, 05 §4.7): eles usam o login da assinatura.',
        ),
      );
    }

    const [nome, email] = await Promise.all([
      exec('git', ['config', '--global', 'user.name']),
      exec('git', ['config', '--global', 'user.email']),
    ]);
    const temIdentidade = nome.codigo === 0 && email.codigo === 0;
    itens.push(
      item(
        'git_identidade',
        'Identidade de commit do git',
        temIdentidade ? 'ok' : 'aviso',
        temIdentidade
          ? `${nome.stdout.trim()} <${email.stdout.trim()}>`
          : 'Sem user.name/user.email globais: cada repositório precisa ter a identidade configurada, senão os checkpoints falham.',
      ),
    );

    const gh = await exec('gh', ['--version']);
    itens.push(
      item(
        'gh',
        'GitHub CLI (gh)',
        gh.codigo === 0 ? 'ok' : 'aviso',
        gh.codigo === 0
          ? (gh.stdout.split('\n')[0] ?? 'gh')
          : 'Não instalado. Só é necessário no modo PR (Fase 2); a entrega merge + push não usa.',
      ),
    );

    const conexoes = this.deps.conexoes();
    if (conexoes.length === 0) {
      itens.push(
        item(
          'chamados',
          'Conexão com o Chamados',
          'pendente',
          'Nenhuma conexão cadastrada.',
          'execucoes',
          { rotulo: 'Cadastrar conexão', href: '/conexao' },
        ),
      );
    }
    for (const c of conexoes) {
      itens.push(
        item(
          'chamados',
          `Chamados: ${c.nome}`,
          c.estado === 'ok' ? 'ok' : c.estado === 'sem_login' ? 'pendente' : 'erro',
          c.estado === 'ok'
            ? 'Sessão válida.'
            : (c.erro ?? 'Ainda sem login: use "Testar conexão" na tela Conexão.'),
          c.estado === 'ok' ? null : 'execucoes',
          c.estado === 'ok' ? null : { rotulo: 'Abrir Conexão', href: '/conexao' },
        ),
      );
    }

    if (this.deps.mcpChamados) {
      const mcp = await this.deps.mcpChamados().catch((e: unknown) => ({
        ok: false,
        detalhe: e instanceof Error ? e.message : String(e),
      }));
      // Não bloqueia: sem MCP os agentes ainda têm a `entrada/` gravada pelo app.
      itens.push(
        item(
          'mcp_chamados',
          'MCP do Chamados para os agentes',
          mcp.ok ? 'ok' : 'aviso',
          mcp.detalhe,
          null,
          mcp.ok ? null : { rotulo: 'Abrir Conexão', href: '/conexao' },
        ),
      );
    }
    const shell = headlessShellInstalado();
    itens.push(
      item(
        'forja_print',
        'Prints pelos agentes (forja-print)',
        shell ? 'ok' : 'aviso',
        shell
          ? `Chromium headless em ${shell}`
          : 'Chromium do Playwright não encontrado: rode `npx playwright install chromium-headless-shell`. Sem ele, os agentes usam o Playwright que houver ou declaram que não fotografaram.',
      ),
    );

    const auto = this.deps.autoteste ? await this.deps.autoteste() : null;
    const bindOk = this.deps.host === '127.0.0.1';
    itens.push(
      item(
        'servidor_local',
        'Servidor local',
        !bindOk || (auto && !auto.ok) ? 'erro' : auto ? 'ok' : 'pendente',
        `${bindOk ? 'bind 127.0.0.1' : `bind ${this.deps.host} (deveria ser 127.0.0.1)`}; ${
          auto ? auto.detalhe : 'autoteste de Host/Origin roda depois que a porta abre'
        }`,
        !bindOk || (auto && !auto.ok) ? 'pipeline' : null,
      ),
    );

    itens.push(
      item(
        'modulos_nativos',
        'Módulos nativos',
        this.deps.falhaPty ? 'erro' : 'ok',
        this.deps.falhaPty
          ? `better-sqlite3 ok; node-pty não carregou (${this.deps.falhaPty}): o Terminal fica indisponível.`
          : 'better-sqlite3 e node-pty carregados.',
        this.deps.falhaPty ? 'terminal' : null,
      ),
    );

    try {
      const s = await statfs(this.deps.dirDados);
      const livre = s.bavail * s.bsize;
      const gb = (livre / 1024 ** 3).toFixed(1);
      itens.push(
        item(
          'disco',
          'Espaço em disco (dados e worktrees)',
          livre < DISCO_MINIMO_BYTES ? 'aviso' : 'ok',
          `${gb} GB livres em ${this.deps.dirDados}`,
        ),
      );
    } catch (e) {
      itens.push(item('disco', 'Espaço em disco', 'aviso', (e as Error).message));
    }

    return {
      verificado_em: compat.verificadoEm,
      itens,
      pipeline_bloqueado: itens.some((i) => i.estado === 'erro' && i.bloqueia === 'pipeline'),
      faixa: FAIXA_SEM_SANDBOX,
      versao_cli: {
        encontrada: versao,
        fixada: compat.fixada,
        smoke_aprovado: compat.smokeAprovado(),
      },
    };
  }
}
