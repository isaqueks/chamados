import { traduzirErro } from '../erros-api';
import { viaFachada, type HandlerBruto, type HandlersRotas } from './tipos';

/**
 * Arquivo de artefato (PNG de evidência ou log de comando). A fachada confere o
 * sha256 gravado antes de servir (05 §6.4: um print trocado no disco não chega
 * à aprovação); aqui só se escolhe o tipo e se proíbe o navegador de adivinhar.
 */
function arquivo<N extends 'evidencia_imagem' | 'artefato_log'>(
  obter: 'imagemEvidencia' | 'logArtefato',
): HandlerBruto<N> {
  return async ({ params, reply, deps }) => {
    const { id, artefato_id } = params as { id: string; artefato_id: string };
    try {
      const a = await deps.servicos[obter](id, artefato_id);
      void reply
        .code(200)
        .type(a.tipo)
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', 'inline')
        .send(a.conteudo);
    } catch (e) {
      const r = traduzirErro(e, deps.log);
      void reply.code(r.status).send(r.corpo);
    }
  };
}

/**
 * Rotas da Aprovação G2 (specs/forja/06 §4.3): relatório, diff, interdiff,
 * evidências, técnico, validador da resposta e a decisão humana amarrada ao
 * patch-id (05 §7.1: o servidor confere o patch-id enviado com o atual).
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasAprovacoes = {
  aprovacao_obter: viaFachada('aprovacao_obter'),
  aprovacao_diff: viaFachada('aprovacao_diff'),
  aprovacao_interdiff: viaFachada('aprovacao_interdiff'),
  aprovacao_evidencias: viaFachada('aprovacao_evidencias'),
  aprovacao_tecnico: viaFachada('aprovacao_tecnico'),
  aprovacao_validar_resposta: viaFachada('aprovacao_validar_resposta'),
  aprovacao_aprovar: viaFachada('aprovacao_aprovar'),
  aprovacao_pedir_ajustes: viaFachada('aprovacao_pedir_ajustes'),
  evidencia_imagem: arquivo<'evidencia_imagem'>('imagemEvidencia'),
  artefato_log: arquivo<'artefato_log'>('logArtefato'),
} satisfies Pick<
  HandlersRotas,
  | 'aprovacao_obter'
  | 'aprovacao_diff'
  | 'aprovacao_interdiff'
  | 'aprovacao_evidencias'
  | 'aprovacao_tecnico'
  | 'aprovacao_validar_resposta'
  | 'aprovacao_aprovar'
  | 'aprovacao_pedir_ajustes'
  | 'evidencia_imagem'
  | 'artefato_log'
>;
