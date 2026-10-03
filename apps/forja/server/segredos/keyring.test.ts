import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARQUIVO_CREDENCIAIS,
  BackendArquivo,
  BackendKeyringSo,
  CONTA_CHAVE_DADOS,
  SERVICO_KEYRING,
  abrirSegredos,
  cifrarEnvelope,
  decifrarEnvelope,
  type BackendSegredos,
  type EntradaKeyring,
} from './keyring';

/**
 * Segredos (specs/forja/05 §8; 02 §8): keyring com backend FALSO (nenhum teste
 * toca o keyring real do SO), fallback em arquivo `0600` num diretório
 * temporário e o envelope AES-256-GCM com AAD = id da conexão.
 */

class KeyringFalso implements BackendSegredos {
  readonly tipo = 'keyring' as const;
  dados = new Map<string, string>();
  falhar: Error | null = null;
  naoPersiste = false;

  async ler(s: string, c: string): Promise<string | null> {
    if (this.falhar) throw this.falhar;
    return this.dados.get(`${s}/${c}`) ?? null;
  }
  async gravar(s: string, c: string, v: string): Promise<void> {
    if (this.falhar) throw this.falhar;
    if (!this.naoPersiste) this.dados.set(`${s}/${c}`, v);
  }
  async apagar(s: string, c: string): Promise<boolean> {
    return this.dados.delete(`${s}/${c}`);
  }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forja-segredos-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('envelope AES-256-GCM', () => {
  const chave = Buffer.alloc(32, 7);

  it('ida e volta com o mesmo AAD', () => {
    const env = cifrarEnvelope(chave, 'tok-secreto', 'conexao-1');
    expect(env.startsWith('v1:')).toBe(true);
    expect(env).not.toContain('tok-secreto');
    expect(decifrarEnvelope(chave, env, 'conexao-1')).toBe('tok-secreto');
  });

  it('recusa AAD de outra conexão, envelope adulterado e lixo', () => {
    const env = cifrarEnvelope(chave, 'tok', 'conexao-1');
    expect(decifrarEnvelope(chave, env, 'conexao-2')).toBeNull();
    const partes = env.split(':');
    const corpo = Buffer.from(partes[3]!, 'base64');
    corpo[0] = corpo[0]! ^ 1;
    partes[3] = corpo.toString('base64');
    expect(decifrarEnvelope(chave, partes.join(':'), 'conexao-1')).toBeNull();
    expect(decifrarEnvelope(chave, 'v2:a:b:c', 'conexao-1')).toBeNull();
    expect(decifrarEnvelope(Buffer.alloc(32, 8), env, 'conexao-1')).toBeNull();
  });

  it('IV aleatório: cifrar duas vezes dá envelopes diferentes', () => {
    expect(cifrarEnvelope(chave, 'x', 'a')).not.toBe(cifrarEnvelope(chave, 'x', 'a'));
  });
});

describe('abrirSegredos com keyring', () => {
  it('usa o keyring, cria a chave de dados e guarda a senha por conexão', async () => {
    const kr = new KeyringFalso();
    const s = await abrirSegredos({ dirDados: dir, keyring: kr });
    expect(s.local()).toBe('keyring');
    expect(s.diagnostico().motivo_fallback).toBeNull();
    expect(
      Buffer.from(kr.dados.get(`${SERVICO_KEYRING}/${CONTA_CHAVE_DADOS}`)!, 'base64'),
    ).toHaveLength(32);

    await s.gravarSenha('c1', 's3nha');
    expect(kr.dados.get('forja/conexao:c1')).toBe('s3nha');
    expect(await s.lerSenha('c1')).toBe('s3nha');
    await s.apagarSenha('c1');
    expect(await s.lerSenha('c1')).toBeNull();
  });

  it('o token cifrado sobrevive a um "reinício" (mesma chave no keyring)', async () => {
    const kr = new KeyringFalso();
    const env = await (
      await abrirSegredos({ dirDados: dir, keyring: kr })
    ).cifrarToken('c1', 'tok');
    const depois = await abrirSegredos({ dirDados: dir, keyring: kr });
    expect(await depois.decifrarToken('c1', env)).toBe('tok');
    expect(await depois.decifrarToken('c2', env)).toBeNull();
  });

  it('keyring com erro cai no arquivo 0600 e registra o motivo', async () => {
    const kr = new KeyringFalso();
    kr.falhar = new Error('sem D-Bus');
    const s = await abrirSegredos({ dirDados: dir, keyring: kr });
    expect(s.local()).toBe('arquivo');
    expect(s.diagnostico().motivo_fallback).toContain('sem D-Bus');
    await s.gravarSenha('c1', 'pw');
    const caminho = join(dir, ARQUIVO_CREDENCIAIS);
    expect((await stat(caminho)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(caminho, 'utf8'))['forja/conexao:c1']).toBe('pw');
  });

  it('keyring que aceita a escrita e não persiste também cai no arquivo', async () => {
    const kr = new KeyringFalso();
    kr.naoPersiste = true;
    const s = await abrirSegredos({ dirDados: dir, keyring: kr });
    expect(s.local()).toBe('arquivo');
  });

  it('keyring novo herda a chave do arquivo (tokens antigos continuam legíveis)', async () => {
    const soArquivo = await abrirSegredos({ dirDados: dir, semKeyring: true });
    const env = await soArquivo.cifrarToken('c1', 'tok-antigo');
    const kr = new KeyringFalso();
    const comKeyring = await abrirSegredos({ dirDados: dir, keyring: kr });
    expect(comKeyring.local()).toBe('keyring');
    expect(await comKeyring.decifrarToken('c1', env)).toBe('tok-antigo');
  });
});

describe('BackendArquivo', () => {
  it('grava concorrente sem perder chaves e apaga', async () => {
    const b = new BackendArquivo(join(dir, 'sub', ARQUIVO_CREDENCIAIS));
    await Promise.all([b.gravar('s', 'a', '1'), b.gravar('s', 'b', '2'), b.gravar('s', 'c', '3')]);
    expect(await b.ler('s', 'a')).toBe('1');
    expect(await b.ler('s', 'c')).toBe('3');
    expect(await b.apagar('s', 'b')).toBe(true);
    expect(await b.apagar('s', 'b')).toBe(false);
    expect(await b.ler('s', 'b')).toBeNull();
  });
});

describe('BackendKeyringSo (fábrica injetada)', () => {
  it('traduz getPassword/setPassword/deletePassword', async () => {
    const mapa = new Map<string, string>();
    const fabrica = (s: string, c: string): EntradaKeyring => ({
      getPassword: async () => mapa.get(`${s}|${c}`),
      setPassword: async (v) => void mapa.set(`${s}|${c}`, v),
      deletePassword: async () => mapa.delete(`${s}|${c}`),
    });
    const b = new BackendKeyringSo(fabrica);
    expect(await b.ler('forja', 'x')).toBeNull();
    await b.gravar('forja', 'x', 'v');
    expect(await b.ler('forja', 'x')).toBe('v');
    expect(await b.apagar('forja', 'x')).toBe(true);
  });
});
