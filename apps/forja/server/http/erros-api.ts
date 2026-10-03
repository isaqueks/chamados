import type { ErroApiDto } from '../../comum/dto';
import { ErroConexaoIndisponivel, ErroUrlConexao } from '../chamados/conexao';
import { ErroSessaoOcupada as ErroSessaoOcupadaRunner } from '../claude/lock-sessoes';
import { ErroEstado, ErroJsonInvalido, ErroNaoEncontrado, ErroRestricao } from '../db/erros';
import { erroParaApi } from '../dominio/servicos';
import { ErroForja } from '../dominio/nucleo';
import { ErroSessaoOcupada as ErroSessaoOcupadaPty } from '../processos/lock-sessao';
import type { ErroTerminal } from '../terminal/sessoes';
import type { StatusErro } from './rotas/tipos';

/**
 * Tradução de QUALQUER erro de um handler em `ErroApiDto` (specs/forja/01
 * §4.1 "Erro: sempre `ErroApiDto` com código estável"; 05 §8.2).
 *
 * POR QUE aqui e não só `erroParaApi` da fachada: a fachada lança `ErroForja`,
 * mas abaixo dela os pacotes da R2 lançam os próprios erros (repositório que
 * não acha a linha, gerente de PTY no limite, lock de sessão ocupado, conexão
 * do Chamados bloqueada). Sem esta tabela todos virariam 500 e a UI não teria
 * como distinguir "não existe" de "tente de novo". Erro desconhecido vira 500
 * com mensagem GENÉRICA: o texto cru (que pode ter caminho, SQL ou trecho de
 * resposta do Chamados) vai só para o stderr do terminal, nunca ao navegador.
 */

export interface ErroTraduzido {
  status: StatusErro;
  corpo: ErroApiDto;
}

const STATUS_TERMINAL: Record<ErroTerminal['codigo'], StatusErro> = {
  sessao_inexistente: 404,
  limite_ptys: 409,
  processo_vivo: 409,
  processo_morto: 409,
  nao_assumida: 409,
  assumida_nao_devolvida: 409,
  ja_devolvida: 409,
};

/**
 * `ErroTerminal` reconhecido pelo FORMATO, não por `instanceof`: importar a
 * classe puxaria `node-pty` (módulo nativo) para o servidor inteiro, e o
 * Terminal é opcional — sem `node-pty` a Forja sobe sem ele (06 §4.10).
 */
function ehErroTerminal(e: unknown): e is ErroTerminal {
  if (!(e instanceof Error) || e.constructor.name !== 'ErroTerminal') return false;
  const codigo = (e as { codigo?: unknown }).codigo;
  return typeof codigo === 'string' && codigo in STATUS_TERMINAL;
}

export function traduzirErro(
  e: unknown,
  log: (mensagem: string, erro: unknown) => void = () => {},
): ErroTraduzido {
  if (e instanceof ErroForja) {
    const r = erroParaApi(e);
    return { status: r.status, corpo: r.corpo };
  }
  if (e instanceof ErroNaoEncontrado) {
    return { status: 404, corpo: { erro: 'nao_encontrado', mensagem: e.message } };
  }
  if (e instanceof ErroRestricao) {
    // Referência inexistente / campo obrigatório / CHECK = a entrada estava errada;
    // único e invariantes (I-1…I-9) = conflito com o estado atual.
    const entrada = ['chave_estrangeira', 'nao_nulo', 'check'].includes(e.invariante);
    return entrada
      ? { status: 400, corpo: { erro: 'entrada_invalida', mensagem: e.message } }
      : { status: 409, corpo: { erro: 'conflito', mensagem: e.message } };
  }
  if (e instanceof ErroEstado) {
    return { status: 409, corpo: { erro: 'conflito', mensagem: e.message } };
  }
  if (e instanceof ErroJsonInvalido || e instanceof ErroUrlConexao) {
    return { status: 400, corpo: { erro: 'entrada_invalida', mensagem: e.message } };
  }
  if (ehErroTerminal(e)) {
    const status = STATUS_TERMINAL[e.codigo];
    return {
      status,
      corpo: { erro: status === 404 ? 'nao_encontrado' : 'conflito', mensagem: e.message },
    };
  }
  if (e instanceof ErroSessaoOcupadaPty || e instanceof ErroSessaoOcupadaRunner) {
    return { status: 409, corpo: { erro: 'conflito', mensagem: e.message } };
  }
  if (e instanceof ErroConexaoIndisponivel) {
    return { status: 503, corpo: { erro: 'chamados_indisponivel', mensagem: e.message } };
  }
  log('erro não tratado', e);
  return {
    status: 500,
    corpo: { erro: 'erro_interno', mensagem: 'Erro interno da Forja (veja o terminal)' },
  };
}
