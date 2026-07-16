import Link from 'next/link';
import {
  ArrowUpRight,
  AlertTriangle,
  Clock,
  GitPullRequest,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import {
  obterAppDataSource,
  runInTenantContext,
  metricasDashboard,
  blocosPrecisaDeVoce,
  prsIaAguardandoRevisao,
  type ItemAcionavel,
  type ItemPrIa,
} from '@chamados/db';
import { StatusChamado, Papel } from '@chamados/shared';
import { exigirUsuario } from '@/lib/sessao';
import { PrioridadeBadge, StatusBadge } from '@/components/chamado/badges';
import { tempoRelativo, duracaoMin } from '@/lib/tempo';
import { cn } from '@/lib/utils';

export default async function DashboardPage() {
  const { usuario, tenant } = await exigirUsuario();
  const ds = await obterAppDataSource();

  const { metricas, blocos, prsIa } = await runInTenantContext(ds, tenant.id, async (em) => ({
    metricas: await metricasDashboard(em, usuario),
    blocos: await blocosPrecisaDeVoce(em, usuario),
    prsIa: await prsIaAguardandoRevisao(em, usuario),
  }));

  const primeiroNome = usuario.nome.split(' ')[0];
  const nomeAssistente = tenant.config_branding?.agente_ia_nome ?? 'assistente';
  const semAcoes = blocos.urgentesSemAtribuicao.length === 0 && blocos.paradosHaMuito.length === 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Olá, {primeiroNome}</h1>
        <p className="text-sm text-muted-foreground">
          Panorama do atendimento em {tenant.nome_exibicao}.
        </p>
      </div>

      {/* KPIs principais */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CardMetrica
          rotulo="Novos"
          valor={metricas.porStatus[StatusChamado.novo]}
          href="/app/chamados?status=novo"
        />
        <CardMetrica
          rotulo="Em atendimento"
          valor={metricas.porStatus[StatusChamado.em_atendimento]}
          href="/app/chamados?status=em_atendimento"
        />
        <CardMetrica
          rotulo="Aguardando cliente"
          valor={metricas.porStatus[StatusChamado.aguardando_cliente]}
          href="/app/chamados?status=aguardando_cliente"
        />
        <CardMetrica
          rotulo="Resolvidos (7 dias)"
          valor={metricas.resolvidosSemana}
          href="/app/chamados?status=resolvido"
        />
      </div>

      {/* KPIs secundários */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CardMetricaLeve rotulo="Backlog aberto" valor={String(metricas.backlogAberto)} />
        <CardMetricaLeve
          rotulo="Tempo médio 1ª resposta"
          valor={
            metricas.tempoMedioPrimeiraRespostaMin === null
              ? '—'
              : duracaoMin(metricas.tempoMedioPrimeiraRespostaMin)
          }
        />
        <CardMetricaLeve
          rotulo="Urgentes sem dono"
          valor={String(metricas.urgentesSemAtribuicao)}
          alerta={metricas.urgentesSemAtribuicao > 0}
        />
        <CardMetricaLeve
          rotulo="Aguardando +48h"
          valor={String(metricas.aguardandoClienteAtrasado)}
          alerta={metricas.aguardandoClienteAtrasado > 0}
        />
      </div>

      {/* Precisa de você */}
      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-lg font-semibold tracking-tight">Precisa de você</h2>

        {semAcoes ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card py-12 text-center">
            <CheckCircle2 className="size-6 text-emerald-500" />
            <p className="font-medium">Tudo sob controle</p>
            <p className="text-sm text-muted-foreground">
              Nenhum chamado urgente sem dono nem parado há muito tempo.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <BlocoAcionavel
              titulo="Urgentes sem atribuição"
              icone={<AlertTriangle className="size-4 text-red-500" />}
              itens={blocos.urgentesSemAtribuicao}
              vazio="Nenhum urgente sem dono."
              href="/app/chamados?prioridade=urgente&atribuicao=nao_atribuidos"
            />
            <BlocoAcionavel
              titulo="Parados há mais de 48h"
              icone={<Clock className="size-4 text-amber-500" />}
              itens={blocos.paradosHaMuito}
              vazio="Nada parado por muito tempo."
              href="/app/chamados"
            />
          </div>
        )}

        {/* PRs da IA aguardando revisão (M8 — specs/05 §6) */}
        <BlocoPrsIa itens={prsIa} nomeAssistente={nomeAssistente} />
      </section>

      {usuario.papel === Papel.admin && (
        <p className="text-xs text-muted-foreground">
          Como administrador, você também gerencia usuários, sistemas-alvo, categorias e
          configurações pela navegação lateral.
        </p>
      )}
    </div>
  );
}

function CardMetrica({ rotulo, valor, href }: { rotulo: string; valor: number; href: string }) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 rounded-xl border bg-card p-4 shadow-cartao transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-cartao-hover"
    >
      <span className="flex items-center justify-between text-sm text-muted-foreground">
        {rotulo}
        <ArrowUpRight className="size-4 opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="font-heading text-3xl font-semibold tabular-nums">{valor}</span>
    </Link>
  );
}

