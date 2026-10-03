import { describe, expect, it } from 'vitest';
import type { AcaoExecucao, DecisaoNecessariaDto, ExecucaoDto } from '@comum/dto';
import type { EstadoExecucao } from '@comum/estados';
import {
  acoesAprovacao,
  botoesDecisao,
  execucaoEncerrada,
  modoConversa,
  mostraCartaoDecisao,
  pausarEEnviar,
} from './acoes-execucao';

const decisao: DecisaoNecessariaDto = {
  perguntas: [
    { pergunta: 'Aceitar +tag?', por_que_importa: 'muda a validação', suposicao_padrao: 'sim' },
  ],
  decisoes: [],
  rascunho_pergunta: null,
  pergunta_publicada_em: '2026-10-01T10:00:00.000Z',
  // O servidor ainda manda null mesmo com a resposta detectada: a UI não depende disto.
  resposta_cliente: null,
};

type Parcial = Pick<
  ExecucaoDto,
  'estado' | 'acoes' | 'decisao' | 'grupo' | 'conversa_bloqueada' | 'sessao_assumida'
>;
function ex(estado: EstadoExecucao, acoes: AcaoExecucao[], extra: Partial<Parcial> = {}): Parcial {
  return {
    estado,
    acoes,
    decisao,
    grupo: 'trabalhando',
    conversa_bloqueada: null,
    sessao_assumida: null,
    ...extra,
  };
}

describe('acoes → botões (06 §4.2, §5.3)', () => {
  it('aguardando o cliente: o cartão continua e [Replanejar] aparece quando o servidor oferece', () => {
    const aguardando = ex('aguardando_cliente_resposta', ['descartar']);
    expect(mostraCartaoDecisao(aguardando)).toBe(true);
    expect(botoesDecisao(aguardando)).toEqual({
      perguntar: false,
      decidir: false,
      replanejar: false,
      descartar: true,
    });
    const respondeu = ex('aguardando_cliente_resposta', ['replanejar', 'descartar']);
    expect(botoesDecisao(respondeu).replanejar).toBe(true);
  });

  it('Gdec: perguntar só com perguntas, e só com `decidir` em acoes', () => {
    const gdec = ex('aguardando_decisao', ['decidir', 'descartar', 'encerrar']);
    expect(mostraCartaoDecisao(gdec)).toBe(true);
    expect(botoesDecisao(gdec)).toMatchObject({
      perguntar: true,
      decidir: true,
      replanejar: false,
    });
    expect(botoesDecisao({ ...gdec, decisao: { ...decisao, perguntas: [] } }).perguntar).toBe(
      false,
    );
    expect(botoesDecisao({ ...gdec, acoes: [] })).toEqual({
      perguntar: false,
      decidir: false,
      replanejar: false,
      descartar: false,
    });
    expect(mostraCartaoDecisao(ex('implementando', ['pausar']))).toBe(false);
    expect(mostraCartaoDecisao({ ...gdec, decisao: null })).toBe(false);
  });

  it('Aprovação: ações só as oferecidas; fora de aguardando_aprovacao, leitura', () => {
    expect(
      acoesAprovacao(
        ex('aguardando_aprovacao', ['abrir_aprovacao', 'recapturar_prints', 'descartar']),
      ),
    ).toEqual({
      aguardando: true,
      aprovar: true,
      pedirAjustes: true,
      assumir: false,
      descartar: true,
      recapturar: true,
    });
    const contradiz = acoesAprovacao(ex('precisa_humano', ['mais_um_ciclo', 'descartar']));
    expect(contradiz).toMatchObject({ aguardando: false, aprovar: false, pedirAjustes: false });
    expect(acoesAprovacao(ex('mergeado', []))).toMatchObject({
      aguardando: false,
      aprovar: false,
      descartar: false,
    });
    // carregando: nada acionável, sem a faixa de leitura
    expect(acoesAprovacao(undefined)).toMatchObject({ aguardando: true, aprovar: false });
  });

  it('modo leitura só nos terminais', () => {
    expect(execucaoEncerrada('concluido')).toBe(true);
    expect(execucaoEncerrada('descartado')).toBe(true);
    expect(execucaoEncerrada('cancelado')).toBe(true);
    expect(execucaoEncerrada('mergeado')).toBe(false);
    expect(execucaoEncerrada('precisa_humano')).toBe(false);
  });
});

