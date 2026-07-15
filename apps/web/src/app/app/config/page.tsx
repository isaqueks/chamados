import {
  obterAppDataSource,
  runInTenantContext,
  carregarTenant,
  buscarCanal,
  toWebhookView,
  CATALOGO_NOTIFICACOES,
  CanalNotificacaoTipo,
} from '@chamados/db';
import { Papel } from '@chamados/shared';
import { exigirPapel } from '@/lib/sessao';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { urlLogo } from '@/lib/branding';
import { BrandingForm } from './branding-form';
import { LogoForm } from './logos-form';
import { GeralForm } from './geral-form';
import { DominioForm } from './dominio-form';
import { NotificacoesForm } from './notificacoes-form';

export default async function ConfigPage() {
  const { tenant } = await exigirPapel(Papel.admin);
  const ds = await obterAppDataSource();
  const { t, webhook } = await runInTenantContext(ds, tenant.id, async (em) => ({
    t: await carregarTenant(em, tenant.id),
    webhook: toWebhookView(await buscarCanal(em, CanalNotificacaoTipo.webhook)),
  }));
  if (!t) return null;

  const b = t.config_branding ?? {};
  const eventos = Object.values(CATALOGO_NOTIFICACOES).map((c) => ({
    rotulo: c.rotulo,
    descricao: c.descricao,
    webhook: c.webhook !== null,
  }));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-sm text-muted-foreground">
          Marca, cores, logos, domínio e comportamento do tenant.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Identidade e cores</CardTitle>
          <CardDescription>
            Como o {t.nome_exibicao} aparece no portal, no painel e nos e-mails. As cores são
            validadas para contraste AA ao salvar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BrandingForm
            nomeExibicao={t.nome_exibicao}
            agenteIaNome={b.agente_ia_nome ?? 'Assistente'}
            emailRemetenteNome={b.email_remetente_nome ?? ''}
            emailRemetenteEndereco={b.email_remetente_endereco ?? ''}
            corPrimaria={b.cor_primaria ?? null}
            corSecundaria={b.cor_secundaria ?? null}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logos</CardTitle>
          <CardDescription>
            Exibidos no cabeçalho do portal e do painel. Use uma versão para tema claro e outra para
            tema escuro.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <LogoForm variante="light" rotulo="Logo (tema claro)" urlAtual={urlLogo(b, 'light')} />
            <LogoForm variante="dark" rotulo="Logo (tema escuro)" urlAtual={urlLogo(b, 'dark')} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Domínio próprio</CardTitle>
          <CardDescription>
            Acesse o suporte por um domínio da sua empresa (opcional).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DominioForm slug={t.slug} dominioAtual={t.dominio_proprio} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configurações gerais</CardTitle>
          <CardDescription>Prazo de fechamento automático e guardrails de IA.</CardDescription>
        </CardHeader>
        <CardContent>
          <GeralForm
            diasFechamento={t.dias_fechamento_automatico}
            iaResolucaoAuto={t.ia_resolucao_automatica_habilitada}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notificações</CardTitle>
          <CardDescription>
            E-mail (SMTP da plataforma) está sempre ativo. Configure um webhook para o seu sistema
            externo receber, por POST assinado (HMAC), cada atualização de chamado (D-003).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificacoesForm
            url={webhook.url}
            temSegredo={webhook.temSegredo}
            ativo={webhook.ativo}
            falhas={webhook.falhas_consecutivas}
            desativadoEm={webhook.desativado_em ? webhook.desativado_em.toISOString() : null}
            ultimoErro={webhook.ultimo_erro}
            eventos={eventos}
          />
        </CardContent>
      </Card>
    </div>
  );
}
