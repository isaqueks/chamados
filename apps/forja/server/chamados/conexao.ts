import {
  ClienteChamados,
  ErroApi,
  ErroRede,
  ErroUrlBase,
  validarBaseUrl,
  type ArmazenamentoToken,
  type ArquivoBaixado,
  type EntradaMensagem,
  type EntradaStatus,
  type FetchImpl,
  type FiltrosListarChamados,
  type FormatoCorpo,
  type Identidade,
  type ItemChamado,
  type OpcoesChamada,
  type PaginaChamados,
  type RespostaAtribuicao,
  type RespostaDetalheChamado,
  type RespostaMensagem,
  type RespostaSilencioIa,
  type RespostaSistemasAlvo,
  type RespostaStatus,
} from '@chamados/cliente-api';
import type { CodigoErroConexao, TesteConexaoDto } from '../../comum/dto';
import type { LocalSenha } from '../../comum/estados';
import type { Segredos } from '../segredos/keyring';
import { detectarD036 } from './fila';
import type { IdentidadeForja, OperacoesChamados } from './tipos';

/**
 * Conexão com uma instância do Chamados (specs/forja/07 §2; 02 §4.1, §8;
 * 05 §8.1).
 *
 * Abre um `ClienteChamados` (`@chamados/cliente-api`) a partir de uma linha de
 * `conexao_chamados` e dos `Segredos`:
 *  - a senha vem do keyring/arquivo `0600` só na hora do login (ou da memória,
 *    com `local_senha = nao_guardada`, depois que o humano a digita);
 *  - o token é persistido CIFRADO (`token_cifrado`, AES-256-GCM, AAD = id da
 *    conexão) via `ArmazenamentoTokenCifrado` — reaproveitado entre reinícios,
 *    porque cada login cria uma `Sessao` nova e queima o rate limit (07 §2.2).
 *
 * POR QUE uma camada sobre o cliente: o cliente já faz o relogin 1×
 * (single-flight) e repete a requisição 1×. O que falta é o ESTADO da conexão,
 * que o resto da Forja consulta antes de agir (07 §2.2, §2.4; 03 §9.3):
 *  - segundo `401 nao_autenticado` (o que escapa do cliente) → `sessao_recusada`:
 *    nenhuma chamada mais sai até um gesto humano (`relogar`);
 *  - `401 credenciais_invalidas` → `credencial_invalida`: a Forja não tenta de
 *    novo sozinha; o outbox fica retido;
 *  - `429 muitas_tentativas` → `limite_login`: nenhuma chamada por 300 s;
 *  - `404 tenant_desconhecido` → `tenant_inexistente` (erro de configuração);
 *  - papel diferente de `operador`/`admin` no login → `papel_recusado`.
 * O polling consulta `podeUsar()` e pausa sem conexão válida (07 §8.1).
 *
 * A identidade (`usuario.id`, `nome`, `papel`) é gravada em `conexao_chamados`
 * a cada login (`registrarLogin`): o `nome` é o `autor_nome` que a
 * anti-duplicação compara, e o `id` é o alvo da atribuição (L4). O token e a
 * senha nunca saem daqui: nem em erro, nem em DTO, nem em log.
 */

/** Janela do rate limit do login (07 §2.2: 10/e-mail e 30/IP em 300 s). */
export const JANELA_RATE_LIMIT_MS = 300_000;

/** Campos de `conexao_chamados` (02 §4.1) que a conexão usa. */
export interface RegistroConexao {
  id: string;
  url_base: string;
  tenant_slug: string | null;
  email: string;
  local_senha: LocalSenha;
  usuario_id: string | null;
  usuario_nome: string | null;
  papel: string | null;
}

export interface TokenPersistido {
  token_cifrado: string | null;
  token_expira_em: string | null;
}

/**
 * Persistência que a conexão precisa da linha `conexao_chamados` (ligada pela
 * R3 ao repositório TypeORM).
 */
