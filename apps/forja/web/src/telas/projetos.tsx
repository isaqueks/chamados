import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderGitIcon, PlusIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { buttonVariants } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Pagina,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';

/**
 * Projetos (specs/forja/06 §4.8, rota `/projetos`). Sem projeto, a tela manda
 * ao onboarding de 2 passos (`/comecar`, FJ-030 §5).
 */

export function TelaProjetos() {
  const consulta = useQuery({
    queryKey: ['projetos'],
    queryFn: ({ signal }) => api('projetos_listar', { sinal: signal }),
  });
  const projetos = consulta.data?.projetos ?? [];

  return (
    <Pagina>
      <CabecalhoPagina
        titulo="Projetos"
        descricao="Repositórios locais que implementam chamados."
        acoes={
          projetos.length > 0 && (
            <Link to="/projetos/novo" className={buttonVariants({ variant: 'default' })}>
              <PlusIcon aria-hidden />
              Novo projeto
            </Link>
          )
        }
      />
      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : projetos.length === 0 ? (
        <Vazio
          icone={FolderGitIcon}
          titulo="Nenhum projeto ainda"
          descricao="Aponte a pasta de um repositório: branch, comandos e sistemas-alvo são detectados."
          acao={
            <Link to="/comecar" className={buttonVariants({ variant: 'default' })}>
              Começar
            </Link>
          }
        />
      ) : (
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Projeto</TableHead>
                <TableHead>Destino</TableHead>
                <TableHead>Sistemas-alvo</TableHead>
                <TableHead>Conexão</TableHead>
                <TableHead>Situação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projetos.map((p) => (
                <TableRow key={p.id} className={p.ativo ? undefined : 'opacity-70'}>
                  <TableCell>
                    <Link to={`/projetos/${p.id}`} className="font-medium hover:underline">
                      {p.nome}
                    </Link>
                    <span className="block font-mono text-xs text-muted-foreground">{p.slug}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.branch_destino}</TableCell>
                  <TableCell className="text-sm">
                    {p.sistemas.length ? (
                      p.sistemas.join(', ')
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">nenhum mapeado</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.conexao_nome}</TableCell>
                  <TableCell>
                    <Badge variant={p.ativo ? 'outline' : 'muted'}>
                      {p.ativo ? 'ativo' : 'inativo'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </Pagina>
  );
}
