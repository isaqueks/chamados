'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { SistemaAlvoResumo } from '@chamados/db';
import { acaoCriarSistema, acaoAtualizarSistema, type EstadoSistema } from './actions';

const INICIAL: EstadoSistema = {};

/** Campo de segredo: mascarado quando já existe; permite definir/substituir/remover. */
function CampoSegredo({
  name,
  label,
  temCredencial,
  descricao,
  edicao,
}: {
  name: string;
  label: string;
  temCredencial: boolean;
  descricao?: string;
  edicao: boolean;
}) {
  const [limpar, setLimpar] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      {edicao && temCredencial && (
        <p className="text-xs text-muted-foreground">
          Credencial salva: <span className="font-mono tracking-widest">••••••••</span> — deixe em
          branco para manter.
        </p>
      )}
      <Input
        id={name}
        name={name}
        type="password"
        autoComplete="new-password"
        placeholder={edicao && temCredencial ? 'Substituir credencial…' : 'Definir credencial…'}
        disabled={limpar}
      />
      {edicao && temCredencial && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name={`${name}_limpar`}
            checked={limpar}
            onChange={(e) => setLimpar(e.target.checked)}
            className="size-4 rounded border-input"
          />
          Remover a credencial salva
        </label>
      )}
      {descricao && <p className="text-xs text-muted-foreground">{descricao}</p>}
    </div>
  );
}