export interface PersistenciaConexao {
  lerToken(conexaoId: string): Promise<TokenPersistido | null>;
  gravarToken(conexaoId: string, tokenCifrado: string, expiraEm: string): Promise<void>;
  limparToken(conexaoId: string): Promise<void>;
  registrarLogin(
    conexaoId: string,
    dados: { usuario_id: string; usuario_nome: string; papel: string; ultimo_login_em: string },
  ): Promise<void>;
}

/**
 * `ArmazenamentoToken` da Forja: SQLite cifrado. Envelope ilegível (chave nova,
 * adulteração, colado de outra conexão) é tratado como "sem token" e apagado:
 * o cliente faz um login novo em vez de mandar lixo ao servidor.
 */
export class ArmazenamentoTokenCifrado implements ArmazenamentoToken {
  constructor(
    private readonly conexaoId: string,
    private readonly persistencia: PersistenciaConexao,
    private readonly segredos: Segredos,
  ) {}

  async ler(): Promise<string | null> {
    const t = await this.persistencia.lerToken(this.conexaoId);
    if (!t?.token_cifrado) return null;
    const token = await this.segredos.decifrarToken(this.conexaoId, t.token_cifrado);
    if (token === null) await this.persistencia.limparToken(this.conexaoId);
    return token;
  }

  async gravar(token: string, expiraEm: string): Promise<void> {
    const cifrado = await this.segredos.cifrarToken(this.conexaoId, token);
    await this.persistencia.gravarToken(this.conexaoId, cifrado, expiraEm);
  }

  async limpar(): Promise<void> {
    await this.persistencia.limparToken(this.conexaoId);
  }
}

// ---------------------------------------------------------------------------
// Estado e erros
// ---------------------------------------------------------------------------

export type EstadoSessao =
  | 'ok'
  | 'sem_login'
  | 'sessao_recusada'
  | 'credencial_invalida'
  | 'sem_senha'
  | 'limite_login'
  | 'tenant_inexistente'
  | 'papel_recusado';

/** Estados em que nenhuma chamada sai até um gesto humano (ou o fim da janela, no 429). */
const BLOQUEANTES: ReadonlySet<EstadoSessao> = new Set<EstadoSessao>([
  'sessao_recusada',
  'credencial_invalida',
  'sem_senha',
  'limite_login',
  'tenant_inexistente',
  'papel_recusado',
]);

/** A conexão não pode ser usada agora — o outbox fica retido, o polling pausa. */
export class ErroConexaoIndisponivel extends Error {
  constructor(
    readonly estado: EstadoSessao,
    mensagem: string,
    readonly bloqueadoAte: number | null = null,
  ) {
    super(mensagem);
    this.name = 'ErroConexaoIndisponivel';
  }
}

/** Não há senha guardada (`nao_guardada` sem digitar, ou keyring vazio). */
export class ErroSemSenha extends Error {
  constructor() {
    super('Senha do Chamados não disponível: informe-a na tela Conexão.');
    this.name = 'ErroSemSenha';
  }
}

/** URL base recusada pela Forja (07 §2.3). */
export class ErroUrlConexao extends Error {
  constructor(
    readonly codigo: Extract<CodigoErroConexao, 'url_loopback_ip' | 'outro'>,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ErroUrlConexao';
  }
}

/**
 * `validarBaseUrl` do cliente + a regra só da Forja: `127.0.0.1` é RECUSADO
 * (o proxy resolveria o tenant "127" e ignoraria o `x-tenant-slug` — 07 §2.3).
 */
export function validarUrlConexao(url: string): string {
  try {
    const { origem, avisos } = validarBaseUrl(url);
    const loopback = avisos.find((a) => a.codigo === 'ip_loopback');
    if (loopback) throw new ErroUrlConexao('url_loopback_ip', loopback.mensagem);
    return origem;
  } catch (e) {
    if (e instanceof ErroUrlBase) throw new ErroUrlConexao('outro', e.message);
    throw e;
  }
}

