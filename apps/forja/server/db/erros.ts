/**
 * Erros da camada de persistência (specs/forja/02 §1 e §5).
 *
 * POR QUE traduzir: o SQLite garante as invariantes de 02 §5 (índices únicos
 * parciais, CHECKs nomeados), mas devolve só "UNIQUE constraint failed: t.a, t.b"
 * ou "CHECK constraint failed: ck_…". Quem chama (orquestrador, rotas) precisa
 * saber QUAL invariante caiu para responder ao humano ("já existe execução ativa
 * para este chamado" ≠ "sessão já em uso no terminal"). `traduzirErroBanco`
 * converte o erro do driver em `ErroRestricao` com o código da invariante.
 *
 * Mensagens de UNIQUE trazem as colunas (não o nome do índice), por isso o mapa
 * abaixo é por lista de colunas; CHECKs são identificados pelo nome.
 */

export type CodigoInvariante =
  | 'I-1'
  | 'I-2'
  | 'I-3'
  | 'I-4'
  | 'I-5'
  | 'I-6'
  | 'I-7'
  | 'I-9'
  | 'unico'
  | 'check'
  | 'chave_estrangeira'
  | 'nao_nulo';

/** Violação de restrição do banco ou de invariante checada pelo app na transação. */
export class ErroRestricao extends Error {
  constructor(
    readonly invariante: CodigoInvariante,
    /** Nome da constraint ou colunas envolvidas, como o SQLite informou. */
    readonly restricao: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ErroRestricao';
  }
}

/** JSON gravado não passa no schema zod da coluna (02 §1: erro explícito, nunca default). */
export class ErroJsonInvalido extends Error {
  constructor(
    readonly coluna: string,
    detalhe: string,
  ) {
    super(`JSON inválido em ${coluna}: ${detalhe}`);
    this.name = 'ErroJsonInvalido';
  }
}

/** Linha esperada não existe. */
export class ErroNaoEncontrado extends Error {
  constructor(
    readonly entidade: string,
    readonly id: string,
  ) {
    super(`${entidade} ${id} não encontrado(a)`);
    this.name = 'ErroNaoEncontrado';
  }
}

/**
 * Operação incompatível com o estado ATUAL da linha (ex.: mudar o estado de uma
 * execução terminal, finalizar uma etapa já finalizada). Validação de
 * transição da máquina é do domínio (03); isto é só a proteção do dado.
 */
export class ErroEstado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroEstado';
  }
}

/** Falha ao aplicar migrations no boot; o servidor não sobe e mostra o backup (02 §1). */
export class ErroMigracao extends Error {
  constructor(
    mensagem: string,
    readonly caminhoBackup: string | null,
    readonly causa?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroMigracao';
  }
}

const UNICOS: Record<string, { invariante: CodigoInvariante; mensagem: string }> = {
  'execucao.conexao_id, execucao.chamado_id': {
    invariante: 'I-1',
    mensagem: 'já existe uma execução ativa para este chamado',
  },
  'execucao.worktree_dir': {
    invariante: 'I-6',
    mensagem: 'a worktree já pertence a outra execução ativa',
  },
  'execucao.projeto_id, execucao.branch': {
    invariante: 'I-6',
    mensagem: 'a branch já pertence a outra execução ativa do projeto',
  },
  'etapa.session_id': {
    invariante: 'I-2',
    mensagem: 'já há um processo executando nesta sessão do Claude',
  },
  'sessao_terminal.session_id_claude': {
    invariante: 'I-2',
    mensagem: 'esta sessão do Claude já está assumida em outro terminal',
  },
  'aprovacao.execucao_id': {
    invariante: 'I-3',
    mensagem: 'já existe uma aprovação final vigente para esta execução',
  },
  'outbox_chamado.execucao_id, outbox_chamado.passo, outbox_chamado.rodada': {
    invariante: 'I-4',
    mensagem: 'este passo do outbox já existe nesta rodada',
  },
  'item_fila_merge.execucao_id': {
    invariante: 'I-5',
    mensagem: 'a execução já tem um item ativo na fila de merge',
  },
  'item_fila_merge.projeto_id, item_fila_merge.branch_destino': {
    invariante: 'I-5',
    mensagem: 'a fila de merge já tem um item em processamento',
  },
};

const CHECKS: Record<string, { invariante: CodigoInvariante; mensagem: string }> = {
  ck_execucao_lateral_anterior: {
    invariante: 'I-9',
    mensagem: 'estado lateral exige estado_anterior',
  },
  ck_aprovacao_final_patch: {
    invariante: 'I-3',
    mensagem: 'aprovação final exige patch_id e sha e não pode ser em bloco',
  },
};

interface ErroDriver {
  code?: unknown;
  message?: unknown;
}

function erroDoDriver(erro: unknown): ErroDriver | null {
  if (!erro || typeof erro !== 'object') return null;
  const comDriver = erro as { driverError?: unknown };
  const alvo = (comDriver.driverError ?? erro) as ErroDriver;
  return typeof alvo.code === 'string' && alvo.code.startsWith('SQLITE_CONSTRAINT') ? alvo : null;
}

/** Converte erro de constraint do SQLite (cru ou `QueryFailedError`) em `ErroRestricao`; demais passam. */
export function traduzirErroBanco(erro: unknown): unknown {
  if (erro instanceof ErroRestricao) return erro;
  const d = erroDoDriver(erro);
  if (!d) return erro;
  const msg = String(d.message ?? '');
  const codigo = String(d.code);
  if (codigo === 'SQLITE_CONSTRAINT_UNIQUE' || codigo === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const colunas = msg.replace(/^UNIQUE constraint failed: /, '').trim();
    const conhecido = UNICOS[colunas];
    return conhecido
      ? new ErroRestricao(conhecido.invariante, colunas, conhecido.mensagem)
      : new ErroRestricao('unico', colunas, `valor duplicado (${colunas})`);
  }
  if (codigo === 'SQLITE_CONSTRAINT_CHECK') {
    const nome = msg.replace(/^CHECK constraint failed: /, '').trim();
    const conhecido = CHECKS[nome];
    return conhecido
      ? new ErroRestricao(conhecido.invariante, nome, conhecido.mensagem)
      : new ErroRestricao('check', nome, `restrição violada (${nome})`);
  }
  if (codigo === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return new ErroRestricao(
      'chave_estrangeira',
      'foreign_key',
      'referência inexistente ou em uso',
    );
  }
  if (codigo === 'SQLITE_CONSTRAINT_NOTNULL') {
    const coluna = msg.replace(/^NOT NULL constraint failed: /, '').trim();
    return new ErroRestricao('nao_nulo', coluna, `campo obrigatório ausente (${coluna})`);
  }
  return new ErroRestricao('check', codigo, msg);
}
