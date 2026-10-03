import { z } from 'zod';
import { IdCA, IdTela, Texto, TipoMudanca } from './base';
import { RespostaV1 } from './resposta';

/**
 * `relatorio.v1` — o relatório não técnico do T3 (specs/forja/04 §5), o
 * artefato central da aprovação (F-12: "o relatório é o produto"). Regras de
 * negócio, schema do banco e interface são seções OBRIGATÓRIAS: com `houve:
 * false` a `declaracao` explica o porquê, nunca fica em branco. Os campos ⚙
 * (selos, nível, refs dos prints) são do app e entram em `RelatorioRegistrado`.
 */

/** Seção obrigatória genérica: `{ houve, itens, declaracao }`. */
export const SecaoObrigatoria = <T extends z.ZodType>(item: T) =>
  z.object({ houve: z.boolean(), itens: z.array(item), declaracao: Texto(300) });

export const TelaInterfaceV1 = z.object({ tela_id: IdTela, o_que_mudou_para_quem_usa: Texto(300) });

/** FJ-026, obrigatória; `antes_ref`/`depois_ref` são ⚙ (o app preenche a partir dos artefatos `evidencia`). */
export const AlteracoesInterfaceV1 = z.object({
  houve: z.boolean(),
  telas: z.array(TelaInterfaceV1),
  declaracao: Texto(300),
});

export const RelatorioV1 = z.object({
  versao: z.literal(1),
  titulo: Texto(120),
  /** ≤ 3 frases, linguagem de negócio. */
  resumo: Texto(600),
  o_que_muda_para_quem_usa: z.array(Texto(300)).min(1),
  /**
   * FJ-033: as `suposicoes` do plano, em linguagem simples, para o humano
   * conferir antes de aprovar. Vazio com suposições no plano ⇒ o app copia.
   */
  suposicoes_assumidas: z.array(Texto(700)).max(15).default([]),
  regras_de_negocio_alteradas: SecaoObrigatoria(
    z.object({
      regra: Texto(300),
      antes: Texto(300),
      depois: Texto(300),
      quem_e_afetado: Texto(200),
    }),
  ),
  alteracoes_no_schema_do_banco: SecaoObrigatoria(
    z.object({
      em_linguagem_simples: Texto(300),
      objeto_tecnico: Texto(120),
      tipo: TipoMudanca,
      afeta_dados_existentes: z.boolean(),
      reversivel: z.boolean(),
    }),
  ).extend({ exige_migracao_no_deploy: z.boolean() }),
  alteracoes_de_interface: AlteracoesInterfaceV1,
  como_foi_testado: z.object({
    cenarios: z.array(
      z.object({
        criterio: IdCA,
        resultado: z.enum(['ok', 'falhou', 'nao_testado']),
        evidencia_ref: z.string().nullable(),
      }),
    ),
  }),
  como_testar_manualmente: z.array(Texto(300)).min(1),
  riscos_e_o_que_observar: z.array(Texto(300)),
  o_que_nao_foi_feito: z.array(Texto(300)),
  dependencias_novas: z.array(Texto(200)),
  mudou_desde_a_ultima_versao: z.array(Texto(300)).nullable(),
  resposta_ao_cliente: RespostaV1,
});
export type RelatorioV1 = z.infer<typeof RelatorioV1>;