/** Papel aceito na conexão (07 §2.1): `operador`; `admin` com aviso; o resto, recusado. */
export function avaliarPapel(papel: string | null): { aceito: boolean; aviso: string | null } {
  if (papel === 'operador') return { aceito: true, aviso: null };
  if (papel === 'admin') {
    return {
      aceito: true,
      aviso:
        'O usuário é admin: tem mais privilégio do que a Forja precisa. Prefira um operador dedicado.',
    };
  }
  return { aceito: false, aviso: null };
}

const MENSAGEM_ESTADO: Record<Exclude<EstadoSessao, 'ok' | 'sem_login'>, string> = {
  sessao_recusada:
    'O Chamados recusou a sessão mesmo após um novo login. Reconecte na tela Conexão.',
  credencial_invalida: 'E-mail ou senha do Chamados inválidos. Informe a senha na tela Conexão.',
  sem_senha: 'Senha do Chamados não disponível. Informe-a na tela Conexão.',
  limite_login: 'Muitas tentativas de login no Chamados. Aguarde a janela de 5 minutos.',
  tenant_inexistente: 'O Chamados não reconheceu o tenant: confira a URL e o slug na tela Conexão.',
  papel_recusado: 'O usuário da conexão não é operador nem admin: a Forja não pode usá-lo.',
};

const CODIGO_ERRO_ESTADO: Record<Exclude<EstadoSessao, 'ok' | 'sem_login'>, CodigoErroConexao> = {
  sessao_recusada: 'outro',
  credencial_invalida: 'credencial_invalida',
  sem_senha: 'credencial_invalida',
  limite_login: 'limite_login',
  tenant_inexistente: 'tenant_inexistente',
  papel_recusado: 'papel_recusado',
};

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

export interface DependenciasConexao {
  segredos: Segredos;
  persistencia: PersistenciaConexao;
  fetch?: FetchImpl;
  /** Relógio em ms (teste do 429). */
  agora?: () => number;
}

export interface ResultadoTesteConexao extends TesteConexaoDto {
  /** `true`/`false` = D-036 presente/ausente; `null` = lista vazia, indeterminado (07 §2.5). */
  d036: boolean | null;
  estado: EstadoSessao;
}

export class ConexaoChamados implements OperacoesChamados {
  readonly cliente: ClienteChamados;
  private estado: EstadoSessao = 'sem_login';
  private bloqueadoAte: number | null = null;
  private senhaMemoria: string | null = null;
  private ultimaIdentidade: Identidade | null = null;
  private registro: RegistroConexao;
  private readonly agora: () => number;
  private d036: boolean | null = null;
  private readonly armazenamento: ArmazenamentoTokenCifrado;

  constructor(
    registro: RegistroConexao,
    private readonly deps: DependenciasConexao,
  ) {
    this.registro = { ...registro };
    this.agora = deps.agora ?? (() => Date.now());
    const origem = validarUrlConexao(registro.url_base);
    this.armazenamento = new ArmazenamentoTokenCifrado(
      registro.id,
      deps.persistencia,
      deps.segredos,
    );
    this.cliente = new ClienteChamados(
      {
        baseUrl: origem,
        email: registro.email,
        tenantSlug: registro.tenant_slug,
        obterSenha: () => this.obterSenha(),
      },
      {
        fetch: deps.fetch,
        armazenamento: this.armazenamento,
      },
    );
  }

  get id(): string {
    return this.registro.id;
  }

  /** Estado da sessão (o 429 expira sozinho depois da janela). */
  estadoSessao(): EstadoSessao {
    if (
      this.estado === 'limite_login' &&
      this.bloqueadoAte !== null &&
      this.agora() >= this.bloqueadoAte
    ) {
      this.estado = 'sem_login';
      this.bloqueadoAte = null;
    }
    return this.estado;
  }

