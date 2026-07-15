'use server';

import { revalidatePath } from 'next/cache';
import {
  obterAppDataSource,
  runInTenantContext,
  criarChamado,
  transicionarStatus,
  atribuirOperador,
  desatribuirOperador,
  alterarPrioridade,
  alterarNatureza,
  definirComplexidade,
  criarMensagem,
  type MotivoCriar,
  type MotivoMensagem,
  type MotivoTransicionar,
  type MotivoMutacao,
  type ArquivoUpload,
  type DocRico,
} from '@chamados/db';
import {
  Natureza,
  Prioridade,
  Complexidade,
  StatusChamado,
  VisibilidadeMensagem,
  Papel,
} from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { ROTULO_STATUS_CHAMADO } from '@/lib/rotulos';

export interface EstadoChamado {
  erro?: string;
  sucesso?: string;
}

/** Resultado padrão das ações do painel para feedback via toast. */
export type ResultadoAcao = { ok: true; msg: string } | { ok: false; msg: string };

const MOTIVOS_CRIAR: Record<MotivoCriar, string> = {
  sem_permissao: 'Sem permissão para abrir chamados.',
  solicitante_obrigatorio: 'Informe o solicitante do chamado.',
  solicitante_invalido: 'Solicitante inválido.',
  titulo_invalido: 'O título deve ter entre 3 e 160 caracteres.',
  descricao_invalida: 'Descrição inválida.',
  descricao_obrigatoria: 'Descreva o chamado.',
  descricao_muito_longa: 'A descrição excede o limite de 50.000 caracteres.',
  imagem_invalida: 'Uma imagem colada não é um tipo de imagem válido.',
  imagens_demais: 'Muitas imagens no corpo (máximo 20).',
  natureza_invalida: 'Selecione a natureza do chamado.',
  prioridade_invalida: 'Prioridade inválida.',
  sistema_alvo_obrigatorio: 'Selecione o sistema-alvo.',
  sistema_alvo_invalido: 'Sistema-alvo inválido.',
  categoria_invalida: 'Categoria inválida.',
};

const MOTIVOS_TRANSICAO: Record<MotivoTransicionar, string> = {
  inexistente: 'Chamado não encontrado.',
  sem_permissao: 'Sem permissão para esta transição.',
  mesmo_status: 'O chamado já está nesse status.',
  estado_terminal: 'Chamado encerrado não muda de status.',
  transicao_inexistente: 'Transição de status não permitida.',
  papel_nao_autorizado: 'Seu papel não pode fazer esta transição.',
};

const MOTIVOS_MUTACAO: Record<MotivoMutacao, string> = {
  inexistente: 'Chamado não encontrado.',
  sem_permissao: 'Sem permissão para esta ação.',
  estado_terminal: 'Chamado encerrado não aceita alterações.',
  valor_invalido: 'Valor inválido.',
  operador_invalido: 'Operador inválido.',
};

function ehNatureza(v: string): v is Natureza {
  return (Object.values(Natureza) as string[]).includes(v);
}
function ehPrioridade(v: string): v is Prioridade {
  return (Object.values(Prioridade) as string[]).includes(v);
}

/** Converte o JSON do editor (string) num doc TipTap; `null` se malformado. */
function parseDoc(bruto: string): DocRico | null {
  try {
    const obj = JSON.parse(bruto) as unknown;
    if (obj && typeof obj === 'object' && (obj as { type?: string }).type === 'doc') {
      return obj as DocRico;
    }
    return null;
  } catch {
    return null;
  }
}

/** Revalida as superfícies afetadas por uma mutação de chamado. */
function revalidarChamado(id: string): void {
  revalidatePath('/app');
  revalidatePath('/app/chamados');
  revalidatePath(`/app/chamados/${id}`);
}

/** Abre um chamado com o formulário mínimo (specs/04 §2). */
export async function acaoCriarChamado(
  _prev: EstadoChamado,
  formData: FormData,
): Promise<EstadoChamado> {
  const { tenant, usuario } = await exigirUsuario();

  const titulo = String(formData.get('titulo') ?? '').trim();
  const descricao = String(formData.get('descricao') ?? '');
  const naturezaRaw = String(formData.get('natureza') ?? '');
  const prioridadeRaw = String(formData.get('prioridade') ?? '');

  if (!ehNatureza(naturezaRaw)) return { erro: 'Selecione a natureza do chamado.' };
  const prioridade =
    prioridadeRaw === '' ? undefined : ehPrioridade(prioridadeRaw) ? prioridadeRaw : null;
  if (prioridade === null) return { erro: 'Prioridade inválida.' };

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    criarChamado(em, usuario, { titulo, descricao, natureza: naturezaRaw, prioridade }),
  );
  if (!r.ok) return { erro: MOTIVOS_CRIAR[r.motivo] };

  revalidatePath('/app/chamados');
  return { sucesso: `Chamado #${r.numero} aberto.` };
}

/** Aplica uma transição de status (máquina de estados — specs/04 §1). */
export async function acaoTransicionar(
  chamadoId: string,
  novoStatus: string,
): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  if (!(Object.values(StatusChamado) as string[]).includes(novoStatus)) {
    return { ok: false, msg: 'Status inválido.' };
  }
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    transicionarStatus(em, usuario, chamadoId, novoStatus as StatusChamado),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_TRANSICAO[r.motivo] };
  revalidarChamado(chamadoId);
  return {
    ok: true,
    msg: `Status alterado para "${ROTULO_STATUS_CHAMADO[novoStatus as StatusChamado]}".`,
  };
}

/** Atribui o chamado ao próprio operador logado (specs/04 §7 — "assumir"). */
export async function acaoAssumir(chamadoId: string): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    atribuirOperador(em, usuario, chamadoId, usuario.id),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_MUTACAO[r.motivo] };
  revalidarChamado(chamadoId);
  return { ok: true, msg: 'Chamado atribuído a você.' };
}

