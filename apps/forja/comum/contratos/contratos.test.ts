import { describe, expect, it } from 'vitest';
import {
  CONTRATOS,
  PlanoV1,
  RelatorioRegistrado,
  RelatorioV1,
  RespostaV1,
  ResumoImplV1,
  VereditoV1,
  paraJsonSchema,
  validarContrato,
  type NomeContrato,
} from './index';

/**
 * Exemplos válidos/inválidos de cada contrato (specs/forja/04 §5, §11) e a
 * conversão para JSON Schema que vai no `--json-schema` do turno.
 */

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const respostaValida = {
  versao: 1,
  tipo: 'aguardando_publicacao',
  corpo_markdown:
    'Olá! O cadastro agora avisa quando o e-mail está em formato inválido. A mudança será publicada na próxima atualização.',
  cita_prazo: false,
} as const;

const planoValido = {
  versao: 1,
  entendimento: 'O cliente quer que o cadastro recuse e-mails em formato inválido.',
  natureza_confirmada: 'alteracao',
  motivo_nao_implementavel: null,
  confianca: 'alta',
  justificativa_confianca: 'A validação fica num único serviço e há testes cobrindo.',
  evidencias: ['servicos/clientes.ts:42'],
  perguntas_ao_cliente: [],
  decisoes_do_operador: [],
  criterios_de_aceite: [
    { id: 'CA1', descricao: 'E-mail sem @ é recusado com aviso.', verificacao: 'unit' },
  ],
  passos: [
    {
      id: 'P1',
      descricao: 'Validar o formato do e-mail no serviço de clientes.',
      arquivos_previstos: ['servicos/clientes.ts'],
      depende_de: [],
    },
  ],
  arquivos_previstos: ['servicos/clientes.ts'],
  areas: ['regra_negocio', 'ui'],
  telas_afetadas: [
    {
      id: 'UI1',
      descricao: 'Cadastro de cliente com e-mail inválido',
      rota: '/clientes/novo',
      passos: [
        { acao: 'preencher', alvo: 'label=E-mail', valor: 'maria@' },
        { acao: 'clicar', alvo: 'text=Salvar' },
      ],
      estado_esperado: 'Aparece o aviso abaixo do campo de e-mail.',
    },
  ],
  regras_de_negocio: [
    { regra: 'Formato do e-mail', antes: 'Qualquer texto.', depois: 'nome@dominio.' },
  ],
  schema_banco: { altera: false, mudancas: [] },
  dependencias_previstas: [],
  plano_de_testes: { unit: ['rejeita e-mail sem @'], e2e: [] },
  riscos: [{ descricao: 'Cadastros antigos inválidos.', severidade: 'baixa' }],
  fora_de_escopo: ['Confirmação de e-mail por envio.'],
  trabalho_existente: {
    pr_ia_detectado: false,
    recomendacao: 'nao_se_aplica',
    motivo: 'Não há PR da IA do servidor.',
  },
  alertas_seguranca: [],
};

const resumoValido = {
  versao: 1,
  ciclo: 1,
  passos: [
    {
      id: 'P1',
      status: 'concluido',
      executor: 'implementador',
      arquivos_alterados: ['servicos/clientes.ts'],
      comandos: [{ comando: 'npm run typecheck', exit_code: 0 }],
      observacao: 'Validação adicionada com regex simples.',
    },
  ],
  desvios_do_plano: [],
  dependencias_adicionadas: [],
  telas_afetadas: [],
  achados_tratados: [],
  bloqueios: [],
  resumo_tecnico: 'Adicionada validação de formato em servicos/clientes.ts.',
};

const vereditoValido = {
  versao: 1,
  ciclo: 1,
  sha_avaliado: SHA,
  revisores: ['revisor_correcao', 'revisor_seguranca'],
  decisao: 'aprovado',
  recomendacao: 'seguir',
  motivo_recomendacao: 'Critérios atendidos, sem achados bloqueantes.',
  achados: [
    {
      id: 'A1',
      revisor: 'revisor_correcao',
      severidade: 'sugestao',
      categoria: 'manutencao',
      arquivo: 'servicos/clientes.ts',
      linha: 42,
      descricao: 'Regex poderia ir para uma constante.',
      sugestao: 'Extrair para EMAIL_REGEX.',
    },
  ],
  criterios: [
    { id: 'CA1', status: 'atendido', evidencia: 'Teste unitário verde.', evidencia_ref: null },
  ],
  falhas_de_verificacao: [],
  fora_do_plano: [],
  alteracoes_sensiveis: [],
  comandos_executados: [{ comando: 'npm test', exit_code: 0, resumo: '42 testes passaram' }],
  instrucoes_para_retrabalho: '',
};