export function SistemaForm({
  sistema,
  permitirRepoLocal = false,
}: {
  sistema?: SistemaAlvoResumo;
  /** D-011: quando `true`, o repositório aceita caminho local absoluto/`file://`. */
  permitirRepoLocal?: boolean;
}) {
  const edicao = !!sistema;
  const [estado, acao, pendente] = useActionState(
    edicao ? acaoAtualizarSistema : acaoCriarSistema,
    INICIAL,
  );
  // Fonte de logs controla os campos exibidos (D-021); '' = sem fonte.
  const [logsTipo, setLogsTipo] = useState(sistema?.logs_tipo ?? '');

  return (
    <form action={acao} className="flex flex-col gap-6">
      {sistema && <input type="hidden" name="id" value={sistema.id} />}

      {estado.erro && (
        <Alert variant="destructive">
          <AlertDescription>{estado.erro}</AlertDescription>
        </Alert>
      )}

      {/* Identificação */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="nome">Nome *</Label>
          <Input id="nome" name="nome" defaultValue={sistema?.nome} required minLength={2} />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="ativo"
              defaultChecked={sistema ? sistema.ativo : true}
              className="size-4 rounded border-input"
            />
            Ativo (selecionável na abertura de chamados)
          </label>
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="descricao">Descrição</Label>
          <textarea
            id="descricao"
            name="descricao"
            defaultValue={sistema?.descricao ?? ''}
            rows={2}
            className="flex w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </div>
      </div>

      {/* Repositório git */}
      <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">Repositório git</legend>
        {permitirRepoLocal && (
          <Alert>
            <AlertDescription>
              Repositório local habilitado: você pode informar um caminho absoluto (ex.:{' '}
              <code>C:\repos\meu-sistema</code>). Credencial git é dispensável nesse caso. Em
              produção com Docker, monte o diretório como volume no worker.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="git_repo_url">URL do repositório *</Label>
            <Input
              id="git_repo_url"
              name="git_repo_url"
              defaultValue={sistema?.git_repo_url}
              placeholder={
                permitirRepoLocal
                  ? 'https://github.com/empresa/erp.git ou C:\\repos\\meu-sistema'
                  : 'https://github.com/empresa/erp.git'
              }
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="git_branch_padrao">Branch padrão</Label>
            <Input
              id="git_branch_padrao"
              name="git_branch_padrao"
              defaultValue={sistema?.git_branch_padrao ?? 'main'}
              placeholder="main"
            />
          </div>
        </div>
        <CampoSegredo
          name="git_credencial"
          label="Credencial de acesso ao repositório"
          temCredencial={sistema?.tem_git_credencial ?? false}
          descricao="Token de acesso ou chave. Guardada cifrada no cofre — nunca exibida."
          edicao={edicao}
        />
      </fieldset>

      {/* Logs (D-021: fontes suportadas — arquivo local do worker ou SFTP) */}
      <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">Logs</legend>
        <div className="flex max-w-xs flex-col gap-2">
          <Label htmlFor="logs_tipo">Fonte de logs</Label>
          <select
            id="logs_tipo"
            name="logs_tipo"
            value={logsTipo}
            onChange={(e) => setLogsTipo(e.target.value)}
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <option value="">Sem fonte de logs</option>
            <option value="arquivo">Arquivo local (no servidor do worker)</option>
            <option value="sftp">SFTP (servidor remoto)</option>
          </select>
        </div>

        {logsTipo === 'sftp' && (
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="logs_host">Host SFTP *</Label>
              <Input
                id="logs_host"
                name="logs_host"
                defaultValue={String(sistema?.logs_config?.host ?? '')}
                placeholder="servidor.empresa.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="logs_porta">Porta</Label>
              <Input
                id="logs_porta"
                name="logs_porta"
                type="number"
                min={1}
                max={65535}
                defaultValue={String(sistema?.logs_config?.porta ?? '')}
                placeholder="22"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="logs_usuario">Usuário *</Label>
              <Input
                id="logs_usuario"
                name="logs_usuario"
                defaultValue={String(sistema?.logs_config?.usuario ?? '')}
                autoComplete="off"
              />
            </div>
          </div>
        )}

        {(logsTipo === 'arquivo' || logsTipo === 'sftp') && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="logs_caminho">
              {logsTipo === 'sftp' ? 'Diretório remoto dos logs *' : 'Caminho dos logs *'}
            </Label>
            <Input
              id="logs_caminho"
              name="logs_caminho"
              defaultValue={String(sistema?.logs_config?.caminho ?? '')}
              placeholder={
                logsTipo === 'sftp'
                  ? '/var/log/meu-sistema ou /var/log/app/*.log'
                  : '/var/log/app/*.log'
              }
            />
            <p className="text-xs text-muted-foreground">
              Arquivo único, diretório ou padrão simples com <code className="font-mono">*</code>{' '}
              (um nível). A IA lê apenas o final dos arquivos, com limites de volume.
            </p>
          </div>
        )}

        <CampoSegredo
          name="logs_credencial"
          label={
            logsTipo === 'sftp' ? 'Senha ou chave privada (SFTP)' : 'Credencial de acesso aos logs'
          }
          temCredencial={sistema?.tem_logs_credencial ?? false}
          descricao={
            logsTipo === 'sftp'
              ? 'Senha do usuário OU chave privada (PEM, começa com "-----BEGIN"). Guardada cifrada no cofre — nunca exibida.'
              : undefined
          }
          edicao={edicao}
        />
      </fieldset>

      {/* Banco de dados (read-only) */}
      <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">Banco de dados</legend>
        <Alert>
          <AlertDescription>
            Use um usuário <strong>somente leitura</strong>. A plataforma só executa
            <code> SELECT</code>, mas não impõe isso no seu banco — configure um usuário read-only
            dedicado e revogável.
          </AlertDescription>
        </Alert>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bd_tipo">SGBD</Label>
            <Input
              id="bd_tipo"
              name="bd_tipo"
              defaultValue={sistema?.bd_tipo ?? ''}
              placeholder="postgres"
            />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="bd_host">Host</Label>
            <Input id="bd_host" name="bd_host" defaultValue={sistema?.bd_host ?? ''} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bd_porta">Porta</Label>
            <Input
              id="bd_porta"
              name="bd_porta"
              type="number"
              min={1}
              max={65535}
              defaultValue={sistema?.bd_porta ?? ''}
              placeholder="5432"
            />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="bd_nome">Nome do banco</Label>
            <Input id="bd_nome" name="bd_nome" defaultValue={sistema?.bd_nome ?? ''} />
          </div>
        </div>
        <CampoSegredo
          name="bd_credencial"
          label="Credencial do BD (usuário/senha read-only)"
          temCredencial={sistema?.tem_bd_credencial ?? false}
          descricao="Ex.: usuario:senha. Guardada cifrada no cofre — nunca exibida."
          edicao={edicao}
        />
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pendente}>
          {pendente ? 'Salvando…' : edicao ? 'Salvar alterações' : 'Cadastrar sistema-alvo'}
        </Button>
        <Link
          href="/app/sistemas"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Cancelar
        </Link>
      </div>
    </form>
  );
}
