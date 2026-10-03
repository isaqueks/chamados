import type { FetchImpl } from '@chamados/cliente-api';
import type { ConexaoDto, TesteConexaoDto } from '../../comum/dto';
import type { LocalSenha } from '../../comum/estados';
import {
  avaliarPapel,
  ConexaoChamados,
  type PersistenciaConexao,
  type ResultadoTesteConexao,
} from '../chamados/conexao';
import type { BancoForja } from '../db/banco';
import { ConexaoChamadosSchema, type ConexaoChamados as LinhaConexao } from '../db/entidades';
import type { CredencialMcpChamados, FonteChamados } from '../dominio/nucleo';
import type { PortaConexoes } from '../dominio/servicos';
import type { Segredos } from '../segredos/keyring';

/**
 * Conexões com o Chamados em produção (specs/forja/07 §2; 06 §4.9): uma
 * `ConexaoChamados` (R2) por linha de `conexao_chamados`, servindo DUAS
 * portas — `PortaConexoes` (tela Conexão, via fachada) e a `FonteChamados`
 * que o orquestrador usa para fila, G0, polling e outbox.
 *
 * POR QUE um cache em memória: a sessão (token, estado "credencial inválida",
 * bloqueio do 429, D-036 detectada) vive na instância; recriá-la a cada
 * chamada perderia o bloqueio do rate limit e faria um login por requisição
 * (07 §2.2: "login só se não houver token válido").
 *
 * `fonte()` é síncrona (contrato do orquestrador): uma conexão criada agora
 * entra no cache no primeiro gesto da tela (guardar senha, testar, relogar) ou
 * no `carregar` disparado pelo próprio `fonte()`.
 *
 * Senha `nao_guardada` (05 §8): fica SÓ em memória, aqui, até o primeiro
 * "Testar"/"Reconectar" a entregar à conexão — nunca vai para disco.
 */

export interface DepsGerenteConexoes {
  banco: BancoForja;
  segredos: Segredos;
  fetch?: FetchImpl;
  /** Uma conexão entrou no cache (o boot liga o polling dela, 07 §8.1). */
  aoCarregar?: (conexaoId: string) => void;
  log?: (mensagem: string) => void;
}

/** `PersistenciaConexao` (R2) sobre o repositório TypeORM de `conexao_chamados`. */
export function persistenciaConexaoSqlite(banco: BancoForja): PersistenciaConexao {
  return {
    lerToken: (id) =>
      banco.ler(async (r) => {
        const c = await r.conexoes.obter(id);
        return c ? { token_cifrado: c.token_cifrado, token_expira_em: c.token_expira_em } : null;
      }),
    gravarToken: (id, token_cifrado, token_expira_em) =>
      banco.transacao(async (r) => {
        await r.m.update(ConexaoChamadosSchema, { id }, { token_cifrado, token_expira_em });
      }),
    limparToken: (id) => banco.transacao((r) => r.conexoes.limparToken(id)),
    registrarLogin: (id, d) =>
      banco.transacao(async (r) => {
        await r.m.update(
          ConexaoChamadosSchema,
          { id },
          {
            usuario_id: d.usuario_id,
            usuario_nome: d.usuario_nome,
            papel: d.papel,
            ultimo_login_em: d.ultimo_login_em,
          },
        );
      }),
  };
}

/** Estado da sessão (R2) → `ConexaoDto.estado` (06 §4.9). */
export function estadoDto(c: ConexaoChamados): ConexaoDto['estado'] {
  const e = c.estadoSessao();
  return e === 'ok' ? 'ok' : e === 'sem_login' ? 'sem_login' : 'erro';
}

/** Resultado do teste (com campos internos) → DTO da tela. */
export function testeDto(r: ResultadoTesteConexao): TesteConexaoDto {
  return {
    ok: r.ok,
    usuario: r.usuario,
    papel_aceito: r.papel_aceito,
    aviso: r.aviso,
    token_valido_ate: r.token_valido_ate,
    erro: r.erro,
  };
}

interface Entrada {
  conexao: ConexaoChamados;
  linha: LinhaConexao;
}

export class GerenteConexoes implements PortaConexoes {
  private readonly cache = new Map<string, Entrada>();
  private readonly senhasEmMemoria = new Map<string, string>();
  private readonly carregando = new Map<string, Promise<Entrada | null>>();
  private readonly persistencia: PersistenciaConexao;

  constructor(private readonly deps: DepsGerenteConexoes) {
    this.persistencia = persistenciaConexaoSqlite(deps.banco);
  }

  /** Boot: todas as conexões gravadas entram no cache (e ganham polling). */
  async carregarTodas(): Promise<void> {
    const linhas = await this.deps.banco.ler((r) => r.conexoes.listar());
    for (const l of linhas) await this.carregar(l.id);
  }