  /** Pode sair uma chamada agora? (O polling pausa quando não — 07 §8.1.) */
  podeUsar(): boolean {
    return !BLOQUEANTES.has(this.estadoSessao());
  }

  /** Fim do bloqueio do 429 (ms), para o contador do Diagnóstico. */
  limiteLoginAte(): number | null {
    return this.estadoSessao() === 'limite_login' ? this.bloqueadoAte : null;
  }

  /** Erro legível do estado atual (`null` se ok/sem login). */
  erro(): { codigo: CodigoErroConexao; mensagem: string } | null {
    const e = this.estadoSessao();
    if (e === 'ok' || e === 'sem_login') return null;
    return { codigo: CODIGO_ERRO_ESTADO[e], mensagem: MENSAGEM_ESTADO[e] };
  }

  /**
   * Token da sessão para o MCP somente leitura dos agentes (FJ-030 §4). Sem
   * token guardado, uma chamada barata (`/sistemas-alvo`) abre a sessão.
   * `null` = sem sessão possível agora (os agentes seguem sem MCP).
   */
  async tokenSessao(): Promise<string | null> {
    const guardado = await this.armazenamento.ler();
    if (guardado) return guardado;
    if (!this.podeUsar()) return null;
    try {
      await this.listarSistemasAlvo();
    } catch {
      return null;
    }
    return this.armazenamento.ler();
  }

  /** Modo D-036 detectado no último teste/fila (`null` = ainda não sabido). */
  modoD036(): boolean | null {
    return this.d036;
  }

  /** Registra o modo detectado por quem leu a lista (a fila — 07 §2.5). */
  registrarD036(presente: boolean | null): void {
    if (presente !== null) this.d036 = presente;
  }

  /** Quem a Forja é no Chamados: do login deste processo ou do último gravado. */
  identidade(): IdentidadeForja | null {
    const q = this.cliente.quemSou();
    if (q) return { usuarioId: q.id, nome: q.nome };
    if (this.registro.usuario_id && this.registro.usuario_nome) {
      return { usuarioId: this.registro.usuario_id, nome: this.registro.usuario_nome };
    }
    return null;
  }

  private async obterSenha(): Promise<string> {
    if (this.registro.local_senha === 'nao_guardada') {
      if (this.senhaMemoria) return this.senhaMemoria;
      throw new ErroSemSenha();
    }
    const senha = this.senhaMemoria ?? (await this.deps.segredos.lerSenha(this.registro.id));
    if (!senha) throw new ErroSemSenha();
    return senha;
  }

  /** Grava a identidade de um login novo e confere o papel. */
  private async aposChamada(): Promise<void> {
    const q = this.cliente.quemSou();
    if (!q || q === this.ultimaIdentidade) return;
    this.ultimaIdentidade = q;
    this.registro = { ...this.registro, usuario_id: q.id, usuario_nome: q.nome, papel: q.papel };
    await this.deps.persistencia.registrarLogin(this.registro.id, {
      usuario_id: q.id,
      usuario_nome: q.nome,
      papel: q.papel,
      ultimo_login_em: new Date(this.agora()).toISOString(),
    });
    if (!avaliarPapel(q.papel).aceito) this.estado = 'papel_recusado';
  }

  /** Traduz o erro em estado da conexão (o chamador relança). */
  private registrarErro(e: unknown): void {
    if (e instanceof ErroSemSenha) {
      this.estado = 'sem_senha';
    } else if (e instanceof ErroApi) {
      if (e.status === 401 && e.codigo === 'credenciais_invalidas')
        this.estado = 'credencial_invalida';
      else if (e.status === 401) this.estado = 'sessao_recusada';
      else if (e.status === 429) {
        this.estado = 'limite_login';
        this.bloqueadoAte = this.agora() + JANELA_RATE_LIMIT_MS;
      } else if (e.status === 404 && e.codigo === 'tenant_desconhecido')
        this.estado = 'tenant_inexistente';
    }
  }