const relatorioValido = {
  versao: 1,
  titulo: 'Validar e-mail no cadastro',
  resumo: 'O cadastro passa a recusar e-mail em formato inválido, com aviso na tela.',
  o_que_muda_para_quem_usa: ['Ao salvar um e-mail inválido aparece um aviso.'],
  regras_de_negocio_alteradas: {
    houve: true,
    itens: [
      {
        regra: 'Formato do e-mail',
        antes: 'Qualquer texto era aceito.',
        depois: 'Formato nome@dominio.',
        quem_e_afetado: 'Atendentes no cadastro.',
      },
    ],
    declaracao: 'Uma regra mudou.',
  },
  alteracoes_no_schema_do_banco: {
    houve: false,
    itens: [],
    declaracao: 'Nenhuma alteração no banco de dados.',
    exige_migracao_no_deploy: false,
  },
  alteracoes_de_interface: {
    houve: true,
    telas: [{ tela_id: 'UI1', o_que_mudou_para_quem_usa: 'Aviso abaixo do e-mail.' }],
    declaracao: 'Uma tela mudou.',
  },
  como_foi_testado: {
    cenarios: [{ criterio: 'CA1', resultado: 'ok', evidencia_ref: `log:unit@${SHA.slice(0, 8)}` }],
  },
  como_testar_manualmente: ['Clientes › Novo, digite "maria@" e salve.'],
  riscos_e_o_que_observar: [],
  o_que_nao_foi_feito: ['Confirmação de e-mail por envio.'],
  dependencias_novas: [],
  mudou_desde_a_ultima_versao: null,
  resposta_ao_cliente: respostaValida,
};

const VALIDOS: Record<NomeContrato, unknown> = {
  'plano.v1': planoValido,
  'resumo_impl.v1': resumoValido,
  'veredito.v1': vereditoValido,
  'relatorio.v1': relatorioValido,
  'resposta.v1': respostaValida,
};

