import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ClienteChamados, type MensagemChamado } from '@chamados/cliente-api';
import { normalizarCorpo } from '../../chamados/normalizacao';
import { marcadorForja, montarMensagemModelo } from '../../chamados/notas';
import {
  executarPasso,
  type ContextoOutbox,
  type ResultadoPasso,
} from '../../chamados/outbox-passos';
import { compararDetalhe, snapshotDoDetalhe } from '../../chamados/polling';
import {
  carregarEnvArquivo,
  esperar,
  executarSpike,
  RAIZ_REPO,
  vereditoDe,
  type RelatorioSpike,
} from './apoio';

/**
 * S7 — ciclo do Chamados local (specs/forja/08 §2; 07 §8.2, §9, §13; 03 §9).
 *
 * Contra o Chamados REAL em `http://localhost:3000` + `x-tenant-slug` (nunca
 * `127.0.0.1`, F-20), com um tenant DESCARTÁVEL criado aqui e removido ao fim
 * (mesmo método do `smoke:api`): operador dedicado "Forja" + cliente + chamado.
 * Tudo o que a Forja faria passa pelos MÓDULOS DE PRODUÇÃO de
 * `server/chamados` (`executarPasso`, `compararDetalhe`, `normalizarCorpo`):
 *  silenciar IA → em_atendimento → pergunta pública → aguardando_cliente →
 *  cliente responde (servidor leva a `em_triagem`, F14) → polling detecta →
 *  "Replanejar" move a `em_atendimento` (F15) → outbox nota → pública →
 *  resolvido → "crash" e re-execução dos passos 1 e 2 (nenhuma duplicata).
 * E-mails contados no Mailpit (`localhost:8025`) para o e-mail do cliente; se
 * o worker estiver fora, o critério fica PENDENTE.
 *
 * `@chamados/db` é importado DINAMICAMENTE: a Forja não depende do pacote do
 * servidor (só este spike provisiona o tenant), e o typecheck dela não o puxa.
 */

const BASE = 'http://localhost:3000';
const MAILPIT = 'http://localhost:8025';
const SENHA = 'Dev@12345';

