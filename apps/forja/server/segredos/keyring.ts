import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LocalSenha } from '../../comum/estados';

/**
 * Guarda dos segredos da Forja (specs/forja/05 §8.1; 02 §8): a senha do operador
 * dedicado do Chamados e a CHAVE DE DADOS que cifra o token de sessão no SQLite.
 *
 * POR QUE keyring + fallback arquivo: o keyring do SO (libsecret via
 * `@napi-rs/keyring`) tira os segredos do disco em claro, mas pode não existir
 * ou estar trancado (sessão SSH, WSL sem D-Bus) — [NV] a validar no M1 (02 §8).
 * Nesse caso caímos em `<dados>/credenciais.json` com modo `0600`, sem nunca
 * travar o app. O modo escolhido é exposto (`local()`, `diagnostico()`) para a
 * tela Conexão e o Diagnóstico, e vira `conexao_chamados.local_senha`.
 *
 * POR QUE o token vai cifrado ao SQLite e não ao keyring: ele muda a cada login
 * e precisa ser lido em toda requisição; o keyring guarda só a chave (32 bytes
 * aleatórios, conta `chave-dados`). O envelope é AES-256-GCM
 * `v1:<iv b64>:<tag b64>:<cifra b64>` com AAD = `conexao_chamados.id`, o que
 * impede colar o token de uma conexão em outra (02 §8). A cifra com a chave no
 * mesmo disco (fallback) protege só contra cópia isolada do `forja.db` — aceito
 * em 05 §8.1.
 *
 * Nada aqui loga valores: erros carregam só o motivo.
 */

/** Serviço do keyring (02 §8). */
export const SERVICO_KEYRING = 'forja';
/** Conta da chave de dados no keyring (02 §8). */
export const CONTA_CHAVE_DADOS = 'chave-dados';
/** Nome do arquivo de fallback dentro do diretório de dados (02 §7). */
export const ARQUIVO_CREDENCIAIS = 'credenciais.json';

const PREFIXO_ENVELOPE = 'v1';
const TAMANHO_CHAVE = 32;
const TAMANHO_IV = 12;

/** Conta da senha de uma conexão no keyring (02 §8: `conexao:<id>`). */
export function contaSenhaConexao(conexaoId: string): string {
  return `conexao:${conexaoId}`;
}

/**
 * Armazém chave→valor de segredos. Duas implementações: o keyring do SO e o
 * arquivo `0600`. Os testes injetam uma em memória.
 */
export interface BackendSegredos {
  readonly tipo: Extract<LocalSenha, 'keyring' | 'arquivo'>;
  ler(servico: string, conta: string): Promise<string | null>;
  gravar(servico: string, conta: string, valor: string): Promise<void>;
  /** `true` se havia algo para apagar. */
  apagar(servico: string, conta: string): Promise<boolean>;
}