describe('contratos zod (04 §5)', () => {
  it.each(Object.keys(VALIDOS) as NomeContrato[])('%s aceita um exemplo válido', (nome) => {
    const r = validarContrato(nome, VALIDOS[nome]);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('plano.v1 recusa versão diferente de 1 e confiança fora do enum', () => {
    expect(PlanoV1.safeParse({ ...planoValido, versao: 2 }).success).toBe(false);
    expect(PlanoV1.safeParse({ ...planoValido, confianca: 'total' }).success).toBe(false);
  });

  it('plano.v1 recusa id de passo/CA/tela fora do padrão e rota absoluta com host', () => {
    expect(
      PlanoV1.safeParse({
        ...planoValido,
        passos: [{ ...planoValido.passos[0], id: 'passo1' }],
      }).success,
    ).toBe(false);
    expect(
      PlanoV1.safeParse({
        ...planoValido,
        criterios_de_aceite: [{ id: 'C1', descricao: 'x', verificacao: 'unit' }],
      }).success,
    ).toBe(false);
    expect(
      PlanoV1.safeParse({
        ...planoValido,
        telas_afetadas: [{ ...planoValido.telas_afetadas[0], rota: 'https://evil.com/x' }],
      }).success,
    ).toBe(false);
  });

  it('plano.v1 recusa texto vazio ou só espaços (Texto = trim + min 1)', () => {
    expect(PlanoV1.safeParse({ ...planoValido, entendimento: '   ' }).success).toBe(false);
  });

  it('plano.v1 recusa decisão do operador com menos de 2 opções e mais de 5 perguntas', () => {
    expect(
      PlanoV1.safeParse({
        ...planoValido,
        decisoes_do_operador: [{ questao: 'q', opcoes: ['só uma'], recomendacao: 'r' }],
      }).success,
    ).toBe(false);
    const pergunta = { pergunta: 'p', por_que_importa: 'i', suposicao_padrao: 's' };
    expect(
      PlanoV1.safeParse({ ...planoValido, perguntas_ao_cliente: Array(6).fill(pergunta) }).success,
    ).toBe(false);
  });

  it('FJ-033: `suposicoes`/`suposicoes_assumidas` têm default [] (artefatos antigos validam)', () => {
    const { suposicoes: _s, ...planoAntigo } = planoValido as typeof planoValido & {
      suposicoes?: string[];
    };
    const p = PlanoV1.safeParse(planoAntigo);
    expect(p.success).toBe(true);
    expect(p.data?.suposicoes).toEqual([]);
    const { suposicoes_assumidas: _r, ...relatorioAntigo } =
      relatorioValido as typeof relatorioValido & {
        suposicoes_assumidas?: string[];
      };
    const r = RelatorioV1.safeParse(relatorioAntigo);
    expect(r.success).toBe(true);
    expect(r.data?.suposicoes_assumidas).toEqual([]);
    expect(
      PlanoV1.safeParse({ ...planoValido, suposicoes: Array(16).fill('uma suposição') }).success,
    ).toBe(false);
    expect(
      PlanoV1.safeParse({ ...planoValido, suposicoes: ['o total é do mês corrente'] }).data
        ?.suposicoes,
    ).toEqual(['o total é do mês corrente']);
  });

  it('resumo_impl.v1 exige ao menos 1 passo e bloqueio com motivo conhecido', () => {
    expect(ResumoImplV1.safeParse({ ...resumoValido, passos: [] }).success).toBe(false);
    expect(
      ResumoImplV1.safeParse({
        ...resumoValido,
        bloqueios: [{ descricao: 'x', precisa: 'cafe' }],
      }).success,
    ).toBe(false);
  });

  it('veredito.v1 exige sha de 40 hex e ao menos 1 revisor', () => {
    expect(VereditoV1.safeParse({ ...vereditoValido, sha_avaliado: 'abc' }).success).toBe(false);
    expect(VereditoV1.safeParse({ ...vereditoValido, revisores: [] }).success).toBe(false);
    expect(
      VereditoV1.safeParse({
        ...vereditoValido,
        achados: [{ ...vereditoValido.achados[0], linha: 0 }],
      }).success,
    ).toBe(false);
    // FJ-032: `comandos_executados` é obrigatório (pode ser vazio).
    const { comandos_executados: _c, ...semComandos } = vereditoValido;
    expect(VereditoV1.safeParse(semComandos).success).toBe(false);
    expect(VereditoV1.safeParse({ ...vereditoValido, comandos_executados: [] }).success).toBe(true);
  });

  it('relatorio.v1 exige o_que_muda e como_testar não vazios e exige_migracao_no_deploy', () => {
    expect(
      RelatorioV1.safeParse({ ...relatorioValido, o_que_muda_para_quem_usa: [] }).success,
    ).toBe(false);
    expect(RelatorioV1.safeParse({ ...relatorioValido, como_testar_manualmente: [] }).success).toBe(
      false,
    );
    const { exige_migracao_no_deploy: _omitido, ...schemaSemCampo } =
      relatorioValido.alteracoes_no_schema_do_banco;
    expect(
      RelatorioV1.safeParse({ ...relatorioValido, alteracoes_no_schema_do_banco: schemaSemCampo })
        .success,
    ).toBe(false);
  });

  it('resposta.v1 recusa corpo acima de 1200 caracteres e tipo desconhecido', () => {
    expect(
      RespostaV1.safeParse({ ...respostaValida, corpo_markdown: 'x'.repeat(1201) }).success,
    ).toBe(false);
    expect(RespostaV1.safeParse({ ...respostaValida, tipo: 'resolvido' }).success).toBe(false);
  });

  it('relatório registrado (⚙) exige os campos do app além do contrato do modelo', () => {
    expect(RelatorioRegistrado.safeParse(relatorioValido).success).toBe(false);
    const registrado = {
      ...relatorioValido,
      alteracoes_de_interface: {
        ...relatorioValido.alteracoes_de_interface,
        telas: [
          {
            tela_id: 'UI1',
            o_que_mudou_para_quem_usa: 'Aviso abaixo do e-mail.',
            antes_ref: 'artefato:1',
            depois_ref: 'artefato:2',
            rota: '/clientes/novo',
          },
        ],
      },
      selos: {
        altera_banco: false,
        altera_regra_negocio: true,
        altera_ui: true,
        sensivel: [],
        docs_exigidas_ok: null,
      },
      nivel_verificacao: 'verificacao_estatica',
      ciclos: 1,
      custo_equivalente_usd: 1.2,
      arquivos: 1,
      linhas: { adicoes: 10, remocoes: 2 },
      sha: SHA,
      patch_id: 'f'.repeat(40),
      sensiveis: [],
      achados_em_aberto: [],
      condutor_editou: false,
      incoerencias: [],
      regenerado: false,
      evidencia_visual: 'completa',
      evidencia_visual_motivo: null,
    };
    expect(RelatorioRegistrado.safeParse(registrado).success).toBe(true);
  });
});

describe('paraJsonSchema (z.toJSONSchema → --json-schema)', () => {
  it.each(Object.keys(CONTRATOS) as NomeContrato[])(
    '%s gera um objeto com todas as chaves obrigatórias',
    (nome) => {
      const schema = paraJsonSchema(nome);
      expect(schema.type).toBe('object');
      const chaves = Object.keys(CONTRATOS[nome].shape);
      expect(schema.required).toEqual(expect.arrayContaining(chaves));
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    },
  );

  it('nunca emite `$schema`, em nenhum alvo (a CLI 2.1.288 rejeita o 2020-12)', () => {
    expect(paraJsonSchema('plano.v1').$schema).toBeUndefined();
    expect(paraJsonSchema('plano.v1', { alvo: 'draft-2020-12' }).$schema).toBeUndefined();
  });

  it('preserva padrões e limites (pattern, maxItems) no schema enviado à CLI', () => {
    const texto = JSON.stringify(paraJsonSchema('veredito.v1'));
    expect(texto).toContain('^[0-9a-f]{40}$');
    expect(JSON.stringify(paraJsonSchema('plano.v1'))).toContain('"maxItems":12');
  });
});

describe('paraJsonSchema — compatível com o validador da CLI (incidente 2026-10-03)', () => {
  it('não emite `$schema` e usa draft-7 por padrão', () => {
    const gerado = paraJsonSchema('plano.v1');
    expect(gerado.$schema).toBeUndefined();
    expect(JSON.stringify(gerado)).not.toContain('json-schema.org/draft/2020-12');
    expect(gerado.type).toBe('object');
  });
});
