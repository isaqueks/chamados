import { Link } from 'react-router';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';

/**
 * Estados vazios da Fila (specs/forja/06 §4.1 "Vazios e erros"; §6 princípio
 * 9: o vazio ensina o próximo passo). Sem projeto → onboarding de 2 passos
 * (`/comecar`, FJ-030 §5); projeto sem sistema-alvo → "Ligar sistemas"; sem
 * chamados → limpar filtros / ver todos os status.
 */

export function OnboardingFila() {
  return (
    <Card className="mx-auto w-full max-w-xl text-center">
      <CardHeader>
        <CardTitle>Nenhum projeto ainda</CardTitle>
        <CardDescription>
          Dois passos: conectar ao Chamados e apontar a pasta do repositório. O resto é detectado.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button render={<Link to="/comecar" />}>Começar</Button>
      </CardContent>
    </Card>
  );
}

export function VazioSemMapeamento({ projetoId }: { projetoId: string }) {
  return (
    <Card className="mx-auto w-full max-w-xl text-center">
      <CardHeader>
        <CardTitle>Nenhum sistema-alvo ligado a este repositório</CardTitle>
        <CardDescription>
          A Fila só mostra chamados dos sistemas ligados ao projeto.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button render={<Link to={`/projetos/${projetoId}`} />}>Ligar sistemas</Button>
      </CardContent>
    </Card>
  );
}

export function VazioSemChamados({
  aoLimparFiltros,
  aoVerTodosStatus,
}: {
  aoLimparFiltros: () => void;
  aoVerTodosStatus: () => void;
}) {
  return (
    <Card className="mx-auto w-full max-w-xl text-center">
      <CardHeader>
        <CardTitle>Nada implementável agora</CardTitle>
        <CardDescription>Nenhum chamado bate com os filtros atuais.</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center gap-2">
        <Button variant="outline" onClick={aoLimparFiltros}>
          Limpar filtros
        </Button>
        <Button variant="outline" onClick={aoVerTodosStatus}>
          Ver todos os status
        </Button>
      </CardContent>
    </Card>
  );
}
