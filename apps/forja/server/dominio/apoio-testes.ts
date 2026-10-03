import type { PlanoV1, RelatorioV1, ResumoImplV1, VereditoV1 } from '../../comum/contratos';

/**
 * Fábricas de contratos válidos para os testes do domínio (usadas só por
 * `*.test.ts`). Cada uma devolve o caso "feliz" mínimo; o teste sobrescreve
 * só o campo que exercita.
 */

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);

export function planoFalso(p: Partial<PlanoV1> = {}): PlanoV1 {
  return {
    versao: 1,
    entendimento: 'O cliente quer que o relatório abra rápido.',
    natureza_confirmada: 'problema',
    motivo_nao_implementavel: null,
    confianca: 'alta',
    justificativa_confianca: 'Causa localizada.',
    evidencias: ['servicos/relatorio.ts:10'],
    suposicoes: [],
    perguntas_ao_cliente: [],
    decisoes_do_operador: [],
    criterios_de_aceite: [{ id: 'CA1', descricao: 'abre em menos de 3 s', verificacao: 'unit' }],
    passos: [
      {
        id: 'P1',
        descricao: 'paginar a consulta',
        arquivos_previstos: ['servicos/relatorio.ts'],
        depende_de: [],
      },
    ],
    arquivos_previstos: ['servicos/relatorio.ts'],
    areas: ['regra_negocio'],
    telas_afetadas: [],
    regras_de_negocio: [],
    schema_banco: { altera: false, mudancas: [] },
    dependencias_previstas: [],
    plano_de_testes: { unit: ['paginação'], e2e: [] },
    riscos: [],
    fora_de_escopo: [],
    trabalho_existente: { pr_ia_detectado: false, recomendacao: 'nao_se_aplica', motivo: 'nenhum' },
    alertas_seguranca: [],
    ...p,
  };
}

export function resumoFalso(p: Partial<ResumoImplV1> = {}): ResumoImplV1 {
  return {
    versao: 1,
    ciclo: 1,
    passos: [
      {
        id: 'P1',
        status: 'concluido',
        executor: 'implementador',
        arquivos_alterados: ['servicos/relatorio.ts'],
        comandos: [],
        observacao: 'feito',
      },
    ],
    desvios_do_plano: [],
    dependencias_adicionadas: [],
    telas_afetadas: [],
    achados_tratados: [],
    bloqueios: [],
    resumo_tecnico: 'Paginação por cursor.',
    ...p,
  };
}

type Achado = VereditoV1['achados'][number];

export function achadoFalso(p: Partial<Achado> = {}): Achado {
  return {
    id: 'A1',
    revisor: 'revisor_correcao',
    severidade: 'bloqueante',
    categoria: 'correcao',
    arquivo: 'servicos/relatorio.ts',
    linha: 10,
    descricao: 'a paginação ignora o último registro da página',
    sugestao: 'usar <= no limite',
    ...p,
  };
}

export function vereditoFalso(p: Partial<VereditoV1> = {}): VereditoV1 {
  return {
    versao: 1,
    ciclo: 1,
    sha_avaliado: SHA_A,
    revisores: ['revisor_correcao'],
    decisao: 'aprovado',
    recomendacao: 'seguir',
    motivo_recomendacao: 'ok',
    achados: [],
    criterios: [
      {
        id: 'CA1',
        status: 'atendido',
        evidencia: 'teste passa',
        evidencia_ref: null,
      },
    ],
    falhas_de_verificacao: [],
    fora_do_plano: [],
    alteracoes_sensiveis: [],
    comandos_executados: [],
    instrucoes_para_retrabalho: '',
    ...p,
  };
}

export function relatorioFalso(p: Partial<RelatorioV1> = {}): RelatorioV1 {
  return {
    versao: 1,
    titulo: 'Relatório mais rápido',
    resumo: 'O relatório passa a abrir em poucos segundos.',
    o_que_muda_para_quem_usa: ['O relatório abre mais rápido.'],
    suposicoes_assumidas: [],
    regras_de_negocio_alteradas: {
      houve: false,
      itens: [],
      declaracao: 'Nenhuma regra de negócio mudou.',
    },
    alteracoes_no_schema_do_banco: {
      houve: false,
      itens: [],
      declaracao: 'Nenhuma alteração no banco de dados.',
      exige_migracao_no_deploy: false,
    },
    alteracoes_de_interface: {
      houve: false,
      telas: [],
      declaracao: 'Nenhuma tela mudou.',
    },
    como_foi_testado: {
      cenarios: [{ criterio: 'CA1', resultado: 'ok', evidencia_ref: 'log:unit@aaaaaaaa' }],
    },
    como_testar_manualmente: ['Abra o relatório.'],
    riscos_e_o_que_observar: [],
    o_que_nao_foi_feito: [],
    dependencias_novas: [],
    mudou_desde_a_ultima_versao: null,
    resposta_ao_cliente: {
      versao: 1,
      tipo: 'aguardando_publicacao',
      corpo_markdown: 'Olá! Ajustamos o relatório; avisaremos quando estiver publicado.',
      cita_prazo: false,
    },
    ...p,
  };
}
