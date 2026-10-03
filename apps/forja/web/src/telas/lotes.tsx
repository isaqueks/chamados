import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayersIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { buttonVariants } from '@/ui/button';
import { Card } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Badge } from '@/ui/badge';
import { useProjetoAtual } from '@/componentes/shell/projeto-atual';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Pagina,
  Vazio,
} from '@/componentes/apoio/estrutura-tela';
import { formatarDataHora, plural } from '@/componentes/apoio/texto';
import { loteAtivo, resumoGrupos, ROTULO_ESTADO_LOTE } from '@/componentes/lote/logica';

/**
 * Lotes (specs/forja/06 §4.5, rota `/lotes`): os lotes do projeto atual, com o
 * resumo por grupo de estado e o caminho para a mesa de planos ou para o
 * acompanhamento. Lote se cria na Fila ("Implementar em lote", 06 §5.2) — por
 * isso o vazio ensina a ir para lá.
 */
export function TelaLotes() {
  const { projetoId } = useProjetoAtual();
  const consulta = useQuery({
    queryKey: ['lotes'],
    queryFn: ({ signal }) => api('lotes_listar', { sinal: signal }),
    refetchInterval: 15_000,
  });

  const lotes = (consulta.data?.lotes ?? [])
    .filter((l) => !projetoId || l.projeto_id === projetoId)
    .sort((a, b) => {
      const at = loteAtivo(a.estado) ? 0 : 1;
      const bt = loteAtivo(b.estado) ? 0 : 1;
      return at - bt || b.criado_em.localeCompare(a.criado_em);
    });

  return (
    <Pagina>
      <CabecalhoPagina titulo="Lotes" descricao="Como andam os lotes iniciados?" />
      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : lotes.length === 0 ? (
        <Vazio
          icone={LayersIcon}
          titulo="Nenhum lote."
          descricao="Selecione chamados na Fila e use Implementar em lote."
          acao={
            <Link to="/fila" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Ir para a Fila
            </Link>
          }
        />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lote</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Chamados</TableHead>
                <TableHead>Iniciado</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lotes.map((l) => (
                <TableRow key={l.id} className={loteAtivo(l.estado) ? undefined : 'opacity-70'}>
                  <TableCell className="font-medium">
                    <Link to={`/lotes/${l.id}`} className="hover:underline">
                      {l.nome}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={loteAtivo(l.estado) ? 'outline' : 'muted'}>
                      {ROTULO_ESTADO_LOTE[l.estado]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{plural(l.total, 'chamado')}</span>
                      <span className="text-xs text-muted-foreground">
                        {resumoGrupos(l.por_grupo)
                          .map((g) => g.texto)
                          .join(' · ') || '—'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground tabular-nums">
                    {formatarDataHora(l.criado_em)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {(l.estado === 'planejando' || l.estado === 'mesa_de_planos') && (
                        <Link
                          to={`/lotes/${l.id}/planos`}
                          className={buttonVariants({ variant: 'default', size: 'sm' })}
                        >
                          Mesa de planos
                        </Link>
                      )}
                      <Link
                        to={`/lotes/${l.id}`}
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      >
                        Abrir
                      </Link>
                    </div>
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