describe('Conversa: "Pausar e enviar" (06 §4.2)', () => {
  it('etapa rodando com pausar: campo liberado apesar do bloqueio genérico do servidor', () => {
    expect(
      modoConversa(
        ex('implementando', ['pausar', 'parar'], {
          conversa_bloqueada: 'pause a execução para conversar',
        }),
      ),
    ).toEqual({ tipo: 'pausar_e_enviar' });
    expect(
      modoConversa(ex('pausado_usuario', ['retomar', 'conversar'], { grupo: 'pausado' })),
    ).toEqual({ tipo: 'enviar' });
  });

  it('sessão assumida no terminal bloqueia sempre; sem ação, bloqueia com o motivo', () => {
    expect(
      modoConversa(
        ex('assumido_manual', ['devolver'], {
          grupo: 'com_voce',
          sessao_assumida: { sessao_terminal_id: 't1' },
          conversa_bloqueada: 'a sessão está assumida no terminal',
        }),
      ),
    ).toEqual({ tipo: 'bloqueada', motivo: 'a sessão está assumida no terminal' });
    expect(
      modoConversa(ex('aguardando_aprovacao', ['abrir_aprovacao'], { grupo: 'aguardando_voce' }))
        .tipo,
    ).toBe('bloqueada');
  });

  it('pausa, espera pausado_usuario e só então envia', async () => {
    const chamadas: string[] = [];
    const estados: EstadoExecucao[] = ['verificando', 'pausado_usuario'];
    await pausarEEnviar(
      {
        pausar: async () => {
          chamadas.push('pausar');
          return { estado: 'verificando' };
        },
        estadoAtual: async () => {
          chamadas.push('obter');
          return estados.shift() as EstadoExecucao;
        },
        conversar: async () => {
          chamadas.push('conversar');
        },
        esperar: async () => undefined,
      },
      { intervaloMs: 1, prazoMs: 10 },
    );
    expect(chamadas).toEqual(['pausar', 'obter', 'obter', 'conversar']);
  });

  it('sessão ocupada (409) logo após a pausa: tenta de novo; outro erro sobe', async () => {
    let n = 0;
    await pausarEEnviar(
      {
        pausar: async () => ({ estado: 'pausado_usuario' }),
        estadoAtual: async () => 'pausado_usuario',
        conversar: async () => {
          n += 1;
          if (n < 3) throw Object.assign(new Error('a sessão está ocupada'), { status: 409 });
        },
        esperar: async () => undefined,
      },
      { intervaloMs: 1, prazoMs: 10 },
    );
    expect(n).toBe(3);

    await expect(
      pausarEEnviar(
        {
          pausar: async () => ({ estado: 'pausado_usuario' }),
          estadoAtual: async () => 'pausado_usuario',
          conversar: async () => {
            throw Object.assign(new Error('mensagem vazia'), { status: 400 });
          },
          esperar: async () => undefined,
        },
        { intervaloMs: 1, prazoMs: 10 },
      ),
    ).rejects.toThrow('mensagem vazia');
  });

  it('não pausou a tempo: não envia', async () => {
    let enviou = false;
    await expect(
      pausarEEnviar(
        {
          pausar: async () => ({ estado: 'integrando' }),
          estadoAtual: async () => 'integrando',
          conversar: async () => {
            enviou = true;
          },
          esperar: async () => undefined,
        },
        { intervaloMs: 1, prazoMs: 3 },
      ),
    ).rejects.toThrow(/não pausou/);
    expect(enviou).toBe(false);
  });
});