function CardMetricaLeve({
  rotulo,
  valor,
  alerta,
}: {
  rotulo: string;
  valor: string;
  alerta?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4 shadow-cartao">
      <span className="text-sm text-muted-foreground">{rotulo}</span>
      <span
        className={cn(
          'font-heading text-2xl font-semibold tabular-nums',
          alerta && 'text-red-600 dark:text-red-400',
        )}
      >
        {valor}
      </span>
    </div>
  );
}

function BlocoPrsIa({ itens, nomeAssistente }: { itens: ItemPrIa[]; nomeAssistente: string }) {
  return (
    <div className="flex flex-col rounded-xl border bg-card shadow-cartao">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <GitPullRequest className="size-4 text-violet-500" />
        <h3 className="text-sm font-semibold">PRs do {nomeAssistente} aguardando revisão</h3>
        {itens.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{itens.length}</span>
        )}
      </div>
      {itens.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          Nenhum PR da IA aguardando revisão. Correções automáticas de problemas fáceis aparecem
          aqui — o merge é sempre manual.
        </p>
      ) : (
        <ul className="divide-y">
          {itens.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <Link
                href={`/app/chamados/${c.id}`}
                className="flex min-w-0 flex-1 items-center gap-3 transition-colors hover:opacity-80"
              >
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  #{c.numero}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.titulo}</span>
                <PrioridadeBadge prioridade={c.prioridade} />
                <StatusBadge status={c.status} className="hidden sm:inline-flex" />
                <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                  {tempoRelativo(c.aberto_em)}
                </span>
              </Link>
              {c.prUrl ? (
                <a
                  href={c.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
                  title="Abrir Pull Request"
                >
                  PR <ExternalLink className="size-3" />
                </a>
              ) : (
                c.branch && (
                  <span
                    className="hidden shrink-0 rounded-md border px-2 py-1 font-mono text-[11px] text-muted-foreground lg:inline"
                    title="Branch publicada — abra o PR manualmente"
                  >
                    {c.branch}
                  </span>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BlocoAcionavel({
  titulo,
  icone,
  itens,
  vazio,
  href,
}: {
  titulo: string;
  icone: React.ReactNode;
  itens: ItemAcionavel[];
  vazio: string;
  href: string;
}) {
  return (
    <div className="flex flex-col rounded-xl border bg-card shadow-cartao">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {icone}
          {titulo}
        </h3>
        <Link href={href} className="text-xs text-muted-foreground hover:text-foreground">
          Ver todos
        </Link>
      </div>
      {itens.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{vazio}</p>
      ) : (
        <ul className="divide-y">
          {itens.map((c) => (
            <li key={c.id}>
              <Link
                href={`/app/chamados/${c.id}`}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
              >
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  #{c.numero}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.titulo}</span>
                <PrioridadeBadge prioridade={c.prioridade} />
                <StatusBadge status={c.status} className="hidden sm:inline-flex" />
                <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                  {tempoRelativo(c.updated_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
