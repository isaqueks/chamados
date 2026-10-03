import { Link } from 'react-router';

/** Rota inexistente na SPA. */
export function TelaNaoEncontrada() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-2 p-12 text-center">
      <h1 className="text-lg font-semibold">Página não encontrada</h1>
      <Link to="/fila" className="text-sm text-primary underline underline-offset-4">
        Voltar para a Fila
      </Link>
    </div>
  );
}
