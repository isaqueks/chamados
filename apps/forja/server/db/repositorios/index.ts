import type { EntityManager } from 'typeorm';
import type { Relogio } from '../ids';
import { RepositorioAprovacoes } from './aprovacao';
import { RepositorioArtefatos } from './artefato';
import { RepositorioChamadosCache } from './chamado-cache';
import { RepositorioComentarios } from './comentario';
import { RepositorioConexoes } from './conexao';
import { RepositorioEtapas } from './etapa';
import { RepositorioEventos } from './evento';
import { RepositorioExecucoes } from './execucao';
import { RepositorioFilaMerge } from './item-fila-merge';
import { RepositorioLotes } from './lote';
import { RepositorioOutbox } from './outbox-chamado';
import { RepositorioProjetos } from './projeto';
import { RepositorioSessoesTerminal } from './sessao-terminal';
import { RepositorioUsoAssinatura } from './uso-assinatura';

/**
 * Conjunto de repositórios presos a UMA transação (specs/forja/02 §4). É o que
 * `BancoForja.transacao(fn)` entrega a `fn`: tudo o que for feito por eles cai
 * na mesma transação serializada.
 */
export class Repositorios {
  readonly conexoes: RepositorioConexoes;
  readonly projetos: RepositorioProjetos;
  readonly chamados: RepositorioChamadosCache;
  readonly lotes: RepositorioLotes;
  readonly execucoes: RepositorioExecucoes;
  readonly etapas: RepositorioEtapas;
  readonly eventos: RepositorioEventos;
  readonly artefatos: RepositorioArtefatos;
  readonly comentarios: RepositorioComentarios;
  readonly aprovacoes: RepositorioAprovacoes;
  readonly filaMerge: RepositorioFilaMerge;
  readonly outbox: RepositorioOutbox;
  readonly usoAssinatura: RepositorioUsoAssinatura;
  readonly terminais: RepositorioSessoesTerminal;

  constructor(
    readonly m: EntityManager,
    relogio: Relogio,
  ) {
    this.conexoes = new RepositorioConexoes(m, relogio);
    this.projetos = new RepositorioProjetos(m, relogio);
    this.chamados = new RepositorioChamadosCache(m, relogio);
    this.lotes = new RepositorioLotes(m, relogio);
    this.execucoes = new RepositorioExecucoes(m, relogio);
    this.etapas = new RepositorioEtapas(m, relogio);
    this.eventos = new RepositorioEventos(m, relogio);
    this.artefatos = new RepositorioArtefatos(m, relogio);
    this.comentarios = new RepositorioComentarios(m, relogio);
    this.aprovacoes = new RepositorioAprovacoes(m, relogio);
    this.filaMerge = new RepositorioFilaMerge(m, relogio);
    this.outbox = new RepositorioOutbox(m, relogio);
    this.usoAssinatura = new RepositorioUsoAssinatura(m, relogio);
    this.terminais = new RepositorioSessoesTerminal(m, relogio);
  }
}

export * from './aprovacao';
export * from './artefato';
export * from './chamado-cache';
export * from './comentario';
export * from './conexao';
export * from './etapa';
export * from './evento';
export * from './execucao';
export * from './item-fila-merge';
export * from './lote';
export * from './outbox-chamado';
export * from './projeto';
export * from './sessao-terminal';
export * from './uso-assinatura';