  /** (Re)cria a instância de uma conexão a partir da linha atual. `null` = não existe/URL inválida. */
  async carregar(id: string): Promise<Entrada | null> {
    const emCurso = this.carregando.get(id);
    if (emCurso) return emCurso;
    const p = (async () => {
      const linha = await this.deps.banco.ler((r) => r.conexoes.obter(id));
      if (!linha) {
        this.cache.delete(id);
        return null;
      }
      try {
        const conexao = new ConexaoChamados(
          {
            id: linha.id,
            url_base: linha.url_base,
            tenant_slug: linha.tenant_slug,
            email: linha.email,
            local_senha: linha.local_senha,
            usuario_id: linha.usuario_id,
            usuario_nome: linha.usuario_nome,
            papel: linha.papel,
          },
          { segredos: this.deps.segredos, persistencia: this.persistencia, fetch: this.deps.fetch },
        );
        const entrada = { conexao, linha };
        const nova = !this.cache.has(id);
        this.cache.set(id, entrada);
        if (nova) this.deps.aoCarregar?.(id);
        return entrada;
      } catch (e) {
        this.deps.log?.(`conexão ${linha.nome}: ${(e as Error).message}`);
        this.cache.delete(id);
        return null;
      }
    })().finally(() => this.carregando.delete(id));
    this.carregando.set(id, p);
    return p;
  }

  private async exigir(id: string): Promise<Entrada> {
    const e = this.cache.get(id) ?? (await this.carregar(id));
    if (!e) throw new Error(`conexão ${id} inexistente ou com URL inválida`);
    return e;
  }

  /** `FonteChamados` do orquestrador (null = conexão ainda não carregada/inexistente). */
  fonte(id: string): FonteChamados | null {
    const e = this.cache.get(id);
    if (!e) {
      void this.carregar(id).catch((err: unknown) =>
        this.deps.log?.(`conexão ${id}: ${err instanceof Error ? err.message : String(err)}`),
      );
      return null;
    }
    const { conexao, linha } = e;
    const papel = linha.papel === 'admin' || linha.papel === 'operador' ? linha.papel : undefined;
    return {
      api: conexao,
      identidade: () => conexao.identidade(),
      d036: () => conexao.modoD036(),
      podeUsar: () => conexao.podeUsar(),
      erro: () => conexao.erro(),
      urlBase: linha.url_base,
      ...(papel ? { papel } : {}),
    };
  }

  /**
   * URL, tenant, e-mail e token da conexão para o `mcp.<n>.json` dos agentes
   * (FJ-030 §4). Nunca vai a DTO, log ou evento (o token é registrado no redator).
   */
  async credencialAgentes(id: string): Promise<CredencialMcpChamados | null> {
    const e = this.cache.get(id) ?? (await this.carregar(id));
    if (!e) return null;
    const token = await e.conexao.tokenSessao();
    if (!token) return null;
    return {
      url: e.linha.url_base,
      tenant: e.linha.tenant_slug,
      email: e.linha.email,
      token,
    };
  }

  /** Para o Diagnóstico: cada conexão com o estado da sessão e o erro legível. */
  resumo(): { id: string; nome: string; estado: ConexaoDto['estado']; erro: string | null }[] {
    return [...this.cache.values()].map(({ conexao, linha }) => ({
      id: linha.id,
      nome: linha.nome,
      estado: estadoDto(conexao),
      erro: conexao.erro()?.mensagem ?? null,
    }));
  }

  // --- PortaConexoes -------------------------------------------------------

  estado(id: string): ReturnType<PortaConexoes['estado']> {
    const e = this.cache.get(id);
    if (!e) return { estado: 'sem_login', erro: null, avisos: [] };
    const avisos: string[] = [];
    const papel = avaliarPapel(e.linha.papel);
    if (papel.aviso) avisos.push(papel.aviso);
    const seg = this.deps.segredos.diagnostico();
    if (e.linha.local_senha !== 'nao_guardada' && seg.motivo_fallback) {
      avisos.push(`Senha em arquivo 0600 no diretório de dados (${seg.motivo_fallback}).`);
    }
    return { estado: estadoDto(e.conexao), erro: e.conexao.erro(), avisos };
  }

  async guardarSenha(id: string, senha: string, local: LocalSenha): Promise<void> {
    if (local === 'nao_guardada') {
      this.senhasEmMemoria.set(id, senha);
      await this.carregar(id);
      return;
    }
    await this.deps.segredos.gravarSenha(id, senha);
    // O keyring pode ter caído no arquivo 0600 no boot: a linha diz onde a senha ESTÁ.
    const real = this.deps.segredos.local();
    if (real !== local) {
      await this.deps.banco.transacao((r) => r.conexoes.atualizar(id, { local_senha: real }));
    }
    this.senhasEmMemoria.delete(id);
    await this.carregar(id);
  }

  async testar(id: string): Promise<TesteConexaoDto> {
    const { conexao } = await this.exigir(id);
    const pendente = this.senhasEmMemoria.get(id);
    if (pendente !== undefined) {
      this.senhasEmMemoria.delete(id);
      return testeDto(await conexao.relogar(pendente));
    }
    return testeDto(await conexao.testar());
  }

  async relogar(id: string, senha?: string): Promise<TesteConexaoDto> {
    const { conexao } = await this.exigir(id);
    const s = senha ?? this.senhasEmMemoria.get(id);
    this.senhasEmMemoria.delete(id);
    const r = await conexao.relogar(s);
    // O login pode ter gravado identidade nova na linha: a fonte passa a vê-la.
    const linha = await this.deps.banco.ler((repo) => repo.conexoes.obter(id));
    if (linha) this.cache.set(id, { conexao, linha });
    return testeDto(r);
  }

  async esquecer(id: string): Promise<void> {
    const e = this.cache.get(id);
    if (e) await e.conexao.desconectar();
    await this.deps.segredos.apagarSenha(id);
    this.senhasEmMemoria.delete(id);
    this.cache.delete(id);
  }

  recarregar(id: string): void {
    this.cache.delete(id);
    void this.carregar(id);
  }
}
