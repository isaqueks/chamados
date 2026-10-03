import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import type { DeteccaoProjetoDto, ProjetoDetectadoDto, SistemaCasadoDto } from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Campo } from '@/componentes/apoio/campos';
import { RotuloCalculado } from '@/componentes/apoio/estrutura-tela';
import { mensagemErro } from '@/componentes/apoio/texto';
import { alternarSistema, chaveSistema, problemaPasta, sistemasEfetivos } from './logica';

/**
 * Peças da autodetecção do projeto (FJ-030 §1 e §5): a pasta do repositório é
 * validada pelo servidor (`git rev-parse`) enquanto o usuário digita, e o que
 * foi detectado — branch, scripts, detectores, arquivos locais, sistemas-alvo
 * casados pelo nome — aparece SOMENTE LEITURA. Ajuste fino fica no Avançado.
 * Os scripts são "dicas para o agente" (FJ-032): a Forja não os executa.
 */

const ATRASO_DETECCAO_MS = 500;

/** Detecção da pasta com debounce; erro local (caminho relativo) não chega ao servidor. */
export function useDeteccao(repoDir: string, conexaoId: string | null) {
  const atual = repoDir.trim();
  const [alvo, setAlvo] = useState(atual);
  useEffect(() => {
    const t = setTimeout(() => setAlvo(atual), ATRASO_DETECCAO_MS);
    return () => clearTimeout(t);
  }, [atual]);
  const problemaLocal = atual ? problemaPasta(atual) : null;
  const consulta = useQuery({
    queryKey: ['projeto-detectar', alvo, conexaoId],
    queryFn: ({ signal }) =>
      api('projeto_detectar', {
        entrada: { repo_dir: alvo, ...(conexaoId ? { conexao_id: conexaoId } : {}) },
        sinal: signal,
      }),
    enabled: alvo !== '' && problemaPasta(alvo) === null,
    staleTime: 30_000,
    retry: false,
  });
  const esperando = alvo !== atual || consulta.isFetching;
  const deteccao: DeteccaoProjetoDto | null =
    alvo === atual && !problemaLocal ? (consulta.data ?? null) : null;
  return {
    deteccao,
    esperando: !problemaLocal && atual !== '' && esperando,
    erro: problemaLocal ?? (consulta.isError ? mensagemErro(consulta.error) : null),
    redetectar: () => void consulta.refetch(),
  };
}

export function CampoPasta({
  valor,
  aoMudar,
  deteccao,
  erro,
}: {
  valor: string;
  aoMudar: (v: string) => void;
  deteccao: ReturnType<typeof useDeteccao>;
  erro?: string;
}) {
  const r = deteccao.deteccao;
  const d = r?.valido ? r.detectado : null;
  const problema =
    erro ?? deteccao.erro ?? (r && !r.valido ? (r.erro ?? 'não é um repositório git') : null);
  return (
    <Campo
      rotulo="Pasta do repositório"
      erro={problema}
      ajuda={
        deteccao.esperando ? (
          <span className="inline-flex items-center gap-1">
            <Loader2Icon className="size-3 animate-spin" aria-hidden />
            conferindo a pasta…
          </span>
        ) : d ? (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2Icon className="size-3" aria-hidden />
            repositório git{d.remoto ? ` · remoto ${d.remoto}` : ' · sem remoto'}
          </span>
        ) : (
          'Caminho completo da sua cópia. A Forja nunca mexe nela: cada chamado usa uma worktree.'
        )
      }
    >
      {(id) => (
        <Input
          id={id}
          value={valor}
          onChange={(e) => aoMudar(e.target.value)}
          placeholder="/home/voce/dev/erp-acme"
          className="font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problema ? true : undefined}
        />
      )}
    </Campo>
  );
}

function Item({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-muted-foreground sm:pt-0.5">{rotulo}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Globs({ lista }: { lista: string[] }) {
  if (lista.length === 0) return <span className="text-muted-foreground">nenhum</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {lista.map((g) => (
        <code key={g} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]">
          {g}
        </code>
      ))}
    </span>
  );
}

const ROTULO_DETECTOR: Record<keyof ProjetoDetectadoDto['detectores'], string> = {
  banco: 'Banco',
  frontend: 'Interface',
  regra_negocio: 'Regra de negócio',
  sensivel: 'Sensível',
  docs_exigidas: 'Docs exigidas',
};

const ROTULO_ORIGEM_BRANCH: Record<NonNullable<ProjetoDetectadoDto['origem_branch']>, string> = {
  origin_head: 'pelo origin/HEAD',
  main: 'existe main',
  master: 'existe master',
  atual: 'branch atual da cópia',
};