/** Atribui/reatribui o chamado a um operador específico. */
export async function acaoAtribuir(chamadoId: string, operadorId: string): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  if (!operadorId) return { ok: false, msg: 'Selecione um operador.' };
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    atribuirOperador(em, usuario, chamadoId, operadorId),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_MUTACAO[r.motivo] };
  revalidarChamado(chamadoId);
  return { ok: true, msg: 'Operador atribuído.' };
}

/** Remove a atribuição do chamado (specs/04 §7). */
export async function acaoDesatribuir(chamadoId: string): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    desatribuirOperador(em, usuario, chamadoId),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_MUTACAO[r.motivo] };
  revalidarChamado(chamadoId);
  return { ok: true, msg: 'Atribuição removida.' };
}

/** Altera a prioridade (specs/04 §3.2). */
export async function acaoAlterarPrioridade(
  chamadoId: string,
  prioridade: string,
): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  if (!ehPrioridade(prioridade)) return { ok: false, msg: 'Prioridade inválida.' };
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    alterarPrioridade(em, usuario, chamadoId, prioridade),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_MUTACAO[r.motivo] };
  revalidarChamado(chamadoId);
  return { ok: true, msg: 'Prioridade atualizada.' };
}

/** Altera a natureza (specs/04 §3.1). */
export async function acaoAlterarNatureza(
  chamadoId: string,
  natureza: string,
): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  if (!ehNatureza(natureza)) return { ok: false, msg: 'Natureza inválida.' };
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    alterarNatureza(em, usuario, chamadoId, natureza),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_MUTACAO[r.motivo] };
  revalidarChamado(chamadoId);
  return { ok: true, msg: 'Natureza atualizada.' };
}

/** Define/limpa a complexidade interna (specs/04 §3.3). `''` limpa. */
export async function acaoDefinirComplexidade(
  chamadoId: string,
  complexidade: string,
): Promise<ResultadoAcao> {
  const { tenant, usuario } = await exigirUsuario();
  const valor =
    complexidade === ''
      ? null
      : (Object.values(Complexidade) as string[]).includes(complexidade)
        ? (complexidade as Complexidade)
        : undefined;
  if (valor === undefined) return { ok: false, msg: 'Complexidade inválida.' };
  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    definirComplexidade(em, usuario, chamadoId, valor),
  );
  if (!r.ok) return { ok: false, msg: MOTIVOS_MUTACAO[r.motivo] };
  revalidarChamado(chamadoId);
  return { ok: true, msg: valor ? 'Complexidade atualizada.' : 'Complexidade removida.' };
}

const MOTIVOS_MENSAGEM: Record<MotivoMensagem, string> = {
  chamado_inexistente: 'Chamado não encontrado.',
  sem_permissao: 'Sem permissão para esta ação.',
  estado_terminal: 'Chamado encerrado não recebe novas mensagens.',
  visibilidade_invalida: 'Visibilidade inválida.',
  corpo_invalido: 'Mensagem inválida.',
  corpo_vazio: 'Escreva a mensagem.',
  corpo_muito_longo: 'A mensagem excede o limite de 50.000 caracteres.',
  imagem_invalida: 'Uma imagem colada não é um tipo de imagem válido.',
  imagens_demais: 'Muitas imagens no corpo (máximo 20).',
  muitos_anexos: 'Muitos anexos (máximo 20).',
  anexo_invalido: 'Um dos anexos tem tipo não suportado ou inválido.',
};

/** Limite defensivo por arquivo no server action (o serviço revalida por conteúdo). */
const TAMANHO_MAX_UPLOAD = 25 * 1024 * 1024;

/** Publica uma mensagem na timeline (pública/interna) com anexos (specs/04 §6). */
export async function acaoResponder(
  _prev: EstadoChamado,
  formData: FormData,
): Promise<EstadoChamado> {
  const { tenant, usuario } = await exigirUsuario();

  const chamadoId = String(formData.get('chamado_id') ?? '');
  const corpoRaw = String(formData.get('corpo') ?? '');
  const visRaw = String(formData.get('visibilidade') ?? '');

  if (!chamadoId) return { erro: 'Chamado inválido.' };

  const doc = parseDoc(corpoRaw);
  if (!doc) return { erro: 'Escreva a mensagem.' };

  // Cliente sempre publica; operador/admin escolhem (default Interna — specs/08).
  const visibilidade =
    usuario.papel === Papel.cliente
      ? VisibilidadeMensagem.publica
      : visRaw === VisibilidadeMensagem.publica
        ? VisibilidadeMensagem.publica
        : VisibilidadeMensagem.interna;

  const anexos: ArquivoUpload[] = [];
  for (const item of formData.getAll('anexos')) {
    if (typeof item === 'string' || item.size === 0) continue;
    if (item.size > TAMANHO_MAX_UPLOAD) return { erro: 'Anexo excede 25 MB.' };
    anexos.push({ nome_arquivo: item.name, buffer: Buffer.from(await item.arrayBuffer()) });
  }

  const ds = await obterAppDataSource();
  const r = await runInTenantContext(ds, tenant.id, (em) =>
    criarMensagem(em, usuario, {
      chamado_id: chamadoId,
      visibilidade,
      corpo: doc,
      anexos: anexos.length > 0 ? anexos : undefined,
    }),
  );
  if (!r.ok) return { erro: MOTIVOS_MENSAGEM[r.motivo] };

  revalidarChamado(chamadoId);
  const rotulo =
    visibilidade === VisibilidadeMensagem.interna
      ? 'Nota interna registrada.'
      : 'Resposta enviada.';
  return { sucesso: rotulo };
}
