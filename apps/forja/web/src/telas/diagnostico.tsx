import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  OctagonXIcon,
  PlayIcon,
  ShieldIcon,
} from 'lucide-react';
import type { ItemDiagnosticoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Faixa,
  Pagina,
  RotuloCalculado,
} from '@/componentes/apoio/estrutura-tela';
import { formatarRelativo } from '@/componentes/apoio/texto';
import {
  itemBloqueante,
  ordenarItens,
  resumirDiagnostico,
  ROTULO_BLOQUEIO,
  ROTULO_ESTADO_ITEM,
  situacaoCli,
} from '@/componentes/diagnostico/logica';

/**
 * Diagnóstico (specs/forja/06 §4.10; smoke de compatibilidade em 01 §7).
 *
 * Lista de verificações com estado ✓/⚠/✗ (ícone + texto, nunca só cor), o
 * detalhe, se BLOQUEIA ou é informativa, e a ação. Roda no boot e sob demanda
 * ([Rodar tudo]). No topo, a faixa permanente e neutra sobre o agente rodar
 * sem sandbox (U-3, F-04) — é um risco aceito, não um erro, e por isso não é
 * vermelha.
 */

const ICONE_ESTADO: Record<
  ItemDiagnosticoDto['estado'],
  { icone: typeof CheckCircle2Icon; classe: string }
> = {
  ok: { icone: CheckCircle2Icon, classe: 'text-emerald-700 dark:text-emerald-400' },
  aviso: { icone: AlertTriangleIcon, classe: 'text-amber-700 dark:text-amber-400' },
  erro: { icone: OctagonXIcon, classe: 'text-rose-700 dark:text-rose-300' },
  pendente: { icone: Loader2Icon, classe: 'text-muted-foreground' },
};

function LinhaItem({ item }: { item: ItemDiagnosticoDto }) {
  const v = ICONE_ESTADO[item.estado];
  const Icone = v.icone;
  const bloqueante = itemBloqueante(item);
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-3">
      <span className={cn('flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium', v.classe)}>
        <Icone
          className={cn(
            'size-4',
            item.estado === 'pendente' && 'animate-spin motion-reduce:animate-none',
          )}
          aria-hidden
        />
        {ROTULO_ESTADO_ITEM[item.estado]}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{item.titulo}</span>
        <span className="text-sm whitespace-pre-wrap text-muted-foreground">{item.detalhe}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span
          className={cn(
            'text-xs',
            bloqueante ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-muted-foreground',
          )}
        >
          {item.bloqueia ? ROTULO_BLOQUEIO[item.bloqueia] : 'informativa'}
        </span>
        {item.acao && (
          <Link to={item.acao.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {item.acao.rotulo}
          </Link>
        )}
      </div>
    </li>
  );
}

