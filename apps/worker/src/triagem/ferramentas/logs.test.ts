import { describe, it, expect } from 'vitest';
import { criarHandleLogs, type ClienteSftp, type ConfigLogs } from './logs';

/**
 * Testes do adapter SFTP de `logs_consultar` (D-021) com cliente FAKE injetado
 * (a superfície `ClienteSftp` espelha o ssh2-sftp-client). Cobre: montagem da
 * conexão (senha vs chave), glob + ordenação por modificação, tail, filtro e
 * erros claros de configuração.
 */

interface ArquivoFake {
  nome: string;
  conteudo: string;
  modifyTime: number;
}

function clienteFake(arquivos: ArquivoFake[], conexoes: Array<Record<string, unknown>>) {
  const porCaminho = new Map(arquivos.map((a) => [`/var/log/app/${a.nome}`, a]));
  const cliente: ClienteSftp = {
    async connect(opts) {
      conexoes.push(opts);
      return undefined;
    },
    async list(dir) {
      if (dir !== '/var/log/app') throw new Error(`dir inesperado: ${dir}`);
      return arquivos.map((a) => ({
        name: a.nome,
        type: '-',
        size: Buffer.byteLength(a.conteudo),
        modifyTime: a.modifyTime,
      }));
    },
    async stat(caminho) {
      const a = porCaminho.get(caminho);
      if (!a) throw new Error('não existe');
      return { size: Buffer.byteLength(a.conteudo) };
    },
    async get(caminho, _dst, opts) {
      const a = porCaminho.get(caminho);
      if (!a) throw new Error('não existe');
      const buf = Buffer.from(a.conteudo, 'utf8');
      const start = opts?.readStreamOptions?.start ?? 0;
      return buf.subarray(start);
    },
    async end() {
      return undefined;
    },
  };
  return cliente;
}

function cfgSftp(extra?: Partial<ConfigLogs>): ConfigLogs {
  return {
    tipo: 'sftp',
    config: {
      host: 'servidor.empresa.com',
      porta: 2222,
      usuario: 'leitor',
      caminho: '/var/log/app/*.log',
    },
    credencial: 'senha-secreta',
    ...extra,
  };
}

const registrar = () => undefined;

describe('logs_consultar — adapter sftp (D-021)', () => {
  it('lê arquivos por glob, mais recentes primeiro, e filtra por substring', async () => {
    const conexoes: Array<Record<string, unknown>> = [];
    const cliente = clienteFake(
      [
        { nome: 'app-2026-07-15.log', conteudo: 'INFO ontem tudo ok\n', modifyTime: 100 },
        {
          nome: 'app-2026-07-16.log',
          conteudo: 'ERROR hoje falhou X\nINFO hoje ok\n',
          modifyTime: 200,
        },
        { nome: 'notas.txt', conteudo: 'não sou log\n', modifyTime: 300 },
      ],
      conexoes,
    );
    const handle = criarHandleLogs(cfgSftp(), registrar, async () => cliente);

    const todas = await handle({});
    // notas.txt fica fora (glob *.log); linhas em ordem cronológica de arquivo.
    expect(todas.map((l) => l.mensagem)).toEqual([
      'INFO ontem tudo ok',
      'ERROR hoje falhou X',
      'INFO hoje ok',
    ]);

    const erros = await handle({ consulta: 'error' });
    expect(erros).toHaveLength(1);
    expect(erros[0]!.nivel).toBe('ERROR');

    // Conexão montada com host/porta/usuário configurados e SENHA (não chave).
    expect(conexoes[0]).toMatchObject({
      host: 'servidor.empresa.com',
      port: 2222,
      username: 'leitor',
      password: 'senha-secreta',
    });
    expect(conexoes[0]).not.toHaveProperty('privateKey');
  });

  it('credencial "-----BEGIN…" vira privateKey (nunca password)', async () => {
    const conexoes: Array<Record<string, unknown>> = [];
    const cliente = clienteFake([{ nome: 'a.log', conteudo: 'x\n', modifyTime: 1 }], conexoes);
    const chave = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const handle = criarHandleLogs(cfgSftp({ credencial: chave }), registrar, async () => cliente);

    await handle({});
    expect(conexoes[0]).toMatchObject({ privateKey: chave });
    expect(conexoes[0]).not.toHaveProperty('password');
  });

  it('configuração incompleta gera erro CLARO (host/usuario/caminho/credencial)', async () => {
    const semHost = cfgSftp();
    semHost.config = { ...semHost.config, host: null };
    const handle = criarHandleLogs(semHost, registrar, async () => {
      throw new Error('não deveria conectar');
    });
    await expect(handle({})).rejects.toThrow(/logs_config\.host/);

    const semCred = cfgSftp({ credencial: null });
    const handle2 = criarHandleLogs(semCred, registrar, async () => {
      throw new Error('não deveria conectar');
    });
    await expect(handle2({})).rejects.toThrow(/credencial SFTP/);
  });

  it('tipo desconhecido lista os tipos suportados', async () => {
    const handle = criarHandleLogs(
      { tipo: 'cloudwatch', config: {}, credencial: null },
      registrar,
      async () => {
        throw new Error('não deveria conectar');
      },
    );
    await expect(handle({})).rejects.toThrow(/'arquivo', 'sftp'/);
  });
});
