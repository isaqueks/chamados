import { useState } from 'react';
import { AlertTriangleIcon, ExternalLinkIcon } from 'lucide-react';
import type { EvidenciasDto, EvidenciaTelaDto, ImagemEvidenciaDto } from '@comum/dto';
import type { ResultadoTela } from '@comum/estados';
import { ROTULO_EVIDENCIA_VISUAL } from '@/lib/rotulos';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { RotuloOrigem } from '@/componentes/execucao/suporte';
import { formatarDuracao } from '@/componentes/execucao/formato-execucao';
import { shaCurto } from './regras-aprovar';
import { Segmentado } from '@/ui/segmentado';

/**
 * Aba Evidências (specs/forja/06 §4.3 e §5.7; FJ-026): prints ANTES/DEPOIS por
 * tela, lado a lado, com a alternância "Sobrepor" (deslizador antes ↔ depois
 * sobre a mesma área) para achar a diferença; legenda com o
 * `o_que_mudou_para_quem_usa` do relatório (escrito pelo agente), rota, `sha` e
 * viewport. Tela nova mostra "não existia antes"; tela sem par ou captura
 * impossível mostra o motivo no lugar da imagem, com [Recapturar]. Abaixo, os
 * logs da verificação por comando, com busca.
 *
 * FJ-030 §3: quem fotografa é o AGENTE (sobe o app como quiser, `forja-print`
 * antes de mexer e depois de verificar); a Forja só coleta e valida. Por isso
 * a aba mostra o que a validação achou — `antes_suspeito` (o PNG do antes é
 * posterior ao primeiro checkpoint: pode não ser do `sha_base`) — e, quando
 * falta print, o motivo que o próprio agente declarou (`motivo_sem_antes` por
 * tela, `motivo_geral` quando não conseguiu subir o app ou logar).
 */

const MOTIVO_RESULTADO: Record<ResultadoTela, string> = {
  ok: 'capturado',
  reaproveitado: 'reaproveitado do ciclo anterior (mesmo sha base)',
  tela_nova: 'não existia antes',
  nao_encontrada: 'tela não encontrada',
  timeout: 'tempo da captura esgotado',
  login_falhou: 'o login no app falhou',
  app_nao_subiu: 'o app não subiu',
};

type Visao = 'lado_a_lado' | 'sobrepor';

function Imagem({ img, rotulo }: { img: ImagemEvidenciaDto; rotulo: string }) {
  if (img.expirada) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        print expirado pela retenção
      </div>
    );
  }
  return (
    <img
      src={img.url}
      alt={`${rotulo} (${img.largura}×${img.altura}, sha ${shaCurto(img.sha_git)})`}
      width={img.largura}
      height={img.altura}
      loading="lazy"
      className="h-auto w-full rounded-md border bg-muted"
    />
  );
}

function Lacuna({
  texto,
  origemAgente,
  aoRecapturar,
}: {
  texto: string;
  /** O texto é a justificativa do agente (rótulo de proveniência, 06 §3.3). */
  origemAgente?: boolean;
  aoRecapturar?: () => void;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-amber-300 bg-amber-50 p-4 text-center text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangleIcon className="size-4" aria-hidden />
      {texto}
      {origemAgente && <RotuloOrigem origem="agente" />}
      {aoRecapturar && (
        <Button size="xs" variant="outline" onClick={aoRecapturar}>
          Recapturar
        </Button>
      )}
    </div>
  );
}

function Coluna({
  titulo,
  img,
  resultado,
  motivoAgente,
  suspeito,
  aoRecapturar,
}: {
  titulo: string;
  img: ImagemEvidenciaDto | null;
  resultado: ResultadoTela | null;
  /** O motivo que o agente declarou para não ter o print (nota FJ-030 §3). */
  motivoAgente?: string | null;
  suspeito?: boolean;
  aoRecapturar?: () => void;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {titulo}
        {img && (
          <span className="ml-1 font-mono font-normal normal-case">
            {img.largura}×{img.altura}
          </span>
        )}
        {img && suspeito && (
          <span className="ml-2 rounded-sm bg-amber-100 px-1 py-0.5 font-medium normal-case text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
            suspeito
          </span>
        )}
      </figcaption>
      {img ? (
        <>
          <Imagem img={img} rotulo={titulo} />
          {suspeito && (
            <p className="text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangleIcon className="mr-1 inline size-3 align-[-2px]" aria-hidden />
              Este print foi gravado depois que a implementação começou: pode não mostrar a tela
              original.
            </p>
          )}
        </>
      ) : resultado === 'tela_nova' ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
          não existia antes
        </div>
      ) : (
        <Lacuna
          texto={`sem print ${titulo.toLowerCase()}: ${motivoAgente ?? (resultado ? MOTIVO_RESULTADO[resultado] : 'não capturado')}`}
          origemAgente={!!motivoAgente}
          aoRecapturar={aoRecapturar}
        />
      )}
    </figure>
  );
}

