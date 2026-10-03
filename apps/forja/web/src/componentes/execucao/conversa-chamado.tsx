import { forwardRef, useState } from 'react';
import type { ExecucaoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { modoConversa, pausarEEnviar } from './acoes-execucao';
import { horaFeed } from './formato-execucao';
import { BlocoProveniencia, TextoSeguro } from './suporte';
import { useComando } from '@/componentes/apoio/comando';

/**
 * Conversa do chamado (specs/forja/06 §4.2 "Conversa do chamado"; F-13). O
 * campo fica sempre visível e fala com o condutor (Fable) da etapa. Com a
 * etapa rodando o botão diz "Pausar e enviar": a UI pausa (SIGINT), espera o
 * estado `pausado_usuario` e só então envia, via `claude -p --resume` com o
 * mesmo perfil da etapa (`pausarEEnviar`). As respostas
 * do condutor aparecem como balões aqui, separadas do feed. Com o PTY de
 * "Assumir" aberto, o campo fica desabilitado (lock por sessão) — o motivo
 * vem do servidor em `conversa_bloqueada`.
 *
 * As mensagens públicas novas do cliente aparecem acima, em bloco "dado do
 * cliente": a Forja NÃO as encaminha ao agente (F-15) — se mudam o escopo,
 * quem escreve o pedido é o humano.
 */

export const ConversaChamado = forwardRef<HTMLElement, { execucao: ExecucaoDto }>(
  function ConversaChamado({ execucao }, ref) {
    const ex = execucao;
    const [texto, setTexto] = useState('');
    const modo = modoConversa(ex);
    const rodando = modo.tipo === 'pausar_e_enviar';
    const bloqueio = modo.tipo === 'bloqueada' ? modo.motivo : null;
    const enviar = useComando({
      executar: (t: string): Promise<unknown> =>
        modo.tipo === 'pausar_e_enviar'
          ? pausarEEnviar({
              pausar: () => api('execucao_pausar', { params: { id: ex.id } }),
              estadoAtual: async () =>
                (await api('execucao_obter', { params: { id: ex.id } })).estado,
              conversar: () =>
                api('execucao_conversar', { params: { id: ex.id }, entrada: { texto: t } }),
            })
          : api('execucao_conversar', { params: { id: ex.id }, entrada: { texto: t } }),
      invalidar: [['execucao', ex.id]],
      aoSucesso: () => setTexto(''),
    });

    return (
      <section
        ref={ref}
        tabIndex={-1}
        aria-label="Conversa do chamado"
        className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-cartao outline-none"
      >
        <header className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">Conversa do chamado</h3>
          <span className="text-xs text-muted-foreground">
            fala com o condutor (Fable) desta etapa{rodando ? '; pausa a etapa ao enviar' : ''}
          </span>
        </header>

        {ex.mensagens_novas_cliente.length > 0 && (
          <BlocoProveniencia origem="cliente" titulo="O cliente escreveu depois do início">
            {ex.mensagens_novas_cliente.map((m) => (
              <div key={m.id} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {m.autor_nome} · {horaFeed(m.em)}
                </span>
                <TextoSeguro texto={m.corpo_markdown} />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Não é encaminhado ao agente. Se muda o escopo, escreva o pedido abaixo.
            </p>
          </BlocoProveniencia>
        )}

        {ex.conversa.length > 0 && (
          <ol className="flex flex-col gap-2">
            {ex.conversa.map((m) => (
              <li
                key={m.id}
                className={cn(
                  'max-w-[85%] rounded-xl px-3 py-2 text-sm',
                  m.autor === 'humano'
                    ? 'self-end bg-primary/10 text-foreground'
                    : 'self-start border bg-muted/60',
                )}
              >
                <span className="mb-0.5 block text-[0.7rem] text-muted-foreground">
                  {m.autor === 'humano' ? 'você' : 'Fable (escrito pelo agente)'} · {horaFeed(m.em)}
                </span>
                <TextoSeguro texto={m.texto} />
              </li>
            ))}
          </ol>
        )}

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (texto.trim() && !bloqueio && !enviar.isPending) enviar.mutate(texto.trim());
          }}
        >
          <Textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            disabled={!!bloqueio}
            placeholder={bloqueio ?? 'ex.: use paginação por cursor, não offset'}
            aria-label="Mensagem ao condutor"
            className="min-h-10 flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (texto.trim() && !bloqueio && !enviar.isPending) enviar.mutate(texto.trim());
              }
            }}
          />
          <Button type="submit" disabled={!!bloqueio || !texto.trim() || enviar.isPending}>
            {enviar.isPending && rodando ? 'Pausando…' : rodando ? 'Pausar e enviar' : 'Enviar'}
          </Button>
        </form>
        {bloqueio && <p className="text-xs text-muted-foreground">{bloqueio}</p>}
      </section>
    );
  },
);
