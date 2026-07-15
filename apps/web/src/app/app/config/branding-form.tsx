'use client';

import { useActionState, useState } from 'react';
import { avaliarCorMarca } from '@chamados/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acaoSalvarBranding, type EstadoConfig } from './actions';

const INICIAL: EstadoConfig = {};

interface Props {
  nomeExibicao: string;
  agenteIaNome: string;
  emailRemetenteNome: string;
  emailRemetenteEndereco: string;
  corPrimaria: string | null;
  corSecundaria: string | null;
}

interface SeletorCor {
  id: string;
  rotulo: string;
  ativa: boolean;
  setAtiva: (v: boolean) => void;
  cor: string;
  setCor: (v: string) => void;
  descricao: string;
}

function CampoCor({ s }: { s: SeletorCor }) {
  const aval = avaliarCorMarca(s.cor);
  const reprovada = s.ativa && !aval.ok;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={s.id}>{s.rotulo}</Label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name={`${s.id}_ativa`}
            checked={s.ativa}
            onChange={(e) => s.setAtiva(e.target.checked)}
            className="size-4 rounded border-input"
          />
          Aplicar cor personalizada
        </label>
      </div>
      <div className="flex items-center gap-3">
        <input
          id={s.id}
          name={s.id}
          type="color"
          value={s.cor}
          disabled={!s.ativa}
          onChange={(e) => s.setCor(e.target.value)}
          className="h-9 w-14 shrink-0 cursor-pointer rounded-md border border-input bg-transparent disabled:opacity-40"
        />
        <span className="font-mono text-sm text-muted-foreground">{s.cor}</span>
        {s.ativa && (
          <span
            className="ml-auto inline-flex items-center rounded-md px-3 py-1 text-xs font-medium"
            style={{ background: s.cor, color: aval.foreground }}
          >
            Amostra
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{s.descricao}</p>
      {reprovada && (
        <p className="text-xs text-destructive">
          Contraste {aval.razao.toFixed(2)}:1 sobre fundo claro, abaixo do mínimo AA (4.5:1).
          Escolha um tom mais escuro — a cor não será aplicada.
        </p>
      )}
    </div>
  );
}

export function BrandingForm(props: Props) {
  const [estado, acao, pendente] = useActionState(acaoSalvarBranding, INICIAL);
  const [corPrimariaAtiva, setCorPrimariaAtiva] = useState(props.corPrimaria !== null);
  const [corPrimaria, setCorPrimaria] = useState(props.corPrimaria ?? '#2563eb');
  const [corSecundariaAtiva, setCorSecundariaAtiva] = useState(props.corSecundaria !== null);
  const [corSecundaria, setCorSecundaria] = useState(props.corSecundaria ?? '#7c3aed');

  return (
    <form action={acao} className="flex flex-col gap-5">
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="nome_exibicao">Nome de exibição</Label>
          <Input
            id="nome_exibicao"
            name="nome_exibicao"
            defaultValue={props.nomeExibicao}
            required
            minLength={2}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="agente_ia_nome">Nome do assistente (IA)</Label>
          <Input
            id="agente_ia_nome"
            name="agente_ia_nome"
            defaultValue={props.agenteIaNome}
            placeholder="Assistente"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email_remetente_nome">Nome do remetente (e-mail)</Label>
          <Input
            id="email_remetente_nome"
            name="email_remetente_nome"
            defaultValue={props.emailRemetenteNome}
            placeholder={props.nomeExibicao}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email_remetente_endereco">E-mail do remetente</Label>
          <Input
            id="email_remetente_endereco"
            name="email_remetente_endereco"
            type="email"
            defaultValue={props.emailRemetenteEndereco}
            placeholder="no-reply@chamados.app"
          />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <CampoCor
          s={{
            id: 'cor_primaria',
            rotulo: 'Cor primária',
            ativa: corPrimariaAtiva,
            setAtiva: setCorPrimariaAtiva,
            cor: corPrimaria,
            setCor: setCorPrimaria,
            descricao: 'Botões, links e destaques.',
          }}
        />
        <CampoCor
          s={{
            id: 'cor_secundaria',
            rotulo: 'Cor de destaque',
            ativa: corSecundariaAtiva,
            setAtiva: setCorSecundariaAtiva,
            cor: corSecundaria,
            setCor: setCorSecundaria,
            descricao: 'Acentos secundários.',
          }}
        />
      </div>

      <div>
        <Button type="submit" disabled={pendente}>
          {pendente ? 'Salvando…' : 'Salvar identidade e cores'}
        </Button>
      </div>
    </form>
  );
}
