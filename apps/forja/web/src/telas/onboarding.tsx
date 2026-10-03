import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Carregando, ErroCarregar } from '@/componentes/apoio/estrutura-tela';
import { passoInicial, type PassoOnboarding } from '@/componentes/onboarding/logica';
import { FormConexao } from '@/componentes/projeto/form-conexao';
import { FormularioProjeto } from '@/componentes/projeto/formulario-projeto';

/**
 * Onboarding em 2 passos (FJ-030 §5): Conexão → Projeto → Fila. Pede só o
 * que não dá para adivinhar — endereço, e-mail e senha do Chamados, e a pasta
 * do repositório. Branch, comandos, detectores, arquivos locais e sistemas-
 * alvo são detectados e mostrados para conferir; "Pronto" leva à Fila.
 */

const PASSOS: { id: PassoOnboarding; rotulo: string }[] = [
  { id: 'conexao', rotulo: 'Conexão' },
  { id: 'projeto', rotulo: 'Projeto' },
];

function Trilha({ atual, feitos }: { atual: PassoOnboarding; feitos: Set<PassoOnboarding> }) {
  return (
    <ol className="flex items-center gap-3 text-sm" aria-label="Passos">
      {PASSOS.map((p, i) => {
        const feito = feitos.has(p.id);
        const ativo = p.id === atual;
        return (
          <li key={p.id} className="flex items-center gap-3">
            {i > 0 && <span className="h-px w-8 bg-border" aria-hidden />}
            <span
              className={cn(
                'flex items-center gap-2',
                ativo ? 'font-medium' : 'text-muted-foreground',
              )}
              aria-current={ativo ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border text-xs tabular-nums',
                  ativo && 'border-primary bg-primary text-primary-foreground',
                  feito && !ativo && 'border-emerald-500 text-emerald-700 dark:text-emerald-400',
                )}
              >
                {feito && !ativo ? <CheckIcon className="size-3.5" aria-label="feito" /> : i + 1}
              </span>
              {p.rotulo}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function TelaOnboarding() {
  const navegar = useNavigate();
  const conexoes = useQuery({
    queryKey: ['conexoes'],
    queryFn: ({ signal }) => api('conexoes_listar', { sinal: signal }),
  });
  const [passo, setPasso] = useState<PassoOnboarding | null>(null);
  const [conexaoId, setConexaoId] = useState<string | null>(null);

  // O passo inicial só é decidido uma vez, quando as conexões chegam.
  useEffect(() => {
    if (passo === null && conexoes.data) setPasso(passoInicial(conexoes.data.conexoes));
  }, [passo, conexoes.data]);

  const lista = conexoes.data?.conexoes ?? [];
  const existente = lista[0] ?? null;
  const conexaoDoProjeto =
    conexaoId ?? lista.find((c) => c.estado === 'ok')?.id ?? existente?.id ?? null;
  const feitos = new Set<PassoOnboarding>(
    conexaoDoProjeto && passo === 'projeto' ? ['conexao'] : [],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Bem-vindo à Forja</h1>
        <p className="text-sm text-muted-foreground">
          Dois passos e a Fila passa a mostrar os chamados que dá para implementar. O resto a Forja
          descobre sozinha.
        </p>
        {passo && <Trilha atual={passo} feitos={feitos} />}
      </div>

      {conexoes.isPending || passo === null ? (
        conexoes.isError ? (
          <ErroCarregar erro={conexoes.error} tentarDeNovo={() => void conexoes.refetch()} />
        ) : (
          <Carregando linhas={3} />
        )
      ) : passo === 'conexao' ? (
        <Card>
          <CardHeader>
            <CardTitle>Conectar ao Chamados</CardTitle>
            <CardDescription>
              O mesmo login que você usa no Chamados. A senha fica no chaveiro do sistema.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormConexao
              conexao={existente}
              aoConectar={(id) => {
                setConexaoId(id);
                setPasso('projeto');
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold">Qual repositório?</h2>
            <p className="text-sm text-muted-foreground">
              A pasta da sua cópia local. Confira o que foi detectado e ligue os sistemas-alvo.
            </p>
          </div>
          <FormularioProjeto
            projeto={null}
            conexaoId={conexaoDoProjeto}
            enxuto
            rotuloSalvar="Pronto"
            aoSalvo={() => navegar('/fila', { replace: true })}
          />
          <div>
            <Button variant="ghost" size="sm" onClick={() => setPasso('conexao')}>
              Voltar à conexão
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
