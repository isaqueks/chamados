'use client';

import { useActionState } from 'react';
import { LIMITE_IA_INSTRUCOES_CHARS } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoSalvarInstrucoesIa, type EstadoConfig } from './actions';

const INICIAL: EstadoConfig = {};

/**
 * Instruções do admin para a IA (D-020): texto livre que entra no system prompt
 * de toda triagem, subordinado às regras da plataforma (specs/05 §4.1).
 */
export function IaForm({ instrucoes }: { instrucoes: string | null }) {
  const [estado, acao, pendente] = useActionState(acaoSalvarInstrucoesIa, INICIAL);

  return (
    <form action={acao} className="flex flex-col gap-4">
      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}
      {estado.sucesso && (
        <Alert variant="success">
          <AlertDescription>{estado.sucesso}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="ia_instrucoes">Instruções para a IA</Label>
        <Textarea
          id="ia_instrucoes"
          name="ia_instrucoes"
          rows={6}
          maxLength={LIMITE_IA_INSTRUCOES_CHARS}
          defaultValue={instrucoes ?? ''}
          placeholder={
            'Ex.: Nosso sistema atende clínicas médicas; trate "agenda" como agenda de consultas. ' +
            'Responda sempre em tom formal. Chamados sobre faturamento são prioritários.'
          }
        />
        <p className="text-xs text-muted-foreground">
          Orientações adicionais aplicadas em toda análise da IA: tom, contexto do negócio,
          prioridades, vocabulário. Não substituem as regras de segurança da plataforma (a IA
          continua sem publicar detalhes técnicos ao cliente e sem fazer merge/deploy). Máximo de{' '}
          {LIMITE_IA_INSTRUCOES_CHARS.toLocaleString('pt-BR')} caracteres; deixe vazio para remover.
        </p>
      </div>

      <div>
        <Button type="submit" disabled={pendente}>
          {pendente ? 'Salvando…' : 'Salvar instruções da IA'}
        </Button>
      </div>
    </form>
  );
}
