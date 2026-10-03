import { z } from 'zod';
import { Texto } from './base';

/**
 * `resposta.v1` — rascunho da mensagem pública ao cliente (specs/forja/04 §5).
 * Vem embutido no relatório (T3) e também é o formato da pergunta do Gdec.
 * Passa pelo validador de linguagem (04 §8) antes de ser mostrado e de novo
 * antes de ser publicado — o `tipo` é exigido pelo app (04 §8.2).
 */
export const RespostaV1 = z.object({
  versao: z.literal(1),
  tipo: z.enum(['aguardando_publicacao', 'disponivel', 'pergunta']),
  corpo_markdown: Texto(1200),
  cita_prazo: z.boolean(),
});
export type RespostaV1 = z.infer<typeof RespostaV1>;
