import { Sparkles } from 'lucide-react';

/**
 * Painel "Assistente IA" (specs/08 §4.3). Estado vazio elegante: a triagem e a
 * resolução automática chegam no M6+ (pipeline `ExecucaoIA`). A estrutura já está
 * pronta para ser preenchida — diagnóstico, natureza/complexidade sugeridas, PR e
 * guardrails de aprovação humana — quando o agente_ia entrar em operação.
 */
export function AssistenteIA({ nomeAssistente }: { nomeAssistente: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Sparkles className="size-4" />
        </span>
        <h3 className="font-heading text-sm font-semibold">{nomeAssistente}</h3>
      </div>

      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center">
        <p className="text-sm font-medium">A triagem automática chega no próximo marco</p>
        <p className="text-xs text-muted-foreground">
          Aqui aparecerão o diagnóstico da IA, natureza e complexidade sugeridas, PRs de correção e
          a aprovação humana dos guardrails.
        </p>
      </div>

      <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <li className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          Diagnóstico e plano de resolução
        </li>
        <li className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          Sugestões de classificação
        </li>
        <li className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          PR de correção com aprovação humana
        </li>
      </ul>
    </div>
  );
}
