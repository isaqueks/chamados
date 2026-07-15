'use server';

import { obterAppDataSource, redefinirComToken } from '@chamados/db';
import { obterTenantAtual } from '@/lib/tenant';

export interface EstadoRedefinir {
  erro?: string;
  ok?: boolean;
}

/**
 * Redefine a senha a partir do token de uso único (specs/03 §4.3). Ao concluir,
 * o serviço revoga todas as sessões da conta.
 */
export async function acaoRedefinir(
  _prev: EstadoRedefinir,
  formData: FormData,
): Promise<EstadoRedefinir> {
  const token = String(formData.get('token') ?? '');
  const senha = String(formData.get('senha') ?? '');
  const confirma = String(formData.get('confirma') ?? '');

  if (!token) return { erro: 'Link inválido.' };
  if (senha.length < 8) return { erro: 'A senha deve ter ao menos 8 caracteres.' };
  if (senha !== confirma) return { erro: 'As senhas não conferem.' };

  const tenant = await obterTenantAtual();
  if (!tenant) return { erro: 'Endereço de tenant desconhecido.' };

  const ds = await obterAppDataSource();
  const r = await redefinirComToken(ds, tenant.id, token, senha);
  if (!r.ok) {
    const msg =
      r.motivo === 'expirado'
        ? 'Este link expirou. Solicite um novo.'
        : r.motivo === 'usado'
          ? 'Este link já foi utilizado.'
          : 'Link inválido ou expirado.';
    return { erro: msg };
  }
  return { ok: true };
}
