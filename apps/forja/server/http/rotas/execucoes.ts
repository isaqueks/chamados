import { viaFachada, type HandlersRotas } from './tipos';

/**
 * Rotas da tela Execução (specs/forja/06 §4.2) e dos comandos humanos sobre a
 * máquina de estados (03 §2.4, §10): gates G1/Gdec, pausar, conversar, assumir,
 * devolver, descartar, ações de precisa_humano. O SSE do feed fica em shell.ts.
 *
 * Cada rota JSON delega à função homônima de `ServicosForja` (dominio/servicos.ts).
 */
export const rotasExecucoes = {
  execucao_obter: viaFachada('execucao_obter'),
  execucao_feed: viaFachada('execucao_feed'),
  execucao_transcript: viaFachada('execucao_transcript'),
  execucao_plano: viaFachada('execucao_plano'),
  execucao_aprovar_plano: viaFachada('execucao_aprovar_plano'),
  execucao_comentar_plano: viaFachada('execucao_comentar_plano'),
  execucao_decidir: viaFachada('execucao_decidir'),
  execucao_replanejar: viaFachada('execucao_replanejar'),
  execucao_pausar: viaFachada('execucao_pausar'),
  execucao_retomar: viaFachada('execucao_retomar'),
  execucao_parar: viaFachada('execucao_parar'),
  execucao_conversar: viaFachada('execucao_conversar'),
  execucao_assumir: viaFachada('execucao_assumir'),
  execucao_devolver: viaFachada('execucao_devolver'),
  execucao_descartar: viaFachada('execucao_descartar'),
  execucao_encerrar: viaFachada('execucao_encerrar'),
  execucao_tentar_novamente: viaFachada('execucao_tentar_novamente'),
  execucao_resolver_pendencia: viaFachada('execucao_resolver_pendencia'),
  execucao_ciente_mensagem: viaFachada('execucao_ciente_mensagem'),
  execucao_recapturar_prints: viaFachada('execucao_recapturar_prints'),
  execucao_reconhecer_sentinela: viaFachada('execucao_reconhecer_sentinela'),
  execucao_apagar_dados: viaFachada('execucao_apagar_dados'),
} satisfies Pick<
  HandlersRotas,
  | 'execucao_obter'
  | 'execucao_feed'
  | 'execucao_transcript'
  | 'execucao_plano'
  | 'execucao_aprovar_plano'
  | 'execucao_comentar_plano'
  | 'execucao_decidir'
  | 'execucao_replanejar'
  | 'execucao_pausar'
  | 'execucao_retomar'
  | 'execucao_parar'
  | 'execucao_conversar'
  | 'execucao_assumir'
  | 'execucao_devolver'
  | 'execucao_descartar'
  | 'execucao_encerrar'
  | 'execucao_tentar_novamente'
  | 'execucao_resolver_pendencia'
  | 'execucao_ciente_mensagem'
  | 'execucao_recapturar_prints'
  | 'execucao_reconhecer_sentinela'
  | 'execucao_apagar_dados'
>;
