import { afterEach, describe, expect, it } from 'vitest';
import { ErroForja } from './nucleo';
import {
  montarAmbiente,
  roteiroFeliz,
  servicos,
  type AmbienteOrquestrador,
} from './apoio-orquestrador.test-apoio';

/**
 * FJ-031 (specs/forja/decisoes.md): a IA do servidor (triagem do Chamados) é
 * irrelevante para a Forja — quem implementa é o Claude local. Sem pré-condição
 * de `ia_silenciada`, sem `silenciar_ia`/`reativar_ia` no outbox, sinais da IA
 * do servidor só informativos; falha de sincronização da fila é erro tipado.
 */

let amb: AmbienteOrquestrador | null = null;

afterEach(async () => {
  await amb?.limpar();
  amb = null;
});

describe('FJ-031 — a IA do servidor não interfere na Forja', () => {
  it('IA ativa no chamado: implementa, nunca silencia/reativa, e os sinais não mudam o estado', async () => {
    amb = await montarAmbiente({
      config: (c) => ({ ...c, gates: { ...c.gates, plano: 'sempre' } }),
    });
    amb.chamados.chamados.get('uuid-12')!.detalhe.ia_silenciada = false;
    roteiroFeliz(amb.runner);
    const { execucao_id: id } = await amb.orq.criarExecucao({
      projeto_id: amb.projetoId,
      chamado_id: 'uuid-12',
    });
    await amb.orq.ocioso();
    let e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    // Parou no G1 (antes de implementando), onde a IA ativa antes virava precisa_humano.
    expect(e.estado).toBe('aguardando_plano');

    const passos = (await amb.banco.ler((r) => r.outbox.listar(id))).map((l) => l.passo);
    expect(passos).toContain('nota_inicio');
    expect(passos).not.toContain('silenciar_ia');
    expect(passos).not.toContain('reativar_ia');
    expect(amb.chamados.chamados.get('uuid-12')!.detalhe.ia_silenciada).toBe(false);
    expect(e.ia_silenciada_pelo_app).toBe(false);

    await amb.orq.reagirAoSinal(e, { tipo: 'ia_reativada' });
    await amb.orq.reagirAoSinal(e, {
      tipo: 'pr_ia_apareceu',
      pr: { branch: 'ia/chamado-12-x', numero_na_branch: 12, pr_url: null },
    });
    e = await amb.banco.ler((r) => r.execucoes.exigir(id));
    expect(e.estado).toBe('aguardando_plano');
    expect(e.motivo_estado).not.toBe('ia_servidor_ativa');
  });

  it('pré-condições da fila não citam a IA do servidor', async () => {
    amb = await montarAmbiente();
    amb.chamados.chamados.get('uuid-12')!.detalhe.ia_silenciada = false;
    const s = servicos(amb);
    await s.fila_sincronizar({}, { projeto_id: amb.projetoId });
    const fila = await s.fila_listar({}, { projeto_id: amb.projetoId });
    expect(fila.fonte).toBe('servidor');
    expect(fila.erro_sincronizacao).toBeNull();
    const linha = fila.itens.find((l) => l.chamado.numero === 12)!;
    expect(linha.implementavel).toBe(true);
    expect(linha.pre_condicoes.map((p) => p.codigo)).not.toContain('ia_silenciada');
  });

  it('sessão inválida: sincronizar devolve 503 tipado e a fila mostra o motivo real', async () => {
    amb = await montarAmbiente({
      orquestrador: {
        chamados: () => ({
          api: {} as never,
          identidade: () => null,
          d036: () => true,
          podeUsar: () => false,
          erro: () => ({ codigo: 'credencial_invalida', mensagem: 'O Chamados recusou a senha.' }),
          urlBase: 'https://suporte.acme.com',
        }),
      },
    });
    const s = servicos(amb);
    const erro = await s.fila_sincronizar({}, { projeto_id: amb.projetoId }).catch((x) => x);
    expect(erro).toBeInstanceOf(ErroForja);
    expect(erro).toMatchObject({ codigo: 'chamados_indisponivel', status: 503 });
    expect((erro as Error).message).toContain('O Chamados recusou a senha.');
    const fila = await s.fila_listar({}, { projeto_id: amb.projetoId });
    expect(fila.fonte).toBe('cache');
    expect(fila.erro_sincronizacao).toEqual({
      codigo: 'credencial_invalida',
      mensagem: 'O Chamados recusou a senha.',
    });
  });

  it('erro de rede na consulta: 503 tipado; o erro fica até a próxima sincronização boa', async () => {
    let falhar = true;
    // A fábrica é chamada sob demanda: `amb` já existe quando a fachada pede a fonte.
    amb = await montarAmbiente({
      orquestrador: {
        chamados: () => ({
          api: new Proxy(amb!.chamados.cliente(), {
            get: (alvo, chave, rec) =>
              chave === 'listarTodosChamados' && falhar
                ? () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:3000'))
                : Reflect.get(alvo, chave, rec),
          }),
          identidade: () => null,
          d036: () => true,
          podeUsar: () => true,
          urlBase: 'https://suporte.acme.com',
        }),
      },
    });
    const s = servicos(amb);
    await expect(s.fila_sincronizar({}, { projeto_id: amb.projetoId })).rejects.toMatchObject({
      codigo: 'chamados_indisponivel',
      status: 503,
      message: expect.stringContaining('ECONNREFUSED'),
    });
    let fila = await s.fila_listar({}, { projeto_id: amb.projetoId });
    expect(fila.fonte).toBe('cache');
    expect(fila.erro_sincronizacao?.mensagem).toContain('ECONNREFUSED');
    falhar = false;
    await expect(s.fila_sincronizar({}, { projeto_id: amb.projetoId })).resolves.toMatchObject({
      fonte: 'servidor',
    });
    fila = await s.fila_listar({}, { projeto_id: amb.projetoId });
    expect(fila).toMatchObject({ fonte: 'servidor', erro_sincronizacao: null });
  });
});