  /**
   * Toda chamada passa por aqui: recusa se a conexão está bloqueada, e atualiza
   * o estado com o resultado.
   */
  private async executar<T>(fn: (c: ClienteChamados) => Promise<T>): Promise<T> {
    const estado = this.estadoSessao();
    if (BLOQUEANTES.has(estado)) {
      throw new ErroConexaoIndisponivel(
        estado,
        MENSAGEM_ESTADO[estado as Exclude<EstadoSessao, 'ok' | 'sem_login'>],
        this.bloqueadoAte,
      );
    }
    try {
      const r = await fn(this.cliente);
      await this.aposChamada();
      const papel = this.registro.papel;
      this.estado = papel && !avaliarPapel(papel).aceito ? 'papel_recusado' : 'ok';
      return r;
    } catch (e) {
      await this.aposChamada().catch(() => undefined);
      this.registrarErro(e);
      throw e;
    }
  }

  // --- OperacoesChamados -------------------------------------------------

  listarChamados(filtros?: FiltrosListarChamados, opts?: OpcoesChamada): Promise<PaginaChamados> {
    return this.executar((c) => c.listarChamados(filtros, opts));
  }
  listarTodosChamados(
    filtros?: Omit<FiltrosListarChamados, 'cursor'>,
    opts?: OpcoesChamada & { maxPaginas?: number },
  ): Promise<ItemChamado[]> {
    return this.executar((c) => c.listarTodosChamados(filtros, opts));
  }
  obterChamado(
    ref: string,
    opts?: OpcoesChamada & { formato?: FormatoCorpo },
  ): Promise<RespostaDetalheChamado> {
    return this.executar((c) => c.obterChamado(ref, opts));
  }
  publicarMensagem(
    ref: string,
    entrada: EntradaMensagem,
    opts?: OpcoesChamada,
  ): Promise<RespostaMensagem> {
    return this.executar((c) => c.publicarMensagem(ref, entrada, opts));
  }
  mudarStatus(ref: string, entrada: EntradaStatus, opts?: OpcoesChamada): Promise<RespostaStatus> {
    return this.executar((c) => c.mudarStatus(ref, entrada, opts));
  }
  listarSistemasAlvo(opts?: OpcoesChamada): Promise<RespostaSistemasAlvo> {
    return this.executar((c) => c.listarSistemasAlvo(opts));
  }
  baixarAnexo(id: string, opts?: OpcoesChamada): Promise<ArquivoBaixado> {
    return this.executar((c) => c.baixarAnexo(id, opts));
  }
  definirSilencioIa(
    ref: string,
    silenciada: boolean,
    opts?: OpcoesChamada,
  ): Promise<RespostaSilencioIa> {
    return this.executar((c) => c.definirSilencioIa(ref, silenciada, opts));
  }
  atribuir(
    ref: string,
    operadorId: string | null,
    opts?: OpcoesChamada,
  ): Promise<RespostaAtribuicao> {
    return this.executar((c) => c.atribuir(ref, operadorId, opts));
  }

  // --- Gestos da tela Conexão (06 §4.9) ----------------------------------

  /**
   * "Testar conexão" (07 §2.2): login só se não houver token válido →
   * `GET /sistemas-alvo` → papel → detecção da D-036 por `ia_silenciada` no item
   * da lista (07 §2.5). É gesto humano: limpa um bloqueio anterior, salvo o 429.
   */
  async testar(): Promise<ResultadoTesteConexao> {
    if (this.estadoSessao() !== 'limite_login') {
      this.estado = this.estado === 'ok' ? 'ok' : 'sem_login';
    }
    try {
      await this.listarSistemasAlvo();
      const pagina = await this.listarChamados({ limite: 1 });
      this.registrarD036(detectarD036(pagina.itens));
    } catch (e) {
      return this.resultadoTeste(e);
    }
    return this.resultadoTeste(null);
  }