export function TelaDiagnostico() {
  const cliente = useQueryClient();
  const [aceitar, setAceitar] = useState(false);
  const consulta = useQuery({
    queryKey: ['diagnostico'],
    queryFn: ({ signal }) => api('diagnostico_obter', { sinal: signal }),
    refetchInterval: (q) =>
      (q.state.data?.itens ?? []).some((i) => i.estado === 'pendente') ? 2_000 : false,
  });
  const rodar = useComando({
    executar: () => api('diagnostico_rodar'),
    sucesso: 'Diagnóstico concluído',
    aoSucesso: (d) => cliente.setQueryData(['diagnostico'], d),
  });
  const aceitarVersao = useComando({
    executar: (versao: string) => api('diagnostico_aceitar_versao_cli', { entrada: { versao } }),
    sucesso: 'Versão aceita após o smoke de compatibilidade',
    aoSucesso: (d) => {
      cliente.setQueryData(['diagnostico'], d);
      setAceitar(false);
    },
  });

  const dto = consulta.data;
  const itens = dto ? ordenarItens(dto.itens) : [];
  const resumo = resumirDiagnostico(dto?.itens ?? []);
  const cli = dto ? situacaoCli(dto.versao_cli) : null;
  const reforcadoAtivo = dto?.faixa.startsWith('modo reforçado ativo') ?? false;

  return (
    <Pagina>
      <CabecalhoPagina
        titulo="Diagnóstico"
        descricao={
          dto?.verificado_em
            ? `Ambiente, CLI e riscos aceitos · verificado ${formatarRelativo(dto.verificado_em)}`
            : 'Ambiente, CLI e riscos aceitos.'
        }
        acoes={
          <Button disabled={rodar.isPending} onClick={() => rodar.mutate(undefined)}>
            {rodar.isPending ? (
              <Loader2Icon className="animate-spin" aria-hidden />
            ) : (
              <PlayIcon aria-hidden />
            )}
            Rodar tudo
          </Button>
        }
      />

      {dto && (
        <Faixa
          nivel="info"
          icone={ShieldIcon}
          acoes={
            !reforcadoAtivo && (
              <Link to="/projetos" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Ligar modo reforçado em Projeto
              </Link>
            )
          }
        >
          {dto.faixa}
        </Faixa>
      )}

      {consulta.isPending ? (
        <Carregando linhas={6} />
      ) : consulta.isError || !dto ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : (
        <>
          {dto.pipeline_bloqueado ? (
            <Faixa nivel="erro" icone={OctagonXIcon}>
              <span className="font-medium">Pipeline bloqueado.</span>{' '}
              {resumo.bloqueantes === 1
                ? '1 verificação impede iniciar execuções.'
                : `${resumo.bloqueantes} verificações impedem iniciar execuções.`}{' '}
              Corrija os itens em vermelho e rode de novo.
            </Faixa>
          ) : (
            <p className="text-sm text-muted-foreground">
              {resumo.ok} ok · {resumo.avisos} com atenção · {resumo.erros} com falha
              {resumo.pendentes ? ` · ${resumo.pendentes} verificando` : ''}
            </p>
          )}

          <Card className="gap-4">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                CLI do Claude Code <RotuloCalculado />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">Instalada</dt>
                  <dd className="font-mono">{dto.versao_cli.encontrada ?? 'não encontrada'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Fixada</dt>
                  <dd className="font-mono">{dto.versao_cli.fixada}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Smoke de compatibilidade</dt>
                  <dd>{dto.versao_cli.smoke_aprovado ? 'aprovado' : 'não aprovado'}</dd>
                </div>
              </dl>
              {cli === 'ausente' && (
                <Faixa nivel="erro" icone={OctagonXIcon}>
                  O comando <span className="font-mono">claude</span> não foi encontrado no PATH do
                  servidor da Forja.
                </Faixa>
              )}
              {cli === 'diverge_bloqueia' && dto.versao_cli.encontrada && (
                <Faixa
                  nivel="erro"
                  icone={OctagonXIcon}
                  acoes={
                    <Button variant="outline" size="sm" onClick={() => setAceitar(true)}>
                      Aceitar {dto.versao_cli.encontrada}…
                    </Button>
                  }
                >
                  A versão instalada difere da fixada e o smoke ainda não passou: o pipeline fica
                  bloqueado.
                </Faixa>
              )}
              {cli === 'diverge_aprovada' && (
                <p className="text-xs text-muted-foreground">
                  Versão diferente da fixada, mas o smoke de compatibilidade passou.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 py-0">
            <ul className="divide-y">
              {itens.map((i) => (
                <LinhaItem key={i.codigo} item={i} />
              ))}
            </ul>
          </Card>

          {dto.versao_cli.encontrada && (
            <DialogoConfirmacao
              aberto={aceitar}
              aoMudarAberto={setAceitar}
              titulo={`Aceitar a CLI ${dto.versao_cli.encontrada}?`}
              descricao="A Forja roda o smoke de compatibilidade (capabilities do system/init) contra a versão instalada. Se passar, ela vira a versão fixada e o pipeline é desbloqueado."
              rotuloConfirmar="Rodar smoke e aceitar"
              pendente={aceitarVersao.isPending}
              aoConfirmar={() => aceitarVersao.mutate(dto.versao_cli.encontrada ?? '')}
            />
          )}
        </>
      )}
    </Pagina>
  );
}
