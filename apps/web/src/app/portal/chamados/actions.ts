'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  obterAppDataSource,
  criarChamado,
  transicionarStatus,
  criarMensagem,
  type MotivoCriar,
  type MotivoMensagem,
  type ArquivoUpload,
  type DocRico,
} from '@chamados/db';
import { Natureza, Prioridade, StatusChamado, VisibilidadeMensagem } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { comDespacho } from '@/lib/despacho';

export interface EstadoChamado {
  erro?: string;
  sucesso?: string;
}

/** Mensagens amigáveis (pt-BR) por motivo de recusa na criação (specs/04). */
const MOTIVOS_CRIAR: Record<MotivoCriar, string> = {
  sem_permissao: 'Você não tem permissão para abrir chamados.',
  solicitante_obrigatorio: 'Informe o solicitante do chamado.',
  solicitante_invalido: 'Solicitante inválido.',
  titulo_invalido: 'O título deve ter entre 3 e 160 caracteres.',
  descricao_invalida: 'A descrição é inválida.',
  descricao_obrigatoria: 'Descreva o seu chamado.',
  descricao_muito_longa: 'A descrição excede o limite de 50.000 caracteres.',
  imagem_invalida: 'Uma imagem colada não é um tipo de imagem válido.',
  imagens_demais: 'Muitas imagens na descrição (máximo 20).',
  natureza_invalida: 'Selecione a natureza do chamado.',
  prioridade_invalida: 'Prioridade inválida.',
  sistema_alvo_obrigatorio: 'Selecione o sistema.',
  sistema_alvo_invalido: 'Sistema inválido.',
  categoria_invalida: 'Categoria inválida.',
};

const MOTIVOS_MENSAGEM: Record<MotivoMensagem, string> = {
  chamado_inexistente: 'Chamado não encontrado.',
  sem_permissao: 'Você não tem permissão para esta ação.',
  estado_terminal: 'Este chamado está encerrado e não recebe novas mensagens.',
  visibilidade_invalida: 'Visibilidade inválida.',
  corpo_invalido: 'Mensagem inválida.',
  corpo_vazio: 'Escreva a sua mensagem.',
  corpo_muito_longo: 'A mensagem excede o limite de 50.000 caracteres.',
  imagem_invalida: 'Uma imagem colada não é um tipo de imagem válido.',
  imagens_demais: 'Muitas imagens na mensagem (máximo 20).',
  muitos_anexos: 'Muitos anexos (máximo 20).',
  anexo_invalido: 'Um dos anexos tem tipo não suportado ou inválido.',
};

/** Limite defensivo por arquivo no server action (o serviço revalida por conteúdo). */
const TAMANHO_MAX_UPLOAD = 25 * 1024 * 1024;

function ehNatureza(v: string): v is Natureza {
  return (Object.values(Natureza) as string[]).includes(v);
}
function ehPrioridade(v: string): v is Prioridade {
  return (Object.values(Prioridade) as string[]).includes(v);
}
function ehStatus(v: string): v is StatusChamado {
  return (Object.values(StatusChamado) as string[]).includes(v);
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

/**
 * Abre um chamado com o formulário mínimo (specs/04 §2). O cliente cria para si.
 * A descrição vem como JSON do editor rico e passa pelo pipeline real (imagens
 * coladas → anexos inline + sanitização). Em sucesso, redireciona ao detalhe.
 */
export async function acaoCriarChamado(
  _prev: EstadoChamado,
  formData: FormData,
): Promise<EstadoChamado> {
  const { tenant, usuario } = await exigirUsuario();

  const titulo = String(formData.get('titulo') ?? '').trim();
  const naturezaRaw = String(formData.get('natureza') ?? '');
  const prioridadeRaw = String(formData.get('prioridade') ?? '');
  const descricaoRaw = String(formData.get('descricao') ?? '');
  const sistemaAlvoRaw = String(formData.get('sistema_alvo_id') ?? '').trim();

  // D-017 (parte 2): natureza é OPCIONAL na abertura pelo portal — sem escolha,
  // abre com o default do servidor e a IA classifica na triagem (naturezaAjustada).
  const natureza = naturezaRaw === '' ? Natureza.problema : naturezaRaw;
  if (!ehNatureza(natureza)) return { erro: 'Natureza inválida.' };

  const prioridade =
    prioridadeRaw === '' ? undefined : ehPrioridade(prioridadeRaw) ? prioridadeRaw : null;
  if (prioridade === null) return { erro: 'Prioridade inválida.' };

  const doc = parseDoc(descricaoRaw);
  if (!doc) return { erro: 'Descreva o seu chamado.' };

  const ds = await obterAppDataSource();
  const r = await comDespacho(ds, tenant.id, (em, hooks) =>
    criarChamado(
      em,
      usuario,
      {
        titulo,
        descricao: doc,
        natureza,
        prioridade,
        sistema_alvo_id: sistemaAlvoRaw || undefined,
      },
      hooks,
    ),
  );
  if (!r.ok) return { erro: MOTIVOS_CRIAR[r.motivo] };

  revalidatePath('/portal');
  redirect(`/portal/chamados/${r.id}?aberto=1`);
}

/** Publica uma mensagem pública na timeline do chamado (specs/04 §4) com anexos. */
export async function acaoResponder(
  _prev: EstadoChamado,
  formData: FormData,
): Promise<EstadoChamado> {
  const { tenant, usuario } = await exigirUsuario();

  const chamadoId = String(formData.get('chamado_id') ?? '');
  const corpoRaw = String(formData.get('corpo') ?? '');
  if (!chamadoId) return { erro: 'Chamado inválido.' };

  const doc = parseDoc(corpoRaw);
  if (!doc) return { erro: 'Escreva a sua mensagem.' };

  const anexos: ArquivoUpload[] = [];
  for (const item of formData.getAll('anexos')) {
    if (typeof item === 'string' || item.size === 0) continue;
    if (item.size > TAMANHO_MAX_UPLOAD) return { erro: 'Um anexo excede o limite de 25 MB.' };
    anexos.push({
      nome_arquivo: item.name,
      buffer: Buffer.from(await item.arrayBuffer()),
    });
  }

  const ds = await obterAppDataSource();
  const r = await comDespacho(ds, tenant.id, (em, hooks) =>
    criarMensagem(
      em,
      usuario,
      {
        chamado_id: chamadoId,
        // O cliente sempre publica mensagem pública (specs/04 §4.1).
        visibilidade: VisibilidadeMensagem.publica,
        corpo: doc,
        anexos: anexos.length > 0 ? anexos : undefined,
      },
      hooks,
    ),
  );
  if (!r.ok) return { erro: MOTIVOS_MENSAGEM[r.motivo] };

  revalidatePath(`/portal/chamados/${chamadoId}`);
  return { sucesso: 'Mensagem enviada.' };
}

/**
 * Aplica uma transição de status permitida ao cliente (reabrir/cancelar — specs/04
 * §1.3, §8.2). A máquina de estados no serviço rejeita transições inválidas.
 */
export async function acaoTransicionarCliente(formData: FormData): Promise<void> {
  const { tenant, usuario } = await exigirUsuario();
  const id = String(formData.get('id') ?? '');
  const novoStatus = String(formData.get('novo_status') ?? '');
  if (!id || !ehStatus(novoStatus)) return;

  const ds = await obterAppDataSource();
  await comDespacho(ds, tenant.id, (em, hooks) =>
    transicionarStatus(em, usuario, id, novoStatus, {}, hooks),
  );
  revalidatePath('/portal');
  revalidatePath(`/portal/chamados/${id}`);
}
