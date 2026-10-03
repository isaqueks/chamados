import type { AlertaAprovacaoDto, AprovacaoDto } from '@comum/dto';
import { Button } from '@/ui/button';
import { BlocoProveniencia, Faixa, TextoSeguro } from '@/componentes/execucao/suporte';
import { horaFeed } from '@/componentes/execucao/formato-execucao';
import { haQuantoTempo } from '@/componentes/fila/logica-fila';
import { shaCurto } from './regras-aprovar';

/**
 * Alertas acima das abas da Aprovação, na ordem fixa de 05-seguranca §6.4 (o
 * servidor já os entrega ordenados em `alertas`; a UI não reordena):
 * sentinela e negações → cliente escreveu depois → conflita com o destino →
 * altera a interface sem prints → reaprovação → demais. "Relatório contradiz o
 * diff" é mostrado no cabeçalho, no lugar dos selos (06 §4.3).
 *
 * - **Cliente escreveu depois**: as mensagens novas em bloco "dado do
 *   cliente". Desde FJ-034 é só aviso (sem checkbox "Li a mensagem nova"):
 *   aprovar dá a mensagem mostrada por vista; se chegar outra com a tela
 *   aberta, o servidor recusa e a tela recarrega. A Forja NÃO encaminha a
 *   mensagem ao agente.
 * - **Conflita com destino**: não bloqueia (a ponta pode mudar de novo); o
 *   aviso se repete acima do botão.
 * - **Sem prints** (FJ-026): faixa amarela com o motivo e [Recapturar prints].
 *   Não há mais o que configurar no Projeto: os prints são do agente (FJ-030 §3).
 */

export function AlertasAprovacao({
  aprovacao,
  podeRecapturar,
  aoRecapturar,
  recapturando,
}: {
  aprovacao: AprovacaoDto;
  /** `recapturar_prints` em `ExecucaoDto.acoes`. */
  podeRecapturar: boolean;
  aoRecapturar: () => void;
  recapturando: boolean;
}) {
  const a = aprovacao;
  const visiveis = a.alertas.filter((x) => x.tipo !== 'relatorio_contradiz');
  if (visiveis.length === 0 && !a.reaprovacao) return null;

  return (
    <div className="flex flex-col gap-2">
      {a.reaprovacao && !visiveis.some((x) => x.tipo === 'reaprovacao') && (
        <Faixa tom="aviso" titulo="Reaprovação">
          O patch mudou de {a.reaprovacao.patch_anterior.slice(0, 6)} para{' '}
          {a.reaprovacao.patch_atual.slice(0, 6)}: o Interdiff mostra o que mudou.
        </Faixa>
      )}
      {visiveis.map((alerta, i) => (
        <Alerta
          key={`${alerta.tipo}-${i}`}
          alerta={alerta}
          aprovacao={a}
          podeRecapturar={podeRecapturar}
          aoRecapturar={aoRecapturar}
          recapturando={recapturando}
        />
      ))}
    </div>
  );
}

function Detalhes({ itens, mono = false }: { itens: string[]; mono?: boolean }) {
  if (itens.length === 0) return null;
  return (
    <ul className={mono ? 'list-disc pl-4 font-mono text-xs' : 'list-disc pl-4'}>
      {itens.map((d, i) => (
        <li key={i}>{d}</li>
      ))}
    </ul>
  );
}

function Alerta({
  alerta,
  aprovacao,
  podeRecapturar,
  aoRecapturar,
  recapturando,
}: {
  alerta: AlertaAprovacaoDto;
  aprovacao: AprovacaoDto;
  podeRecapturar: boolean;
  aoRecapturar: () => void;
  recapturando: boolean;
}) {
  const tom = alerta.nivel === 'erro' ? 'erro' : 'aviso';
  switch (alerta.tipo) {
    case 'cliente_escreveu': {
      const msgs = aprovacao.mensagens_novas_cliente;
      const ultima = msgs[msgs.length - 1];
      return (
        <Faixa
          tom="aviso"
          titulo={`O cliente escreveu depois do plano${ultima ? ` (${haQuantoTempo(ultima.em)})` : ''}`}
        >
          <BlocoProveniencia origem="cliente" className="text-foreground">
            {msgs.map((m) => (
              <div key={m.id} className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {m.autor_nome} · {horaFeed(m.em)}
                </span>
                <TextoSeguro texto={m.corpo_markdown} />
              </div>
            ))}
          </BlocoProveniencia>
          <span className="text-xs">
            Não foi encaminhada ao agente. Se muda o escopo, use Pedir ajustes.
          </span>
        </Faixa>
      );
    }
    case 'conflito_destino': {
      const c = aprovacao.conflito;
      return (
        <Faixa
          tom="aviso"
          titulo={`Conflita com ${aprovacao.branch_destino} atual${c ? ` (${shaCurto(c.sha_destino)})` : ''}`}
        >
          <span>{alerta.mensagem}</span>
          <Detalhes itens={c?.arquivos ?? alerta.detalhes} mono />
          <span className="text-xs">Na fila de merge, o conflito vira "precisa de você".</span>
        </Faixa>
      );
    }
    case 'ui_sem_prints':
      return (
        <Faixa
          tom="aviso"
          titulo="Altera a interface sem prints"
          acoes={
            podeRecapturar && (
              <Button size="sm" variant="outline" onClick={aoRecapturar} disabled={recapturando}>
                Recapturar prints
              </Button>
            )
          }
        >
          <span>{alerta.mensagem}</span>
          <Detalhes itens={alerta.detalhes} />
        </Faixa>
      );
    default:
      return (
        <Faixa tom={tom} titulo={alerta.mensagem}>
          <Detalhes
            itens={alerta.detalhes}
            mono={alerta.tipo === 'sentinela' || alerta.tipo === 'negacoes_permissao'}
          />
        </Faixa>
      );
  }
}
