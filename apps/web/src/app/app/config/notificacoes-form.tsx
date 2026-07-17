'use client';

import { useActionState, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  acaoSalvarWebhook,
  acaoTestarWebhook,
  type EstadoConfig,
  type ResultadoTeste,
} from './actions';

const INICIAL: EstadoConfig = {};

export interface EventoNotificavelInfo {
  rotulo: string;
  descricao: string;
  webhook: boolean;
}

interface Props {
  url: string;
  temSegredo: boolean;
  ativo: boolean;
  falhas: number;
  desativadoEm: string | null;
  ultimoErro: string | null;
  eventos: EventoNotificavelInfo[];
}

export function NotificacoesForm({
  url,
  temSegredo,
  ativo,
  falhas,
  desativadoEm,
  ultimoErro,
  eventos,
}: Props) {
  const [estado, acao, pendente] = useActionState(acaoSalvarWebhook, INICIAL);
  const [teste, setTeste] = useState<ResultadoTeste | null>(null);
  const [testando, iniciarTeste] = useTransition();

  return (
    <div className="flex flex-col gap-6">
      {desativadoEm && (
        <Alert variant="destructive">
          <AlertDescription>
            O webhook foi <strong>desativado automaticamente</strong> após falhas consecutivas de
            entrega. Corrija o endpoint e salve com “Ativo” marcado para reativar.
            {ultimoErro ? ` Último erro: ${ultimoErro}.` : ''}
          </AlertDescription>
        </Alert>
      )}

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

        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor="url">URL do endpoint</Label>
          <Input
            id="url"
            name="url"
            type="url"
            defaultValue={url}
            placeholder="https://seu-sistema.com/webhooks/chamados"
          />
          <p className="text-xs text-muted-foreground">
            Recebe um <code className="font-mono">POST</code> JSON a cada atualização de chamado.
            Use HTTPS em produção.
          </p>
        </div>

        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor="segredo">Segredo (assinatura HMAC SHA-256)</Label>
          <Input
            id="segredo"
            name="segredo"
            type="password"
            autoComplete="off"
            placeholder={
              temSegredo
                ? '•••••••• (mantém o atual — preencha para substituir)'
                : 'Defina um segredo forte'
            }
          />
          <p className="text-xs text-muted-foreground">
            Usado para assinar o corpo em <code className="font-mono">X-Chamados-Signature</code>.
            Guardado cifrado; nunca é exibido.{' '}
            {temSegredo ? 'Já configurado.' : 'Ainda não configurado.'}
          </p>
        </div>

        <label className="flex items-center gap-3">
          <Switch name="ativo" defaultChecked={ativo} />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Webhook ativo</span>
            <span className="text-xs text-muted-foreground">
              Falhas consecutivas: {falhas}. Ao atingir o limite, o canal é desativado e os admins
              recebem um alerta por e-mail.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pendente}>
            {pendente ? 'Salvando…' : 'Salvar webhook'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={testando}
            onClick={() =>
              iniciarTeste(async () => {
                setTeste(await acaoTestarWebhook());
              })
            }
          >
            {testando ? 'Enviando…' : 'Enviar evento de teste'}
          </Button>
          <Badge variant={ativo ? 'default' : 'secondary'}>{ativo ? 'Ativo' : 'Desativado'}</Badge>
        </div>

        {teste && (
          <Alert variant={teste.ok ? 'success' : 'destructive'}>
            <AlertDescription>{teste.msg}</AlertDescription>
          </Alert>
        )}
      </form>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Eventos notificáveis</h3>
        <p className="text-xs text-muted-foreground">
          Eventos que geram notificação por e-mail e/ou webhook (specs/06). O webhook nunca inclui
          conteúdo interno (notas, complexidade).
        </p>
        <ul className="mt-1 flex flex-col divide-y rounded-md border">
          {eventos.map((e) => (
            <li key={e.rotulo} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex flex-col">
                <span className="text-sm">{e.rotulo}</span>
                <span className="text-xs text-muted-foreground">{e.descricao}</span>
              </span>
              {e.webhook ? (
                <Badge variant="secondary">webhook</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">só e-mail</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