  /**
   * "Reconectar"/"Trocar senha": guarda a senha nova (keyring/arquivo, ou só
   * memória com `nao_guardada`), faz UM login novo e testa.
   */
  async relogar(senha?: string): Promise<ResultadoTesteConexao> {
    if (senha) {
      if (this.registro.local_senha === 'nao_guardada') this.senhaMemoria = senha;
      else {
        await this.deps.segredos.gravarSenha(this.registro.id, senha);
        this.senhaMemoria = null;
      }
    }
    if (this.estadoSessao() === 'limite_login') return this.resultadoTeste(null);
    this.estado = 'sem_login';
    try {
      await this.cliente.autenticar();
      await this.aposChamada();
    } catch (e) {
      await this.aposChamada().catch(() => undefined);
      this.registrarErro(e);
      return this.resultadoTeste(e);
    }
    return this.testar();
  }

  /**
   * "Desconectar"/"Trocar credencial" (07 §2.2): `DELETE /sessao` e apaga o
   * token local. Falha de rede não impede apagar o local.
   */
  async desconectar(): Promise<void> {
    try {
      await this.cliente.encerrarSessao();
    } catch (e) {
      if (!(e instanceof ErroRede) && !(e instanceof ErroApi)) throw e;
    } finally {
      this.estado = 'sem_login';
      this.bloqueadoAte = null;
      this.senhaMemoria = null;
    }
  }

  private resultadoTeste(erro: unknown): ResultadoTesteConexao {
    const papel = this.registro.papel;
    const avaliacao = avaliarPapel(papel);
    const usuario =
      this.registro.usuario_id && this.registro.usuario_nome && papel
        ? { id: this.registro.usuario_id, nome: this.registro.usuario_nome, papel }
        : null;
    const erroEstado = this.erro();
    let erroDto: ResultadoTesteConexao['erro'] = erroEstado;
    if (!erroDto && erro) erroDto = erroDeExcecao(erro);
    const q = this.cliente.quemSou();
    return {
      ok: erroDto === null && this.estadoSessao() === 'ok',
      usuario,
      papel_aceito: avaliacao.aceito,
      aviso: avaliacao.aviso,
      token_valido_ate: q?.expiraEm ?? null,
      erro: erroDto,
      d036: this.d036,
      estado: this.estadoSessao(),
    };
  }
}

/** Erro que não virou estado (rede, TLS, 5xx…) → código da tela Conexão. */
export function erroDeExcecao(e: unknown): { codigo: CodigoErroConexao; mensagem: string } {
  if (e instanceof ErroConexaoIndisponivel) {
    return {
      codigo: CODIGO_ERRO_ESTADO[e.estado as Exclude<EstadoSessao, 'ok' | 'sem_login'>] ?? 'outro',
      mensagem: e.message,
    };
  }
  if (e instanceof ErroRede) {
    const causa =
      e.cause instanceof Error
        ? `${e.cause.message} ${String((e.cause as { cause?: unknown }).cause ?? '')}`
        : '';
    const tls = /certificate|self.signed|SSL|TLS|CERT_/i.test(causa);
    return { codigo: tls ? 'tls' : 'rede', mensagem: e.message };
  }
  if (e instanceof ErroApi) {
    if (e.codigo === 'tenant_desconhecido')
      return { codigo: 'tenant_inexistente', mensagem: e.message };
    if (e.codigo === 'credenciais_invalidas')
      return { codigo: 'credencial_invalida', mensagem: e.message };
    if (e.status === 429) return { codigo: 'limite_login', mensagem: e.message };
    return { codigo: 'outro', mensagem: `${e.status} ${e.codigo}: ${e.message}` };
  }
  return { codigo: 'outro', mensagem: e instanceof Error ? e.message : String(e) };
}
