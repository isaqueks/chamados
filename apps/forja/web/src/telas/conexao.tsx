import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRoundIcon, OctagonXIcon, PlusIcon } from 'lucide-react';
import type { ConexaoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Campo } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Faixa,
  Pagina,
} from '@/componentes/apoio/estrutura-tela';
import { formatarDataHora } from '@/componentes/apoio/texto';
import { avisoPapel, EXPLICACAO_ERRO_CONEXAO } from '@/componentes/projeto/conexao';
import { FormConexao } from '@/componentes/projeto/form-conexao';

/**
 * Conexão com o Chamados (specs/forja/06 §4.9, simplificada pela FJ-030 §5):
 * URL, e-mail, senha e "Testar e salvar" — o tenant só aparece em
 * `localhost`. Nome, ambiente e onde guardar a senha são derivados
 * (`montarConexaoSimples`). A senha vai ao keyring e nunca volta; o token
 * nunca aparece — só usuário, papel e validade da sessão.
 */

const CHAVE = ['conexoes'];

function Situacao({ c }: { c: ConexaoDto }) {
  const exp = c.erro ? EXPLICACAO_ERRO_CONEXAO[c.erro.codigo] : null;
  const papel = avisoPapel(c.usuario?.papel);
  const avisos = [...(papel ? [papel] : []), ...c.avisos];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        <span
          className={cn(
            'font-medium',
            c.estado === 'ok' && 'text-emerald-700 dark:text-emerald-400',
            c.estado === 'erro' && 'text-rose-700 dark:text-rose-300',
          )}
        >
          {c.estado === 'ok' ? 'Conectado' : c.estado === 'sem_login' ? 'Sem login' : 'Com erro'}
        </span>
        {c.usuario && (
          <span className="text-muted-foreground">
            {' '}
            como {c.usuario.nome} ({c.usuario.papel})
          </span>
        )}
        {c.token_valido_ate && (
          <span className="text-muted-foreground">
            {' '}
            · sessão até {formatarDataHora(c.token_valido_ate)}
          </span>
        )}
      </p>
      {exp && (
        <Faixa nivel="erro" icone={OctagonXIcon}>
          <span className="font-medium">{exp.causa}</span> {exp.acao}
          {c.erro?.mensagem ? (
            <span className="block text-xs opacity-80">Detalhe: {c.erro.mensagem}</span>
          ) : null}
        </Faixa>
      )}
      {avisos.map((a) => (
        <Faixa key={a} nivel="aviso">
          {a}
        </Faixa>
      ))}
    </div>
  );
}

function CartaoConexao({ c }: { c: ConexaoDto }) {
  const [relogar, setRelogar] = useState(false);
  const [senha, setSenha] = useState('');
  const [esquecer, setEsquecer] = useState(false);

  const relogin = useComando({
    executar: () =>
      api('conexao_relogar', { params: { id: c.id }, entrada: senha ? { senha } : {} }),
    invalidar: [CHAVE],
    sucesso: (r) => (r.ok ? 'Login refeito' : null),
    aoSucesso: () => {
      setRelogar(false);
      setSenha('');
    },
  });
  const esquecerCmd = useComando({
    executar: () => api('conexao_esquecer', { params: { id: c.id } }),
    invalidar: [CHAVE],
    sucesso: 'Credenciais esquecidas: senha e sessão removidas',
    aoSucesso: () => setEsquecer(false),
  });

  return (
    <Card className={cn(c.ambiente === 'producao' && 'border-rose-200 dark:border-rose-900/60')}>
      <CardHeader>
        <CardTitle className="font-mono text-sm">
          {c.url_base}
          {c.tenant_slug ? <span className="text-muted-foreground"> · {c.tenant_slug}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Situacao c={c} />
        <FormConexao conexao={c} />
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button variant="outline" size="sm" onClick={() => setRelogar(true)}>
            <KeyRoundIcon aria-hidden />
            Relogar
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEsquecer(true)}>
            Esquecer credenciais…
          </Button>
        </div>
      </CardContent>

      <DialogoConfirmacao
        aberto={relogar}
        aoMudarAberto={setRelogar}
        titulo="Relogar no Chamados"
        descricao="Faz login de novo. O Chamados limita tentativas de login: evite repetir em sequência."
        rotuloConfirmar="Relogar"
        pendente={relogin.isPending}
        aoConfirmar={() => relogin.mutate(undefined)}
      >
        <Campo
          rotulo="Senha (opcional)"
          ajuda={
            c.local_senha === 'nao_guardada'
              ? 'A senha não está guardada: informe-a.'
              : 'Vazio = usa a senha guardada.'
          }
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              autoComplete="new-password"
            />
          )}
        </Campo>
      </DialogoConfirmacao>

      <DialogoConfirmacao
        aberto={esquecer}
        aoMudarAberto={setEsquecer}
        titulo="Esquecer as credenciais?"
        descricao="Remove a senha guardada e a sessão. Sem login, a Fila deixa de sincronizar e nenhuma execução nova começa até você relogar."
        rotuloConfirmar="Esquecer credenciais"
        destrutivo
        pendente={esquecerCmd.isPending}
        aoConfirmar={() => esquecerCmd.mutate(undefined)}
      />
    </Card>
  );
}

export function TelaConexao() {
  const consulta = useQuery({
    queryKey: CHAVE,
    queryFn: ({ signal }) => api('conexoes_listar', { sinal: signal }),
  });
  const [nova, setNova] = useState(false);
  const conexoes = consulta.data?.conexoes ?? [];

  return (
    <Pagina>
      <CabecalhoPagina
        titulo="Conexão com o Chamados"
        descricao="O mesmo login que você usa no Chamados. A senha fica no chaveiro do sistema."
        acoes={
          conexoes.length > 0 &&
          !nova && (
            <Button variant="outline" onClick={() => setNova(true)}>
              <PlusIcon aria-hidden />
              Outra conexão
            </Button>
          )
        }
      />
      {consulta.isPending ? (
        <Carregando linhas={3} />
      ) : consulta.isError ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : (
        <>
          {(conexoes.length === 0 || nova) && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {conexoes.length === 0 ? 'Conectar ao Chamados' : 'Outra conexão'}
                </CardTitle>
                <CardDescription>
                  As mensagens públicas que a Forja publicar saem em nome deste usuário.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FormConexao conexao={null} aoConectar={() => setNova(false)} />
              </CardContent>
            </Card>
          )}
          {conexoes.map((c) => (
            <CartaoConexao key={c.id} c={c} />
          ))}
        </>
      )}
    </Pagina>
  );
}
