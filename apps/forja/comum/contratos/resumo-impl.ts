import { z } from 'zod';
import { Caminho, IdPasso, TelaAfetada, Texto } from './base';

/**
 * `resumo_impl.v1` — saída do condutor no turno T1 (specs/forja/04 §5). O que
 * o modelo DECLARA ter feito; o app confronta com o git (`arquivos_reais`) e
 * vale o git (04 §6). `resumo_tecnico` vai para a nota interna, nunca ao cliente.
 */
export const ResumoImplV1 = z.object({
  versao: z.literal(1),
  ciclo: z.number().int().min(1),
  passos: z
    .array(
      z.object({
        id: IdPasso,
        status: z.enum(['concluido', 'parcial', 'nao_feito', 'bloqueado']),
        executor: z.enum(['implementador', 'condutor']),
        arquivos_alterados: z.array(Caminho),
        comandos: z.array(z.object({ comando: Texto(200), exit_code: z.number().int() })),
        observacao: Texto(600),
      }),
    )
    .min(1),
  desvios_do_plano: z.array(z.object({ arquivo: Caminho, motivo: Texto(300) })),
  dependencias_adicionadas: z.array(Texto(120)),
  /** FJ-026: só telas fora de `plano.telas_afetadas` (novas ou não previstas). */
  telas_afetadas: z.array(TelaAfetada).max(5),
  achados_tratados: z.array(z.object({ achado_id: z.string(), como: Texto(400) })),
  bloqueios: z.array(
    z.object({
      descricao: Texto(400),
      precisa: z.enum([
        'decisao_do_operador',
        'arquivo_fora_do_plano',
        'ambiente',
        'informacao_do_cliente',
      ]),
    }),
  ),
  /** Vai para a nota interna, nunca ao cliente. */
  resumo_tecnico: Texto(2000),
});
export type ResumoImplV1 = z.infer<typeof ResumoImplV1>;
