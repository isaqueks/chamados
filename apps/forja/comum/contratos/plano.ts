import { z } from 'zod';
import { Area, Caminho, IdCA, IdPasso, TelaAfetada, Texto, TipoMudanca } from './base';

/**
 * `plano.v1` — saída do `planejador` (Fable, somente leitura, specs/forja/04 §5).
 * É o único contrato produzido por quem lê o texto do cliente; tudo o que o
 * condutor recebe depois sai daqui, já aprovado (F-03). Transcrição literal da
 * spec; as regras entre campos (CA ≥ 1, grafo acíclico, `ui` ⇔ telas…) estão em
 * 04 §6 e são aplicadas em código pelo servidor.
 */
export const PlanoV1 = z.object({
  versao: z.literal(1),
  /** 2–4 frases, sem jargão: "o cliente quer…". */
  entendimento: Texto(800),
  natureza_confirmada: z.enum(['problema', 'alteracao', 'nao_implementavel']),
  motivo_nao_implementavel: Texto(600).nullable(),
  confianca: z.enum(['alta', 'media', 'baixa']),
  justificativa_confianca: Texto(600),
  /** "arquivo:linha" investigados. */
  evidencias: z.array(Texto(200)).max(20),
  /**
   * FJ-033: escolhas que o planejador fez sozinho, uma frase cada, em linguagem
   * de quem usa. O app acrescenta aqui as perguntas/decisões que assumiu
   * (`assumirDecisoes`). `.default([])`: artefatos anteriores continuam válidos.
   */
  suposicoes: z.array(Texto(700)).max(15).default([]),
  /** FJ-033: só o que não dá para seguir sem (dano difícil de desfazer). */
  perguntas_ao_cliente: z
    .array(
      z.object({
        pergunta: Texto(300),
        por_que_importa: Texto(300),
        suposicao_padrao: Texto(300),
      }),
    )
    .max(5),
  /** FJ-033: só escolha de produto que o operador PRECISA fazer. */
  decisoes_do_operador: z
    .array(
      z.object({
        questao: Texto(300),
        opcoes: z.array(Texto(200)).min(2).max(5),
        recomendacao: Texto(300),
      }),
    )
    .max(5),
  criterios_de_aceite: z
    .array(
      z.object({
        id: IdCA,
        descricao: Texto(400),
        verificacao: z.enum(['unit', 'e2e', 'manual']),
      }),
    )
    .max(15),
  passos: z
    .array(
      z.object({
        id: IdPasso,
        descricao: Texto(600),
        arquivos_previstos: z.array(Caminho).min(1),
        depende_de: z.array(IdPasso),
      }),
    )
    .max(12),
  arquivos_previstos: z.array(Caminho),
  areas: z.array(Area),
  /** FJ-026; vazio se não muda a interface. */
  telas_afetadas: z.array(TelaAfetada).max(10),
  regras_de_negocio: z.array(
    z.object({ regra: Texto(300), antes: Texto(300), depois: Texto(300) }),
  ),
  schema_banco: z.object({
    altera: z.boolean(),
    mudancas: z.array(
      z.object({
        tipo: TipoMudanca,
        objeto: Texto(120),
        descricao: Texto(300),
        reversivel: z.boolean(),
      }),
    ),
  }),
  dependencias_previstas: z.array(z.object({ pacote: Texto(120), motivo: Texto(300) })),
  plano_de_testes: z.object({
    unit: z.array(Texto(300)),
    e2e: z.array(z.object({ criterio_id: IdCA, roteiro: z.array(Texto(300)) })),
  }),
  riscos: z.array(
    z.object({ descricao: Texto(300), severidade: z.enum(['baixa', 'media', 'alta']) }),
  ),
  fora_de_escopo: z.array(Texto(300)),
  trabalho_existente: z.object({
    pr_ia_detectado: z.boolean(),
    recomendacao: z.enum(['aproveitar', 'ignorar', 'nao_se_aplica']),
    motivo: Texto(300),
  }),
  alertas_seguranca: z.array(Texto(300)).max(10),
});
export type PlanoV1 = z.infer<typeof PlanoV1>;
