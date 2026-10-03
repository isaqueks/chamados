/**
 * Smoke local da Forja de ponta a ponta, SEM Claude real por padrão
 * (`npm run smoke:local -w @chamados/forja`; specs/forja/01 §4.1, §8, §11, §3.2;
 * 05 §7.1–§7.2; 06 §4.9–§4.11).
 *
 * Roteiro:
 *  1. garante `web/dist` (builda se faltar), cria um diretório de dados
 *     temporário e um CLONE descartável deste repositório (alvo do projeto);
 *  2. sobe `server/main.ts` (processo de verdade, porta livre, `FORJA_SEM_KEYRING=1`)
 *     e lê o token do stdout;
 *  3. sessão: `/?t=` → cookie; sem cookie → 401; POST sem Origin → 403;
 *  4. cria conexão com o Chamados (o login pode falhar: o erro tem de vir
 *     TIPADO), cria o projeto SÓ com a pasta do clone (FJ-030 §1) e confere o
 *     "Detectado" (branch, scripts `typecheck`/`testes` como dicas, detectores),
 *     confere que `projeto_gravar_login` e `testar-comandos` saíram (404; FJ-032:
 *     a Forja não executa comandos do projeto), sincroniza e lista a fila;
 *  5. Configurações globais (FJ-030 §2): obter, gravar, restaurar; Diagnóstico:
 *     versão da CLI real, `auth status`, git e a faixa "sem sandbox";
 *  6. SSE global: abre, recebe o replay e o heartbeat; canal de execução
 *     inexistente → 404; histórico e worktrees vazios;
 *  7. Terminal: upgrade com Origin forjado → 403, sem cookie → 401, handshake
 *     válido troca bytes (frame binário) e controle (JSON). O PTY roda um
 *     binário falso (`FORJA_PTY_COMANDO`), salvo com `FORJA_SMOKE_CLAUDE=1`, que
 *     abre o chat livre com o `claude` de verdade (gasta só se você digitar);
 *  8. SIGTERM no servidor: sai com 0 e nenhum processo filho fica vivo.
 *
 * Variáveis: `FORJA_SMOKE_CHAMADOS_URL` (padrão `http://localhost:3000`),
 * `FORJA_SMOKE_TENANT` (padrão `demo`), `FORJA_SMOKE_EMAIL`/`FORJA_SMOKE_SENHA`
 * (padrão: credencial inválida — prova o erro tipado), `FORJA_SMOKE_CLAUDE=1`,
 * `FORJA_SMOKE_MANTER=1` (não apaga o diretório temporário).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodigoErroConexao,
  montarCaminho,
  montarQuery,
  ROTAS_API,
  type EntradaRota,
  type NomeRota,
  type SaidaRota,
} from '../../comum/dto';
import { descendentes } from '../boot/processos';

const RAIZ_APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RAIZ_REPO = resolve(RAIZ_APP, '../..');
const COM_CLAUDE = process.env.FORJA_SMOKE_CLAUDE === '1';

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

const resultados: { nome: string; ok: boolean; detalhe: string }[] = [];
function conferir(nome: string, ok: boolean, detalhe = ''): void {
  resultados.push({ nome, ok, detalhe });
  console.log(`${ok ? '  ✓' : '  ✗'} ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}
function secao(titulo: string): void {
  console.log(`\n${titulo}`);
}

// ---------------------------------------------------------------------------
// Apoio
// ---------------------------------------------------------------------------

function portaLivre(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface ClienteWs {
  on(evento: 'open', fn: () => void): void;
  on(evento: 'message', fn: (dados: Buffer, binario: boolean) => void): void;
  on(
    evento: 'unexpected-response',
    fn: (req: { destroy(): void }, res: { statusCode: number }) => void,
  ): void;
  on(evento: 'error', fn: (erro: Error) => void): void;
  on(evento: 'close', fn: (codigo: number) => void): void;
  send(dados: string | Buffer, opcoes?: { binary?: boolean }): void;
  close(): void;
  terminate(): void;
}
// `ws` vem com o @fastify/websocket (sem @types/ws: tipamos só o usado).
const { WebSocket } = createRequire(import.meta.url)('ws') as {
  WebSocket: new (url: string, opcoes: { headers: Record<string, string> }) => ClienteWs;
};

/** Handshake WS: `{status}` da recusa, ou o socket aberto. */
function abrirWs(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; ws: ClienteWs | null }> {
  return new Promise((ok) => {
    const ws = new WebSocket(url, { headers });
    const t = setTimeout(() => {
      ws.terminate();
      ok({ status: 0, ws: null });
    }, 5000);
    ws.on('open', () => {
      clearTimeout(t);
      ok({ status: 101, ws });
    });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(t);
      req.destroy();
      ok({ status: res.statusCode, ws: null });
    });
    ws.on('error', () => {
      clearTimeout(t);
      ok({ status: 0, ws: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Roteiro
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), 'forja-smoke-'));
  const dirDados = join(tmp, 'dados');
  const clone = join(tmp, 'chamados-clone');
  let servidor: ChildProcess | null = null;
  console.log(`[smoke:local] área temporária: ${tmp}`);

  try {
    secao('1. Preparação');
    if (!existsSync(join(RAIZ_APP, 'web', 'dist', 'index.html'))) {
      execFileSync('npm', ['run', 'build', '-w', '@chamados/forja'], {
        cwd: RAIZ_REPO,
        stdio: 'inherit',
      });
    }
    conferir('SPA buildada (web/dist)', existsSync(join(RAIZ_APP, 'web', 'dist', 'index.html')));
    execFileSync('git', [
      'clone',
      '-q',
      '--no-local',
      '--depth',
      '1',
      `file://${RAIZ_REPO}`,
      clone,
    ]);
    conferir('clone descartável do repositório', existsSync(join(clone, '.git')), clone);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FORJA_DADOS_DIR: dirDados,
      FORJA_SEM_KEYRING: '1',
    };
    delete env.FORJA_MODO;
    if (!COM_CLAUDE) {
      const falso = join(tmp, 'pty-falso.sh');
      writeFileSync(falso, '#!/bin/sh\necho "forja-pty-falso pronto"\nexec cat\n');
      chmodSync(falso, 0o755);
      env.FORJA_PTY_COMANDO = falso;
    }
    const porta = await portaLivre();
    env.FORJA_PORTA = String(porta);
    const base = `http://127.0.0.1:${porta}`;

    secao('2. Boot');
    servidor = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
      cwd: RAIZ_APP,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    servidor.stdout!.on('data', (d: Buffer) => (saida += d.toString()));
    servidor.stderr!.on('data', (d: Buffer) => (saida += d.toString()));
    const fim = new Promise<number | null>((ok) => servidor!.on('exit', (c) => ok(c)));
    let token: string | null = null;
    for (let i = 0; i < 300 && !token; i++) {
      token = /\/\?t=([\w-]+)/.exec(saida)?.[1] ?? null;
      if (!token) await dormir(100);
    }
    conferir('servidor subiu e imprimiu o link com token', token !== null);
    if (!token) {
      console.log(saida);
      return 1;
    }
    for (const linha of saida.split('\n').filter((l) => l.startsWith('[forja]'))) {
      // O token só aparece no stdout do processo — aqui não reimprimimos o link.
      if (!linha.includes('?t=')) console.log(`     ${linha}`);
    }

    secao('3. Sessão local (05 §7.1)');
    const abertura = await fetch(`${base}/?t=${token}`, { redirect: 'manual' });
    const cookie = (abertura.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    conferir(
      'abertura /?t= troca o token por cookie e limpa a URL',
      abertura.status === 303 &&
        cookie.startsWith('forja_sessao=') &&
        abertura.headers.get('location') === '/',
      `${abertura.status} → ${abertura.headers.get('location')}`,
    );
    const semCookie = await fetch(`${base}/api/shell`);
    conferir('API sem cookie → 401', semCookie.status === 401);
    // `/%61pi/...` é roteado como `/api/...`: a sessão é decidida pelo caminho decodificado.
    const codificado = await fetch(`${base}/%61pi/shell`);
    conferir(
      'API com caminho percent-encoded sem cookie → 401',
      codificado.status === 401,
      String(codificado.status),
    );
    const semOrigem = await fetch(`${base}/api/fila/sincronizar`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    conferir('POST sem Origin → 403', semOrigem.status === 403);

    async function api<N extends NomeRota>(
      nome: N,
      args: { params?: Record<string, string>; entrada?: EntradaRota<N> } = {},
    ): Promise<{ status: number; corpo: SaidaRota<N> & { erro?: string; mensagem?: string } }> {
      const def = ROTAS_API[nome];
      const caminho = montarCaminho(def.caminho, args.params ?? {});
      const get = def.metodo === 'GET';
      const r = await fetch(`${base}${caminho}${get ? montarQuery(args.entrada) : ''}`, {
        method: def.metodo,
        headers: {
          cookie,
          origin: base,
          ...(get ? {} : { 'content-type': 'application/json' }),
        },
        body: get ? undefined : JSON.stringify(args.entrada ?? {}),
      });
      return { status: r.status, corpo: (await r.json()) as never };
    }

    const shell = await api('shell_obter');
    conferir('GET /api/shell', shell.status === 200, `modo ${shell.corpo.modo ?? '?'}`);

    secao('4. Conexão, projeto e fila (07 §2; 06 §4.1, §4.8, §4.9)');
    const conexao = await api('conexao_criar', {
      entrada: {
        nome: 'smoke',
        url_base: process.env.FORJA_SMOKE_CHAMADOS_URL ?? 'http://localhost:3000',
        tenant_slug: process.env.FORJA_SMOKE_TENANT ?? 'demo',
        ambiente: 'dev',
        email: process.env.FORJA_SMOKE_EMAIL ?? 'forja-smoke@exemplo.invalid',
        senha: process.env.FORJA_SMOKE_SENHA ?? 'senha-de-smoke-invalida',
        local_senha: 'nao_guardada',
      },
    });
    conferir('cria conexão (201)', conexao.status === 201, conexao.corpo.mensagem ?? '');
    const conexaoId = conexao.corpo.id;
    const teste = await api('conexao_testar', { params: { id: conexaoId } });
    const codigos = Object.values(CodigoErroConexao) as string[];
    conferir(
      'testar conexão: login ok OU erro tipado',
      teste.status === 200 &&
        (teste.corpo.ok ||
          (teste.corpo.erro !== null && codigos.includes(teste.corpo.erro.codigo))),
      teste.corpo.ok
        ? `logado como ${teste.corpo.usuario?.nome ?? '?'}`
        : `erro ${teste.corpo.erro?.codigo}: ${teste.corpo.erro?.mensagem}`,
    );
    const conexoes = await api('conexoes_listar');
    conferir(
      'lista conexões sem vazar senha/token',
      conexoes.status === 200 &&
        conexoes.corpo.conexoes.length === 1 &&
        !JSON.stringify(conexoes.corpo).includes('senha-de-smoke'),
      `estado ${conexoes.corpo.conexoes[0]?.estado}`,
    );

    // FJ-030 §1: só a pasta — nome, branch, comandos, detectores e sistemas são autodetectados.
    const deteccao = await api('projeto_detectar', { entrada: { repo_dir: clone } });
    conferir(
      'autodetecta o repositório (sem gravar)',
      deteccao.status === 200 && deteccao.corpo.valido === true,
      deteccao.corpo.erro ?? `branch ${deteccao.corpo.detectado?.branch_destino ?? '?'}`,
    );
    const projeto = await api('projeto_criar', {
      entrada: { config: { versao: 2, nome: '', repo_dir: clone }, conexao_id: conexaoId },
    });
    conferir(
      'cria projeto só com a pasta (201)',
      projeto.status === 201,
      projeto.corpo.mensagem ?? '',
    );
    const projetoId = projeto.corpo.id;
    const obtido = await api('projeto_obter', { params: { id: projetoId } });
    const det = obtido.corpo.detectado;
    const nomesCmd = (det?.comandos.verificacao ?? []).map((c) => c.nome);
    conferir(
      'nome default = pasta do repositório',
      obtido.status === 200 && obtido.corpo.config?.nome === 'chamados-clone',
      obtido.corpo.config?.nome ?? '?',
    );
    conferir(
      'Detectado: branch de destino',
      det?.branch_destino === 'main',
      `${det?.branch_destino ?? '?'} (${det?.origem_branch ?? '?'})`,
    );
    conferir(
      'Detectado: comandos typecheck e testes pelo package.json',
      nomesCmd.includes('typecheck') && nomesCmd.includes('testes'),
      `${det?.gerenciador ?? '?'} · ${nomesCmd.join(', ')}`,
    );
    conferir(
      'Detectado: detectores por convenção',
      (det?.detectores.banco ?? []).includes('**/migrations/**') &&
        (det?.detectores.sensivel ?? []).includes('.github/**') &&
        (det?.detectores.frontend.length ?? 0) > 0,
      `${det?.detectores.banco.length ?? 0} banco · ${det?.detectores.frontend.length ?? 0} frontend`,
    );
    conferir(
      'snapshot resolvido usa o detectado',
      obtido.corpo.resolvida?.repo.branch_destino === det?.branch_destino,
      obtido.corpo.resolvida?.repo.branch_destino ?? '?',
    );
    const projetos = await api('projetos_listar');
    conferir('lista projetos', projetos.status === 200 && projetos.corpo.projetos.length === 1);
    // Rotas da captura pelo app saíram (FJ-030 §3), as de IA do servidor
    // (FJ-031: a Forja nunca silencia/reativa) e "Testar comandos" (FJ-032: a
    // Forja não executa comandos do projeto): nem no contrato, nem no servidor.
    const removidas = [
      'projeto_gravar_login',
      'projeto_testar_captura',
      'chamado_silenciar_ia',
      'lembrete_ia_feito',
      'projeto_testar_comandos',
    ].filter((n) => n in ROTAS_API);
    const postar = (caminho: string) =>
      fetch(`${base}${caminho}`, {
        method: 'POST',
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: '{}',
      });
    const login = await postar(`/api/projetos/${projetoId}/login-evidencias`);
    const testarCmd = await postar(`/api/projetos/${projetoId}/testar-comandos`);
    conferir(
      'rotas removidas (FJ-030, FJ-031, FJ-032) não existem mais (404)',
      removidas.length === 0 && login.status === 404 && testarCmd.status === 404,
      `${login.status}/${testarCmd.status}${removidas.length ? ` · ainda no contrato: ${removidas.join(', ')}` : ''}`,
    );
    // FJ-032: sem semáforo de verificações nem correções de verificação nas configurações.
    const cfgFj032 = await api('configuracoes_obter');
    conferir(
      'configurações sem verificações em paralelo nem correções de verificação (FJ-032)',
      cfgFj032.status === 200 &&
        !('verificacoes' in cfgFj032.corpo.configuracoes.concorrencia) &&
        !('max_correcoes_verificacao' in cfgFj032.corpo.configuracoes.limites.ciclos),
    );

    const sinc = await api('fila_sincronizar', { entrada: { projeto_id: projetoId } });
    conferir(
      'sincroniza a fila (servidor ou cache)',
      sinc.status === 200 || sinc.status === 503,
      sinc.status === 200 ? `fonte ${sinc.corpo.fonte}` : `${sinc.corpo.erro}`,
    );
    const fila = await api('fila_listar', { entrada: { projeto_id: projetoId } });
    conferir(
      'lista a fila',
      fila.status === 200 && Array.isArray(fila.corpo.itens),
      `${fila.corpo.itens?.length ?? 0} chamado(s)`,
    );

    secao('5. Configurações globais (FJ-030 §2; 06 §4.12)');
    const cfg = await api('configuracoes_obter');
    conferir(
      'obtém as configurações (padrões)',
      cfg.status === 200 &&
        JSON.stringify(cfg.corpo.configuracoes) === JSON.stringify(cfg.corpo.padrao),
      cfg.corpo.arquivo ?? '',
    );
    const alterada = structuredClone(cfg.corpo.configuracoes);
    alterada.concorrencia.implementacoes = 1;
    const gravada = await api('configuracoes_gravar', { entrada: alterada });
    const relida = await api('configuracoes_obter');
    conferir(
      'grava e relê (concorrência 1)',
      gravada.status === 200 && relida.corpo.configuracoes?.concorrencia.implementacoes === 1,
      `status ${gravada.status}`,
    );
    const restaurada = await api('configuracoes_restaurar');
    conferir(
      'restaura os padrões',
      restaurada.status === 200 &&
        restaurada.corpo.configuracoes?.concorrencia.implementacoes ===
          cfg.corpo.padrao?.concorrencia.implementacoes,
      `implementações ${restaurada.corpo.configuracoes?.concorrencia.implementacoes ?? '?'}`,
    );

    secao('5b. Diagnóstico (06 §4.10)');
    const diag = await api('diagnostico_obter');
    const itens = new Map((diag.corpo.itens ?? []).map((i) => [i.codigo, i]));
    conferir('GET /api/diagnostico', diag.status === 200);
    conferir(
      'versão da CLI real',
      itens.has('cli_versao'),
      `encontrada ${diag.corpo.versao_cli?.encontrada ?? 'nenhuma'} · fixada ${diag.corpo.versao_cli?.fixada}`,
    );
    conferir(
      'claude auth status',
      itens.has('cli_login'),
      `${itens.get('cli_login')?.estado}: ${itens.get('cli_login')?.detalhe}`,
    );
    conferir(
      'git',
      itens.get('git_versao')?.estado === 'ok',
      itens.get('git_versao')?.detalhe ?? '',
    );
    conferir('faixa "sem sandbox"', /sem sandbox/i.test(diag.corpo.faixa ?? ''));
    conferir(
      'autoteste Host/Origin forjados',
      itens.get('servidor_local')?.estado === 'ok',
      itens.get('servidor_local')?.detalhe ?? '',
    );

    secao('6. SSE, histórico e worktrees (01 §8.1; 06 §4.11)');
    const sse = await fetch(`${base}/api/eventos?ultimo_seq=0`, { headers: { cookie } });
    const leitor = sse.body!.getReader();
    let textoSse = '';
    const limiteSse = Date.now() + 17_000;
    while (Date.now() < limiteSse && !textoSse.includes(': hb')) {
      const pedaco = await Promise.race([
        leitor.read(),
        dormir(Math.max(1, limiteSse - Date.now())).then(() => null),
      ]);
      if (!pedaco || pedaco.done) break;
      textoSse += new TextDecoder().decode(pedaco.value);
    }
    await leitor.cancel().catch(() => {});
    const eventos = textoSse.split('\n').filter((l) => l.startsWith('data: ')).length;
    conferir(
      'SSE global: stream aberto, replay do SQLite e heartbeat',
      sse.status === 200 &&
        (sse.headers.get('content-type') ?? '').startsWith('text/event-stream') &&
        textoSse.startsWith('retry: 3000') &&
        textoSse.includes(': hb'),
      `${eventos} evento(s) no replay`,
    );
    const sseExec = await fetch(`${base}/api/execucoes/nao-existe/eventos`, {
      headers: { cookie },
    });
    conferir('SSE de execução inexistente → 404', sseExec.status === 404);
    const hist = await api('historico_listar');
    conferir('histórico vazio', hist.status === 200 && hist.corpo.itens.length === 0);
    const wts = await api('worktrees_listar');
    conferir('worktrees vazias', wts.status === 200 && wts.corpo.worktrees.length === 0);

    secao(`7. Terminal (01 §11; 05 §7.2)${COM_CLAUDE ? ' — claude REAL' : ' — PTY falso'}`);
    const wsBase = `ws://127.0.0.1:${porta}`;
    const forjado = await abrirWs(`${wsBase}/api/terminal/qualquer`, {
      cookie,
      origin: 'http://forja.exemplo.invalid',
    });
    conferir('upgrade com Origin forjado → 403', forjado.status === 403, String(forjado.status));
    const semCookieWs = await abrirWs(`${wsBase}/api/terminal/qualquer`, { origin: base });
    conferir('upgrade sem cookie → 401', semCookieWs.status === 401, String(semCookieWs.status));
    const aberto = await api('terminal_abrir', { entrada: { projeto_id: projetoId } });
    conferir(
      'abre o chat livre no repositório (201)',
      aberto.status === 201,
      aberto.corpo.mensagem ?? '',
    );
    const sessaoId = aberto.corpo.sessao_id;
    const handshake = await abrirWs(`${wsBase}/api/terminal/${sessaoId}`, { cookie, origin: base });
    conferir('handshake válido → 101', handshake.status === 101);
    if (handshake.ws) {
      const ws = handshake.ws;
      let bytes = '';
      const controles: string[] = [];
      ws.on('message', (dados, binario) => {
        if (binario) bytes += dados.toString('utf8');
        else controles.push(dados.toString('utf8'));
      });
      ws.send(JSON.stringify({ tipo: 'redimensionar', colunas: 100, linhas: 30 }));
      const marca = 'ping-forja-smoke';
      if (!COM_CLAUDE) ws.send(Buffer.from(`${marca}\r`, 'utf8'), { binary: true });
      const limite = Date.now() + 8000;
      while (Date.now() < limite && !(COM_CLAUDE ? bytes.length > 200 : bytes.includes(marca))) {
        await dormir(100);
      }
      conferir(
        COM_CLAUDE ? 'TUI do claude desenhou na tela' : 'tecla em frame binário volta do PTY',
        COM_CLAUDE ? bytes.length > 200 : bytes.includes(marca),
        `${bytes.length} bytes recebidos`,
      );
      // JSON num frame de texto é controle, nunca entrada do PTY.
      ws.send(`{"tipo":"redimensionar","colunas":80,"linhas":24}`);
      ws.close();
    }
    const sessoes = await api('terminal_sessoes');
    conferir(
      'lista a sessão de terminal',
      sessoes.status === 200 && sessoes.corpo.sessoes.some((s) => s.id === sessaoId),
    );

    secao('8. Desligamento (01 §3.2)');
    const filhos = descendentes(servidor.pid!);
    conferir('filhos antes do SIGTERM', true, `${filhos.length} (PTY e afins)`);
    servidor.kill('SIGTERM');
    const codigo = await Promise.race([fim, dormir(45_000).then(() => 'tempo' as const)]);
    conferir('SIGTERM → sai com 0', codigo === 0, String(codigo));
    await dormir(300);
    const sobrou = filhos.filter(vivo);
    conferir('nenhum processo filho vivo', sobrou.length === 0, sobrou.join(', '));
    const depois = await fetch(`${base}/api/saude`).then(
      () => 'aberta',
      () => 'fechada',
    );
    conferir('porta fechada', depois === 'fechada');
    servidor = null;
  } finally {
    if (servidor && servidor.exitCode === null) servidor.kill('SIGKILL');
    if (process.env.FORJA_SMOKE_MANTER === '1') console.log(`\n(mantido) ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\nRESULTADO: ${falhas.length === 0 ? 'PASSOU' : `FALHOU (${falhas.length})`}`);
  return falhas.length === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e: unknown) => {
    console.error('[smoke:local] erro:', e);
    process.exit(1);
  },
);