function Sobreposto({ antes, depois }: { antes: ImagemEvidenciaDto; depois: ImagemEvidenciaDto }) {
  const [posicao, setPosicao] = useState(50);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-md border bg-muted">
        <img src={depois.url} alt="depois" className="block h-auto w-full" />
        <img
          src={antes.url}
          alt="antes"
          aria-hidden
          className="absolute inset-0 h-auto w-full"
          style={{ clipPath: `inset(0 ${100 - posicao}% 0 0)` }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary"
          style={{ left: `${posicao}%` }}
        />
      </div>
      <label className="flex items-center gap-3 text-xs text-muted-foreground">
        antes
        <input
          type="range"
          min={0}
          max={100}
          value={posicao}
          onChange={(e) => setPosicao(Number(e.target.value))}
          className="flex-1 accent-primary"
          aria-label="Deslizador antes e depois"
        />
        depois
      </label>
    </div>
  );
}

function CartaoTela({
  tela,
  visao,
  aoRecapturar,
}: {
  tela: EvidenciaTelaDto;
  visao: Visao;
  aoRecapturar?: () => void;
}) {
  const podeSobrepor =
    visao === 'sobrepor' &&
    tela.antes &&
    tela.depois &&
    !tela.antes.expirada &&
    !tela.depois.expirada;
  return (
    <article className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-cartao">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">
          <span className="font-mono text-muted-foreground">{tela.tela_id}</span> {tela.descricao}
          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
            {tela.rota}
          </span>
        </h4>
        <RotuloOrigem origem="agente" />
      </header>
      {tela.aviso && (
        <p className="text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangleIcon className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
          {tela.aviso}
        </p>
      )}
      {podeSobrepor ? (
        <Sobreposto antes={tela.antes!} depois={tela.depois!} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Coluna
            titulo="Antes"
            img={tela.antes}
            resultado={tela.resultado_antes}
            motivoAgente={tela.motivo_sem_antes}
            suspeito={tela.antes_suspeito}
            aoRecapturar={aoRecapturar}
          />
          <Coluna
            titulo="Depois"
            img={tela.depois}
            resultado={tela.resultado_depois}
            aoRecapturar={aoRecapturar}
          />
        </div>
      )}
      {tela.o_que_mudou && (
        <p className="text-sm">
          <span className="font-medium">O que mudou: </span>
          {tela.o_que_mudou}
          <RotuloOrigem origem="agente" className="ml-2 align-middle" />
        </p>
      )}
    </article>
  );
}

export function AbaEvidencias({
  evidencias,
  aoRecapturar,
}: {
  evidencias: EvidenciasDto;
  aoRecapturar?: () => void;
}) {
  const [visao, setVisao] = useState<Visao>('lado_a_lado');
  const [busca, setBusca] = useState('');
  const e = evidencias;
  const logs = e.logs.filter((l) => l.nome.toLowerCase().includes(busca.trim().toLowerCase()));
  const suspeitos = e.telas.filter((t) => t.antes && t.antes_suspeito).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs text-muted-foreground">
          antes {shaCurto(e.sha_antes)} · depois {shaCurto(e.sha_depois)}
          {e.viewport ? ` · ${e.viewport.largura}×${e.viewport.altura}` : ''}
          {e.tema ? ` · tema ${e.tema}` : ''} · {ROTULO_EVIDENCIA_VISUAL[e.evidencia_visual]}
        </p>
        <Segmentado
          rotuloAcessivel="Visão dos prints"
          valor={visao}
          aoMudar={setVisao}
          opcoes={
            [
              ['lado_a_lado', 'Lado a lado'],
              ['sobrepor', 'Sobrepor'],
            ] as const
          }
        />
      </div>

      {e.motivo_geral && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="flex flex-wrap items-center justify-between gap-2 font-medium">
            O agente não conseguiu fotografar as telas
            <RotuloOrigem origem="agente" />
          </span>
          <span>{e.motivo_geral}</span>
        </div>
      )}
      {e.motivo && e.motivo !== e.motivo_geral && (
        <p className="text-sm text-amber-800 dark:text-amber-200">{e.motivo}</p>
      )}
      {suspeitos > 0 && (
        <p className="text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangleIcon className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
          {suspeitos === 1
            ? '1 print de antes foi gravado depois que a implementação começou.'
            : `${suspeitos} prints de antes foram gravados depois que a implementação começou.`}{' '}
          Confira se mostram a tela original.
        </p>
      )}

      {e.telas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {e.evidencia_visual === 'nao_se_aplica'
            ? 'Esta mudança não altera a interface: não há prints.'
            : e.motivo_geral
              ? 'Nenhuma tela fotografada.'
              : 'Nenhuma tela fotografada pelo agente.'}
        </p>
      ) : (
        e.telas.map((t) => (
          <CartaoTela key={t.tela_id} tela={t} visao={visao} aoRecapturar={aoRecapturar} />
        ))
      )}

      <section className="flex flex-col gap-2" aria-label="Logs da verificação">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">Logs</h4>
          <Input
            value={busca}
            onChange={(ev) => setBusca(ev.target.value)}
            placeholder="buscar comando"
            aria-label="Buscar comando nos logs"
            className="h-7 w-48"
          />
        </header>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum log.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {logs.map((l) => {
              const ok = l.exit_code === 0;
              return (
                <li key={l.artefato_id}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                      ok
                        ? 'text-foreground'
                        : 'border-rose-300 text-rose-700 dark:border-rose-800/60 dark:text-rose-300',
                    )}
                  >
                    {l.nome} {ok ? '✓' : `✗ exit ${l.exit_code ?? '—'}`}
                    <span className="text-muted-foreground">{formatarDuracao(l.duracao_ms)}</span>
                    <ExternalLinkIcon className="size-3" aria-hidden />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
