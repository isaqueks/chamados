import type {
  ArquivoBaixado,
  EntradaMensagem,
  EntradaStatus,
  FiltrosListarChamados,
  FormatoCorpo,
  ItemChamado,
  OpcoesChamada,
  PaginaChamados,
  RespostaAtribuicao,
  RespostaDetalheChamado,
  RespostaMensagem,
  RespostaSilencioIa,
  RespostaSistemasAlvo,
  RespostaStatus,
} from '@chamados/cliente-api';

/**
 * Superfície da API do Chamados que os módulos de `server/chamados` consomem
 * (specs/forja/07 §3). É um SUBCONJUNTO estrutural de `ClienteChamados`: a fila,
 * o polling e o outbox recebem esta interface por injeção, e não o cliente
 * concreto, para que:
 *  - em produção passem por `ConexaoChamados` (que acompanha o estado da sessão
 *    — "sessão recusada", "credencial inválida", rate limit — antes de deixar
 *    uma chamada sair, 07 §2.2);
 *  - nos testes passe um `ClienteChamados` real com `fetch` falso.
 */
export interface OperacoesChamados {
  listarChamados(filtros?: FiltrosListarChamados, opts?: OpcoesChamada): Promise<PaginaChamados>;
  listarTodosChamados(
    filtros?: Omit<FiltrosListarChamados, 'cursor'>,
    opts?: OpcoesChamada & { maxPaginas?: number },
  ): Promise<ItemChamado[]>;
  obterChamado(
    ref: string,
    opts?: OpcoesChamada & { formato?: FormatoCorpo },
  ): Promise<RespostaDetalheChamado>;
  publicarMensagem(
    ref: string,
    entrada: EntradaMensagem,
    opts?: OpcoesChamada,
  ): Promise<RespostaMensagem>;
  mudarStatus(ref: string, entrada: EntradaStatus, opts?: OpcoesChamada): Promise<RespostaStatus>;
  listarSistemasAlvo(opts?: OpcoesChamada): Promise<RespostaSistemasAlvo>;
  baixarAnexo(id: string, opts?: OpcoesChamada): Promise<ArquivoBaixado>;
  definirSilencioIa(
    ref: string,
    silenciada: boolean,
    opts?: OpcoesChamada,
  ): Promise<RespostaSilencioIa>;
  atribuir(
    ref: string,
    operadorId: string | null,
    opts?: OpcoesChamada,
  ): Promise<RespostaAtribuicao>;
}

/**
 * Quem a Forja é no Chamados (07 §2.1): o operador dedicado. O `nome` é o
 * `autor_nome` que aparece nas mensagens — a API não expõe o id do autor, então
 * a anti-duplicação (07 §9) e o filtro "mensagem minha" comparam por ele.
 */
export interface IdentidadeForja {
  usuarioId: string;
  nome: string;
}