/** Superfície usada pela conexão (senha) e pelo armazenamento do token (cifra). */
export interface Segredos {
  /** Onde a senha fica de fato (`conexao_chamados.local_senha`). */
  local(): Extract<LocalSenha, 'keyring' | 'arquivo'>;
  /** Por que caiu no arquivo (`null` com keyring funcionando). Para o Diagnóstico. */
  diagnostico(): {
    local: Extract<LocalSenha, 'keyring' | 'arquivo'>;
    motivo_fallback: string | null;
  };
  lerSenha(conexaoId: string): Promise<string | null>;
  gravarSenha(conexaoId: string, senha: string): Promise<void>;
  apagarSenha(conexaoId: string): Promise<void>;
  /** Envelope `v1:<iv>:<tag>:<cifra>` com AAD = `conexaoId`. */
  cifrarToken(conexaoId: string, token: string): Promise<string>;
  /** `null` se o envelope é ilegível, adulterado ou de outra conexão (o token é descartado). */
  decifrarToken(conexaoId: string, envelope: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/** Forma mínima do `AsyncEntry` de `@napi-rs/keyring` que usamos (injetável em teste). */
export interface EntradaKeyring {
  getPassword(): Promise<string | undefined | null>;
  setPassword(valor: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export type FabricaEntradaKeyring = (servico: string, conta: string) => EntradaKeyring;

/**
 * Keyring do SO. O módulo nativo é carregado só no primeiro uso (import
 * dinâmico): numa máquina sem o binário, a falha vira fallback, não crash no boot.
 */
export class BackendKeyringSo implements BackendSegredos {
  readonly tipo = 'keyring' as const;
  private fabrica: Promise<FabricaEntradaKeyring> | null;

  constructor(fabrica?: FabricaEntradaKeyring) {
    this.fabrica = fabrica ? Promise.resolve(fabrica) : null;
  }

  private entrada(servico: string, conta: string): Promise<EntradaKeyring> {
    this.fabrica ??= import('@napi-rs/keyring').then(
      (m) => (s: string, c: string) => new m.AsyncEntry(s, c),
    );
    return this.fabrica.then((f) => f(servico, conta));
  }

  async ler(servico: string, conta: string): Promise<string | null> {
    const v = await (await this.entrada(servico, conta)).getPassword();
    return v ?? null;
  }

  async gravar(servico: string, conta: string, valor: string): Promise<void> {
    await (await this.entrada(servico, conta)).setPassword(valor);
  }

  async apagar(servico: string, conta: string): Promise<boolean> {
    return (await this.entrada(servico, conta)).deletePassword();
  }
}

/**
 * Fallback `credenciais.json` (`0600`, 02 §7–§8). Escrita atômica (arquivo
 * temporário `0600` + `rename`) para um crash no meio nunca deixar o JSON pela
 * metade — perder a chave de dados invalidaria todos os tokens cifrados.
 */
export class BackendArquivo implements BackendSegredos {
  readonly tipo = 'arquivo' as const;
  private fila: Promise<unknown> = Promise.resolve();

  constructor(private readonly caminho: string) {}

  private async lerTudo(): Promise<Record<string, string>> {
    try {
      const bruto = await readFile(this.caminho, 'utf8');
      const dados = JSON.parse(bruto) as unknown;
      if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return {};
      const saida: Record<string, string> = {};
      for (const [k, v] of Object.entries(dados)) if (typeof v === 'string') saida[k] = v;
      return saida;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  private async escreverTudo(dados: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.caminho), { recursive: true, mode: 0o700 });
    const tmp = `${this.caminho}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(dados, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.caminho);
  }

  /** Serializa leitura-modificação-escrita (duas gravações simultâneas não se perdem). */
  private serializado<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.fila.then(fn, fn);
    this.fila = r.catch(() => undefined);
    return r;
  }

  ler(servico: string, conta: string): Promise<string | null> {
    return this.serializado(async () => (await this.lerTudo())[`${servico}/${conta}`] ?? null);
  }

  gravar(servico: string, conta: string, valor: string): Promise<void> {
    return this.serializado(async () => {
      const dados = await this.lerTudo();
      dados[`${servico}/${conta}`] = valor;
      await this.escreverTudo(dados);
    });
  }

  apagar(servico: string, conta: string): Promise<boolean> {
    return this.serializado(async () => {
      const dados = await this.lerTudo();
      const chave = `${servico}/${conta}`;
      if (!(chave in dados)) return false;
      delete dados[chave];
      await this.escreverTudo(dados);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Cifra do token (AES-256-GCM, 02 §8)
// ---------------------------------------------------------------------------

/** Cifra `texto` com `chave` (32 bytes) e AAD; devolve o envelope `v1:iv:tag:cifra`. */
export function cifrarEnvelope(chave: Buffer, texto: string, aad: string): string {
  const iv = randomBytes(TAMANHO_IV);
  const cifra = createCipheriv('aes-256-gcm', chave, iv);
  cifra.setAAD(Buffer.from(aad, 'utf8'));
  const corpo = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [
    PREFIXO_ENVELOPE,
    iv.toString('base64'),
    tag.toString('base64'),
    corpo.toString('base64'),
  ].join(':');
}

/** Inverso de `cifrarEnvelope`; `null` se o envelope é inválido, adulterado ou de outro AAD. */
export function decifrarEnvelope(chave: Buffer, envelope: string, aad: string): string | null {
  const partes = envelope.split(':');
  if (partes.length !== 4 || partes[0] !== PREFIXO_ENVELOPE) return null;
  try {
    const iv = Buffer.from(partes[1]!, 'base64');
    const tag = Buffer.from(partes[2]!, 'base64');
    const corpo = Buffer.from(partes[3]!, 'base64');
    if (iv.length !== TAMANHO_IV || tag.length !== 16) return null;
    const decifra = createDecipheriv('aes-256-gcm', chave, iv);
    decifra.setAAD(Buffer.from(aad, 'utf8'));
    decifra.setAuthTag(tag);
    return Buffer.concat([decifra.update(corpo), decifra.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Composição
// ---------------------------------------------------------------------------

class SegredosComBackend implements Segredos {
  private chave: Promise<Buffer> | null = null;

  constructor(
    private readonly backend: BackendSegredos,
    private readonly motivoFallback: string | null,
  ) {}

  local(): Extract<LocalSenha, 'keyring' | 'arquivo'> {
    return this.backend.tipo;
  }

  diagnostico(): {
    local: Extract<LocalSenha, 'keyring' | 'arquivo'>;
    motivo_fallback: string | null;
  } {
    return { local: this.backend.tipo, motivo_fallback: this.motivoFallback };
  }

  lerSenha(conexaoId: string): Promise<string | null> {
    return this.backend.ler(SERVICO_KEYRING, contaSenhaConexao(conexaoId));
  }

  gravarSenha(conexaoId: string, senha: string): Promise<void> {
    return this.backend.gravar(SERVICO_KEYRING, contaSenhaConexao(conexaoId), senha);
  }

  async apagarSenha(conexaoId: string): Promise<void> {
    await this.backend.apagar(SERVICO_KEYRING, contaSenhaConexao(conexaoId));
  }

  async cifrarToken(conexaoId: string, token: string): Promise<string> {
    return cifrarEnvelope(await this.chaveDados(), token, conexaoId);
  }

  async decifrarToken(conexaoId: string, envelope: string): Promise<string | null> {
    return decifrarEnvelope(await this.chaveDados(), envelope, conexaoId);
  }

  /** Chave de dados: lida uma vez; gerada (32 bytes aleatórios) no primeiro boot. */
  private chaveDados(): Promise<Buffer> {
    this.chave ??= (async () => {
      const existente = await this.backend.ler(SERVICO_KEYRING, CONTA_CHAVE_DADOS);
      if (existente) {
        const b = Buffer.from(existente, 'base64');
        if (b.length === TAMANHO_CHAVE) return b;
      }
      const nova = randomBytes(TAMANHO_CHAVE);
      await this.backend.gravar(SERVICO_KEYRING, CONTA_CHAVE_DADOS, nova.toString('base64'));
      return nova;
    })().catch((e: unknown) => {
      this.chave = null;
      throw e;
    });
    return this.chave;
  }
}

export interface OpcoesAbrirSegredos {
  /** Diretório de dados (02 §7); o fallback mora em `<dirDados>/credenciais.json`. */
  dirDados: string;
  /** Padrão: keyring do SO. */
  keyring?: BackendSegredos;
  /** Padrão: `credenciais.json` em `dirDados`. */
  arquivo?: BackendSegredos;
  /** Força o arquivo (ex.: `FORJA_SEM_KEYRING=1` ou teste). */
  semKeyring?: boolean;
}

/**
 * Escolhe o backend no boot: sonda o keyring lendo (e, se preciso, criando) a
 * chave de dados e relendo-a — alguns keyrings aceitam a escrita e não
 * persistem. Qualquer falha cai no arquivo `0600`, com o motivo registrado.
 */
export async function abrirSegredos(opcoes: OpcoesAbrirSegredos): Promise<Segredos> {
  const arquivo = opcoes.arquivo ?? new BackendArquivo(join(opcoes.dirDados, ARQUIVO_CREDENCIAIS));
  if (opcoes.semKeyring) return new SegredosComBackend(arquivo, 'keyring desativado');
  const keyring = opcoes.keyring ?? new BackendKeyringSo();
  try {
    let chave = await keyring.ler(SERVICO_KEYRING, CONTA_CHAVE_DADOS);
    if (!chave) {
      // Migra a chave do arquivo, se um boot anterior caiu no fallback: os tokens
      // cifrados com ela continuam legíveis.
      const doArquivo = await arquivo.ler(SERVICO_KEYRING, CONTA_CHAVE_DADOS).catch(() => null);
      const nova = doArquivo ?? randomBytes(TAMANHO_CHAVE).toString('base64');
      await keyring.gravar(SERVICO_KEYRING, CONTA_CHAVE_DADOS, nova);
      chave = await keyring.ler(SERVICO_KEYRING, CONTA_CHAVE_DADOS);
      if (chave !== nova) throw new Error('o keyring aceitou a escrita mas não a devolveu');
    }
    return new SegredosComBackend(keyring, null);
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    return new SegredosComBackend(arquivo, `keyring indisponível: ${motivo}`);
  }
}