/** O bloco "Detectado" (somente leitura; nota §1). */
export function BlocoDetectado({
  detectado,
  aoEditarAvancado,
}: {
  detectado: ProjetoDetectadoDto;
  aoEditarAvancado?: () => void;
}) {
  const d = detectado;
  const comandos = [
    ...(d.comandos.setup ? [{ nome: 'dependências', ...d.comandos.setup }] : []),
    ...d.comandos.verificacao,
    ...(d.comandos.e2e ? [{ nome: 'e2e', ...d.comandos.e2e }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RotuloCalculado />
        {aoEditarAvancado && (
          <Button variant="link" size="sm" className="h-auto px-0" onClick={aoEditarAvancado}>
            editar no Avançado
          </Button>
        )}
      </div>
      {d.avisos.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-amber-700 dark:text-amber-400">
          {d.avisos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <dl className="flex flex-col gap-2.5">
        <Item rotulo="Branch de destino">
          <span className="font-mono text-xs">{d.branch_destino ?? '—'}</span>
          {d.origem_branch && (
            <span className="ml-2 text-xs text-muted-foreground">
              {ROTULO_ORIGEM_BRANCH[d.origem_branch]}
            </span>
          )}
        </Item>
        <Item rotulo="Dicas para o agente">
          <span className="mb-1 block text-xs text-muted-foreground">
            A Forja não executa estes scripts: eles vão ao prompt como dica, e o agente decide o que
            instalar e checar.
          </span>
          {comandos.length === 0 ? (
            <span className="text-muted-foreground">
              nenhum script reconhecido no package.json — o agente verifica como achar melhor
            </span>
          ) : (
            <ul className="flex flex-col gap-1">
              {comandos.map((c) => (
                <li key={`${c.nome}:${c.comando}`} className="flex flex-wrap items-baseline gap-2">
                  <span className="w-24 shrink-0 text-xs text-muted-foreground">{c.nome}</span>
                  <code className="font-mono text-xs">{c.comando}</code>
                </li>
              ))}
            </ul>
          )}
          {d.gerenciador && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {d.gerenciador}
              {d.lockfile ? ` (pelo ${d.lockfile})` : ''}
              {d.workspaces ? ' · workspaces na raiz' : ''}
            </span>
          )}
        </Item>
        <Item rotulo="Detectores">
          <div className="flex flex-col gap-1.5">
            {(Object.keys(ROTULO_DETECTOR) as (keyof typeof ROTULO_DETECTOR)[])
              .filter((k) => k !== 'docs_exigidas' || d.detectores[k].length > 0)
              .map((k) => (
                <div key={k} className="flex flex-wrap items-start gap-2">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">
                    {ROTULO_DETECTOR[k]}
                  </span>
                  <Globs lista={d.detectores[k]} />
                </div>
              ))}
          </div>
        </Item>
        <Item rotulo="Arquivos locais">
          {d.arquivos_locais.length === 0 ? (
            <span className="text-muted-foreground">nenhum</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {d.arquivos_locais.map((a) => (
                <code
                  key={a.destino}
                  className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[11px]"
                >
                  {a.origem === a.destino ? a.origem : `${a.origem} → ${a.destino}`}
                </code>
              ))}
              <span className="text-xs text-muted-foreground">copiados para cada worktree</span>
            </span>
          )}
        </Item>
      </dl>
    </div>
  );
}

/**
 * Sistemas-alvo com toggles (nota §1): sem escolha explícita, valem os que o
 * casamento automático pelo nome sugeriu; mexer num toggle grava a lista;
 * voltar exatamente ao casamento automático retorna ao modo automático. Um
 * sistema já mapeado a OUTRO projeto aparece desligado e travado.
 */
export function SistemasAlvo({
  casamento,
  explicitos,
  aoMudar,
}: {
  casamento: SistemaCasadoDto[];
  explicitos: string[] | undefined;
  aoMudar: (v: string[] | undefined) => void;
}) {
  const ligados = new Set(sistemasEfetivos(explicitos, casamento));
  const conhecidos = new Set(casamento.map(chaveSistema));
  const lista: SistemaCasadoDto[] = [
    ...casamento,
    ...(explicitos ?? [])
      .filter((k) => !conhecidos.has(k))
      .map((k) => ({
        sistema_nome: k,
        sistema_alvo_id: null,
        ligado: true,
        sugerido: false,
        outro_projeto: null,
      })),
  ];
  if (lista.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        O Chamados ainda não listou sistemas-alvo para esta conexão. A Fila só mostra chamados dos
        sistemas ligados aqui.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {explicitos === undefined
          ? 'Automático: ligados os sistemas cujo nome casa com o do repositório.'
          : 'Escolha manual.'}
        {explicitos !== undefined && (
          <Button
            variant="link"
            size="sm"
            className="ml-1 h-auto px-0 text-xs"
            onClick={() => aoMudar(undefined)}
          >
            Voltar ao automático
          </Button>
        )}
      </p>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {lista.map((s) => {
          const chave = chaveSistema(s);
          const travado = !!s.outro_projeto && !ligados.has(chave);
          return (
            <li key={chave}>
              <label
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2',
                  travado && 'opacity-60',
                )}
              >
                <Switch
                  checked={ligados.has(chave)}
                  disabled={travado}
                  onCheckedChange={(v) => aoMudar(alternarSistema(explicitos, casamento, chave, v))}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{s.sistema_nome}</span>
                  {s.outro_projeto && (
                    <span className="truncate text-xs text-muted-foreground">
                      já usado por {s.outro_projeto}
                    </span>
                  )}
                </span>
                {s.sugerido && <Badge variant="muted">casou pelo nome</Badge>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