interface FonteDados {
  initialize(): Promise<unknown>;
  destroy(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

interface ModuloDb {
  criarAppDataSource(): FonteDados;
  criarAdminDataSource(): FonteDados;
  runInTenantContext<T>(
    ds: FonteDados,
    tenantId: string,
    fn: (em: unknown) => Promise<T>,
  ): Promise<T>;
  provisionarTenant(
    ds: FonteDados,
    d: { slug: string; nome: string; nomeExibicao: string; status: string },
  ): Promise<{ tenant_id: string }>;
  criarUsuarioAtivoComSenha(
    em: unknown,
    d: { tenant_id: string; email: string; nome: string; papel: string; senha: string },
  ): Promise<string>;
  criarChamado(
    em: unknown,
    ator: { id: string; tenant_id: string; papel: string },
    d: { titulo: string; natureza: string; descricao: string },
  ): Promise<{ ok: true; id: string } | { ok: false; motivo: string }>;
  transicionarStatus(
    em: unknown,
    ator: unknown,
    id: string,
    status: string,
    o: { motivo: string },
  ): Promise<{ ok: boolean; motivo?: string }>;
  atorSistema(tenantId: string): unknown;
}

async function saudavel(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function emailsPara(email: string): Promise<number | null> {
  try {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { messages_count?: number; total?: number };
    return j.messages_count ?? j.total ?? null;
  } catch {
    return null;
  }
}

/** Espera o Mailpit chegar a `alvo` e-mails (ou o prazo); devolve o que viu. */
async function esperarEmails(email: string, alvo: number, ms: number): Promise<number | null> {
  const limite = Date.now() + ms;
  let n = await emailsPara(email);
  while ((n ?? 0) < alvo && Date.now() < limite) {
    await esperar(2000);
    n = await emailsPara(email);
  }
  return n;
}

function resumoPasso(r: ResultadoPasso): string {
  if (r.resultado === 'enviado')
    return `enviado${r.ja_feito ? ' (já feito)' : ''} → ${r.status_lido}`;
  if (r.resultado === 'pulado') return `pulado/${r.motivo}`;
  if (r.resultado === 'bloqueado') return `bloqueado/${r.motivo}: ${r.detalhe}`;
  if (r.resultado === 'precisa_humano') return `precisa_humano/${r.motivo}: ${r.detalhe}`;
  return `${r.resultado}/${r.motivo}: ${r.detalhe}`;
}

export async function executar(): Promise<number> {
  return executarSpike('s7', 'Ciclo do Chamados local (F-15/F-16)', async (r) => {
    if (!(await saudavel())) {
      for (const [id, d] of [
        ['S7.1', 'a pergunta chega ao cliente (1 e-mail)'],
        ['S7.2', 'resposta do cliente com IA silenciada → em_triagem (F14)'],
        ['S7.3', 'o polling detecta a mensagem nova'],
        ['S7.4', 'Replanejar move a em_atendimento (F15)'],
        ['S7.5', 'outbox nota → pública → resolvido (2 e-mails)'],
        ['S7.6', 're-execução dos passos 1 e 2 não duplica'],
        ['S7.7', 'duplicata detectada pelo corpo normalizado devolvido em markdown'],
      ] as const) {
        r.criterio(id, d, 'PENDENTE', `Chamados local fora (${BASE}/api/health não respondeu)`);
      }
      return;
    }
    carregarEnvArquivo(join(RAIZ_REPO, '.env'));
    const nomeModulo = '@chamados/db';
    const db = (await import(nomeModulo)) as ModuloDb;
    const ds = db.criarAppDataSource();
    await ds.initialize();
    const sufixo = randomUUID().slice(0, 8);
    const slug = `forja-s7-${sufixo}`;
    let tenantId = '';
    try {
      tenantId = (
        await db.provisionarTenant(ds, {
          slug,
          nome: 'Forja S7',
          nomeExibicao: 'Forja S7',
          status: 'ativo',
        })
      ).tenant_id;
      const emailOp = `forja.${sufixo}@spike.dev`;
      const emailCli = `cli.${sufixo}@spike.dev`;
      const { chamadoId, operadorId } = await db.runInTenantContext(ds, tenantId, async (em) => {
        const operadorId = await db.criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantId,
          email: emailOp,
          nome: 'Forja Spike',
          papel: 'operador',
          senha: SENHA,
        });
        const clienteId = await db.criarUsuarioAtivoComSenha(em, {
          tenant_id: tenantId,
          email: emailCli,
          nome: 'Ana Cliente',
          papel: 'cliente',
          senha: SENHA,
        });
        const c = await db.criarChamado(
          em,
          { id: clienteId, tenant_id: tenantId, papel: 'cliente' },
          {
            titulo: 'Boleto não gera segunda via',
            natureza: 'problema',
            descricao: 'Ao clicar em gerar segunda via a tela fica em branco.',
          },
        );
        if (!c.ok) throw new Error(`criarChamado: ${c.motivo}`);
        const t = await db.transicionarStatus(em, db.atorSistema(tenantId), c.id, 'em_triagem', {
          motivo: 'spike',
        });
        if (!t.ok) throw new Error(`novo→em_triagem: ${String(t.motivo)}`);
        return { chamadoId: c.id, operadorId };
      });
      await ciclo(r, { slug, emailOp, emailCli, chamadoId, operadorId });
    } finally {
      await ds.destroy();
      if (tenantId) await limpar(db, tenantId, r);
    }
  });
}

async function limpar(db: ModuloDb, tenantId: string, r: RelatorioSpike): Promise<void> {
  const admin = db.criarAdminDataSource();
  await admin.initialize();
  try {
    for (const t of ['anexo', 'chamado', 'tenant_contador', 'categoria', 'sessao', 'usuario']) {
      await admin.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
    }
    await admin.query(`DELETE FROM "tenant" WHERE id = $1`, [tenantId]);
    r.anexar('limpeza', 'tenant removido');
  } catch (e) {
    r.anexar('limpeza', `PARCIAL: ${String(e)}`);
  } finally {
    await admin.destroy();
  }
}

interface Massa {
  slug: string;
  emailOp: string;
  emailCli: string;
  chamadoId: string;
  operadorId: string;
}

async function ciclo(r: RelatorioSpike, m: Massa): Promise<void> {
  const op = new ClienteChamados({
    baseUrl: BASE,
    email: m.emailOp,
    obterSenha: () => SENHA,
    tenantSlug: m.slug,
  });
  const cli = new ClienteChamados({
    baseUrl: BASE,
    email: m.emailCli,
    obterSenha: () => SENHA,
    tenantSlug: m.slug,
  });
  const ident = await op.autenticar();
  await cli.autenticar();
  const execucaoId = randomUUID();
  const ctx: ContextoOutbox = {
    api: op,
    execucaoId,
    identidade: { usuarioId: m.operadorId, nome: ident.nome },
    papel: 'operador',
    d036: true,
  };
  const passos: Record<string, string> = {};
  const passo = async (nome: string, e: Parameters<typeof executarPasso>[1]) => {
    const res = await executarPasso(ctx, e);
    passos[nome] = resumoPasso(res);
    return res;
  };
  const ref = m.chamadoId;

  // Pré-condições (G0) + pergunta (Gdec).
  await passo('silenciar_ia', { passo: 'silenciar_ia', chamado_ref: ref });
  await passo('status_em_atendimento', { passo: 'status_em_atendimento', chamado_ref: ref });
  const emails0 = await emailsPara(m.emailCli);
  const pergunta = montarMensagemModelo('pergunta', {
    solicitanteNome: 'Ana Cliente',
    perguntas: ['A tela fica em branco em todos os boletos ou só em algum mês específico?'],
  });
  const enviadoPergunta = new Date().toISOString();
  await passo('pergunta_publica', {
    passo: 'pergunta_publica',
    chamado_ref: ref,
    corpo: pergunta,
    tipo_resposta: 'pergunta',
    enviado_em: enviadoPergunta,
  });
  await passo('status_aguardando_cliente', {
    passo: 'status_aguardando_cliente',
    chamado_ref: ref,
  });
  const emails1 = await esperarEmails(m.emailCli, (emails0 ?? 0) + 1, 60_000);

  // Polling: linha de base, lista antes da resposta.
  const det0 = await op.obterChamado(ref, { formato: 'markdown' });
  const snap0 = snapshotDoDetalhe(det0);
  const item0 = (await op.listarChamados({ limite: 50 })).itens.find((i) => i.id === ref);

  await esperar(1500);
  await cli.publicarMensagem(ref, {
    visibilidade: 'publica',
    corpo: 'Só nos boletos de **março**; os outros abrem normal.',
  });
  await esperar(1500);
  const det1 = await op.obterChamado(ref, { formato: 'markdown' });
  const item1 = (await op.listarChamados({ limite: 50 })).itens.find((i) => i.id === ref);
  const { sinais } = compararDetalhe(snap0, det1, { usuarioId: m.operadorId, nome: ident.nome });

  // Replanejar (F15).
  const replanejar = await passo('replanejar', {
    passo: 'status_em_atendimento',
    chamado_ref: ref,
    motivo: 'retomada_via_forja',
  });

  // Outbox de encerramento.
  const emails2 = await emailsPara(m.emailCli);
  const nota = [
    'Implementação local (Forja) — aprovada e integrada',
    'Branch: forja/chamado-1-segunda-via',
    'Commit: 0123456789abcdef',
    'Destino: main (merge_e_push)',
    'Nível de verificação: verificacao_estatica',
    '',
    marcadorForja(execucaoId, 'conclusao'),
  ].join('\n');
  const publica = `${montarMensagemModelo('disponivel', {
    solicitanteNome: 'Ana Cliente',
    oQueMuda:
      'a segunda via dos boletos de *março* volta a abrir — inclusive os com desconto (10% - promoção) e os de R$ 1.234,56.',
  })}\n\n- Passo 1: acesse **Boletos**\n- Passo 2: clique em _Gerar segunda via_`;
  const enviadoPublica = new Date().toISOString();
  const p1 = await passo('nota_interna', { passo: 'nota_interna', chamado_ref: ref, corpo: nota });
  const p2 = await passo('mensagem_publica', {
    passo: 'mensagem_publica',
    chamado_ref: ref,
    corpo: publica,
    tipo_resposta: 'disponivel',
    enviado_em: enviadoPublica,
  });
  const p3 = await passo('status_resolvido', { passo: 'status_resolvido', chamado_ref: ref });
  // "Crash" e reinício: os passos 1 e 2 rodam de novo a partir do estado LIDO.
  const p1b = await passo('nota_interna_reexecucao', {
    passo: 'nota_interna',
    chamado_ref: ref,
    corpo: nota,
  });
  const p2b = await passo('mensagem_publica_reexecucao', {
    passo: 'mensagem_publica',
    chamado_ref: ref,
    corpo: publica,
    tipo_resposta: 'disponivel',
    enviado_em: enviadoPublica,
  });
  const emails3 = await esperarEmails(m.emailCli, (emails2 ?? 0) + 2, 60_000);

  const det2 = await op.obterChamado(ref, { formato: 'markdown' });
  const notasComMarcador = det2.mensagens.filter(
    (x) => x.visibilidade === 'interna' && (x.corpo ?? '').includes(execucaoId),
  );
  const publicasForja = det2.mensagens.filter(
    (x: MensagemChamado) =>
      x.visibilidade === 'publica' &&
      x.autor_nome === ident.nome &&
      (x.created_at ?? '') >= enviadoPublica,
  );
  const devolvida = publicasForja[0]?.corpo ?? '';
  const exato = normalizarCorpo(devolvida) === normalizarCorpo(publica);
  const notaDevolvida = notasComMarcador[0]?.corpo ?? '';

  r.anexar('passos', passos);
  r.anexar('emails', {
    antes_pergunta: emails0,
    apos_pergunta: emails1,
    antes_outbox: emails2,
    apos_outbox: emails3,
  });
  r.anexar('lista_updated_at', {
    antes: item0?.updated_at ?? null,
    depois: item1?.updated_at ?? null,
  });
  r.anexar(
    'sinais',
    sinais.map((s) => s.tipo),
  );
  r.anexar('corpo_publica', {
    enviado: publica,
    devolvido_markdown: devolvida,
    normalizado_enviado: normalizarCorpo(publica),
    normalizado_devolvido: normalizarCorpo(devolvida),
  });
  r.anexar('nota_devolvida', notaDevolvida);

  const semWorker = emails0 !== null && emails3 !== null && emails3 === emails0;
  r.criterio(
    'S7.1',
    'a pergunta da Forja chega ao cliente: 1 e-mail no Mailpit',
    emails1 === null || semWorker ? 'PENDENTE' : vereditoDe((emails1 ?? 0) - (emails0 ?? 0) === 1),
    emails1 === null
      ? 'Mailpit fora'
      : semWorker
        ? `nenhum e-mail no ciclo inteiro (worker de notificações fora?) — ${emails0}→${emails3}`
        : `e-mails ao cliente: ${String(emails0)} → ${String(emails1)}`,
  );
  r.criterio(
    'S7.2',
    'a resposta do cliente, com a IA silenciada, leva o chamado a em_triagem (F14)',
    vereditoDe(det1.chamado.status === 'em_triagem' && det1.chamado.ia_silenciada === true),
    `status após a resposta=${det1.chamado.status}; ia_silenciada=${String(det1.chamado.ia_silenciada)}`,
  );
  r.criterio(
    'S7.3',
    'o polling detecta a mensagem nova do cliente (compararDetalhe) — e registra se o updated_at da lista muda',
    vereditoDe(sinais.some((s) => s.tipo === 'cliente_respondeu')),
    `sinais=[${sinais.map((s) => s.tipo).join(', ')}]; updated_at da lista: ${item0?.updated_at ?? '?'} → ${item1?.updated_at ?? '?'} (${item0?.updated_at === item1?.updated_at ? 'NÃO muda' : 'muda'})`,
  );
  r.criterio(
    'S7.4',
    '"Replanejar" move o chamado de em_triagem para em_atendimento (F15)',
    // `status_lido` de um passo de status que transicionou é o ALVO (o status
    // depois do passo, `transicionarAte`); o "de" é o status lido logo antes
    // (det1) e a prova da aresta é `efeitos.transicoes`.
    vereditoDe(
      det1.chamado.status === 'em_triagem' &&
        replanejar.resultado === 'enviado' &&
        !replanejar.ja_feito &&
        replanejar.status_lido === 'em_atendimento' &&
        (replanejar.efeitos.transicoes ?? []).join(',') === 'em_atendimento',
    ),
    `antes=${det1.chamado.status}; ${passos.replanejar ?? '?'}; transições=[${
      replanejar.resultado === 'enviado' ? (replanejar.efeitos.transicoes ?? []).join(', ') : ''
    }]`,
  );
  const emailsOutbox = emails3 !== null && emails2 !== null ? emails3 - emails2 : null;
  const outboxOk =
    p1.resultado === 'enviado' &&
    !p1.ja_feito &&
    p2.resultado === 'enviado' &&
    !p2.ja_feito &&
    p3.resultado === 'enviado' &&
    det2.chamado.status === 'resolvido';
  r.criterio(
    'S7.5',
    'o outbox publica nota → pública → resolvido (exatamente 2 e-mails)',
    !outboxOk
      ? 'FALHOU'
      : semWorker || emailsOutbox === null
        ? 'PENDENTE'
        : vereditoDe(emailsOutbox === 2),
    `nota=${passos.nota_interna}; pública=${passos.mensagem_publica}; resolvido=${passos.status_resolvido}; status final=${det2.chamado.status}; e-mails no outbox=${String(emailsOutbox)}${semWorker ? ' (worker fora: e-mails pendentes)' : ''}`,
  );
  r.criterio(
    'S7.6',
    're-executar os passos 1 e 2 (crash entre eles) não duplica nota nem pública',
    vereditoDe(
      p1b.resultado === 'enviado' &&
        p1b.ja_feito &&
        p2b.resultado === 'enviado' &&
        p2b.ja_feito &&
        notasComMarcador.length === 1 &&
        publicasForja.length === 1,
    ),
    `nota re-executada=${passos.nota_interna_reexecucao}; pública re-executada=${passos.mensagem_publica_reexecucao}; notas com marcador=${notasComMarcador.length}; públicas da Forja=${publicasForja.length}`,
  );
  r.criterio(
    'S7.7',
    'a duplicata casa pelo corpo NORMALIZADO inteiro devolvido em ?formato=markdown (sem o plano B dos 200 caracteres)',
    vereditoDe(exato),
    exato
      ? 'normalizarCorpo(enviado) === normalizarCorpo(devolvido)'
      : `difere — enviado="${normalizarCorpo(publica).slice(0, 160)}" devolvido="${normalizarCorpo(devolvida).slice(0, 160)}"`,
  );
  r.criterio(
    'S7.8',
    'o marcador [forja:<execucao_id>:conclusao] sobrevive à volta markdown → rich text → markdown',
    vereditoDe(
      normalizarCorpo(notaDevolvida).includes(
        normalizarCorpo(marcadorForja(execucaoId, 'conclusao')),
      ),
    ),
    `nota devolvida termina em "${notaDevolvida.slice(-80).replace(/\n/g, ' ⏎ ')}"`,
  );
}
