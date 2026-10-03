import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon, Loader2Icon, OctagonXIcon } from 'lucide-react';
import type { ConexaoDto, SalvarConexaoDto, TesteConexaoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Campo } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { Faixa } from '@/componentes/apoio/estrutura-tela';
import { formatarDataHora } from '@/componentes/apoio/texto';
import {
  avisoPapel,
  ehLocalhost,
  EXPLICACAO_ERRO_CONEXAO,
  formularioSimplesDe,
  montarConexaoSimples,
  type FormConexaoSimples,
} from './conexao';

/**
 * Formulário da conexão com o Chamados, simplificado (FJ-030 §5): URL, e-mail
 * e senha — o tenant só aparece quando o host é `localhost`. Um botão só,
 * "Testar e salvar": grava (a senha vai ao keyring e nunca volta) e já faz o
 * login, mostrando quem conectou ou a causa legível do erro. Usado na tela
 * Conexão e no passo 1 do onboarding.
 */

export function ResultadoTesteConexao({ r }: { r: TesteConexaoDto }) {
  if (r.ok) {
    const aviso = r.aviso ?? avisoPapel(r.usuario?.papel);
    return (
      <Faixa nivel="info" icone={CheckCircle2Icon}>
        Conectado como <span className="font-medium">{r.usuario?.nome ?? '—'}</span> (
        {r.usuario?.papel ?? '—'})
        {r.token_valido_ate ? ` · sessão válida até ${formatarDataHora(r.token_valido_ate)}` : ''}
        {aviso ? <span className="block text-amber-700 dark:text-amber-400">{aviso}</span> : null}
      </Faixa>
    );
  }
  const exp = r.erro ? EXPLICACAO_ERRO_CONEXAO[r.erro.codigo] : null;
  return (
    <Faixa nivel="erro" icone={OctagonXIcon}>
      <span className="font-medium">{exp?.causa ?? 'A conexão falhou.'}</span> {exp?.acao}
      {r.erro?.mensagem ? (
        <span className="block text-xs opacity-80">Detalhe: {r.erro.mensagem}</span>
      ) : null}
    </Faixa>
  );
}

export function FormConexao({
  conexao,
  aoConectar,
  rotuloBotao = 'Testar e salvar',
}: {
  conexao: ConexaoDto | null;
  /** Chamado quando o teste depois de salvar dá certo. */
  aoConectar?: (id: string, teste: TesteConexaoDto) => void;
  rotuloBotao?: string;
}) {
  const cliente = useQueryClient();
  const [form, setForm] = useState<FormConexaoSimples>(() => formularioSimplesDe(conexao));
  const [erros, setErros] = useState<Record<string, string>>({});
  const [teste, setTeste] = useState<TesteConexaoDto | null>(null);

  useEffect(() => {
    if (conexao) setForm(formularioSimplesDe(conexao));
  }, [conexao]);

  const mudar = <K extends keyof FormConexaoSimples>(k: K, v: FormConexaoSimples[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const testarESalvar = useComando({
    executar: async (dto: SalvarConexaoDto) => {
      const { id } = conexao
        ? await api('conexao_atualizar', { params: { id: conexao.id }, entrada: dto })
        : await api('conexao_criar', { entrada: dto });
      const r = await api('conexao_testar', { params: { id } });
      return { id, r };
    },
    invalidar: [['conexoes'], ['fila']],
    aoSucesso: ({ id, r }) => {
      setTeste(r);
      setForm((f) => ({ ...f, senha: '' }));
      void cliente.invalidateQueries({ queryKey: ['shell'] });
      if (r.ok) aoConectar?.(id, r);
    },
  });

  function aoEnviar(e: FormEvent) {
    e.preventDefault();
    const r = montarConexaoSimples(form, conexao);
    if (!r.ok) {
      setErros(r.erros);
      return;
    }
    setErros({});
    setTeste(null);
    testarESalvar.mutate(r.dto);
  }

  const local = ehLocalhost(form.url_base);

  return (
    <form className="flex flex-col gap-4" onSubmit={aoEnviar} noValidate>
      <Campo
        rotulo="Endereço do Chamados"
        erro={erros.url_base}
        ajuda={local ? 'Em dev, use localhost (nunca 127.0.0.1).' : undefined}
      >
        {(id) => (
          <Input
            id={id}
            value={form.url_base}
            onChange={(e) => mudar('url_base', e.target.value)}
            placeholder="https://chamados.suaempresa.com.br"
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="url"
            aria-invalid={erros.url_base ? true : undefined}
          />
        )}
      </Campo>
      {local && (
        <Campo
          rotulo="Tenant (opcional)"
          erro={erros.tenant_slug}
          ajuda="Slug do tenant: em localhost o endereço não identifica o tenant."
        >
          {(id) => (
            <Input
              id={id}
              value={form.tenant_slug}
              onChange={(e) => mudar('tenant_slug', e.target.value)}
              placeholder="demo"
              className="font-mono text-xs"
              spellCheck={false}
              aria-invalid={erros.tenant_slug ? true : undefined}
            />
          )}
        </Campo>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Campo rotulo="E-mail" erro={erros.email}>
          {(id) => (
            <Input
              id={id}
              type="email"
              value={form.email}
              onChange={(e) => mudar('email', e.target.value)}
              autoComplete="username"
              aria-invalid={erros.email ? true : undefined}
            />
          )}
        </Campo>
        <Campo
          rotulo="Senha"
          erro={erros.senha}
          ajuda={conexao ? 'Vazio = mantém a guardada.' : 'Fica no chaveiro do sistema.'}
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={form.senha}
              onChange={(e) => mudar('senha', e.target.value)}
              autoComplete={conexao ? 'new-password' : 'current-password'}
              aria-invalid={erros.senha ? true : undefined}
            />
          )}
        </Campo>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={testarESalvar.isPending}>
          {testarESalvar.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
          {rotuloBotao}
        </Button>
      </div>
      {teste && <ResultadoTesteConexao r={teste} />}
    </form>
  );
}
