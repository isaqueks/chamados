import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChevronRightIcon, Loader2Icon } from 'lucide-react';
import type {
  ProjetoDetectadoDto,
  ProjetoDto,
  SalvarProjetoDto,
  SistemaCasadoDto,
} from '@comum/dto';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Campo } from '@/componentes/apoio/campos';
import { useComando } from '@/componentes/apoio/comando';
import { Faixa } from '@/componentes/apoio/estrutura-tela';
import { BlocoDetectado, CampoPasta, SistemasAlvo, useDeteccao } from './deteccao';
import {
  analisarAvancado,
  formularioDeConfig,
  montarConfig,
  nomeDaPasta,
  textoDoAvancado,
  type FormProjeto,
} from './logica';

/**
 * Formulário do Projeto simplificado (FJ-030 §5): nome, pasta, branch,
 * sistemas-alvo, o bloco "Detectado" (somente leitura) e um `<details>`
 * "Avançado" com o JSON de `avancado` validado pelo zod a cada tecla. "Nada
 * mais": modelos, limites e gates são globais (tela Configurações); evidências
 * visuais são do agente (nota §3).
 *
 * `enxuto` (passo 2 do onboarding): só a pasta, o que foi detectado e os
 * sistemas — o nome vem da pasta e a branch é a detectada.
 */

function Bloco({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4">
      <div className="flex flex-col gap-1 px-6">
        <h2 className="font-semibold">{titulo}</h2>
        {descricao && <p className="text-sm text-muted-foreground">{descricao}</p>}
      </div>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/** Ponto de partida do Avançado a partir do detectado (o usuário apaga o que não quer mudar). */
function exemploAvancado(d: ProjetoDetectadoDto | null): string {
  if (!d) return textoDoAvancado({ gates: { plano: 'por_risco' } });
  return textoDoAvancado({
    comandos: { verificacao: d.comandos.verificacao },
    detectores: d.detectores,
    arquivos_locais: d.arquivos_locais,
  });
}

export function FormularioProjeto({
  projeto,
  conexaoId,
  enxuto = false,
  rotuloSalvar,
  aoSalvo,
}: {
  projeto: ProjetoDto | null;
  /** Conexão do projeto novo (ausente = o servidor usa a única/primeira). */
  conexaoId: string | null;
  enxuto?: boolean;
  rotuloSalvar?: string;
  aoSalvo?: (id: string) => void;
}) {
  const inicial = useMemo(() => formularioDeConfig(projeto?.config ?? null), [projeto]);
  const [form, setForm] = useState<FormProjeto>(inicial);
  const [tentou, setTentou] = useState(false);
  const avancadoRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => setForm(inicial), [inicial]);

  const conexao = projeto?.conexao_id ?? conexaoId;
  const deteccao = useDeteccao(form.repo_dir, conexao);
  // Enquanto a pasta é a salva, o detectado do projeto serve sem esperar a rede.
  const mesmaPasta = !!projeto && projeto.config.repo_dir === form.repo_dir.trim();
  const r = deteccao.deteccao;
  const detectado: ProjetoDetectadoDto | null = r
    ? r.valido
      ? r.detectado
      : null
    : mesmaPasta
      ? projeto.detectado
      : null;
  const casamento: SistemaCasadoDto[] = r
    ? r.casamento_sistemas
    : mesmaPasta
      ? projeto.casamento_sistemas
      : [];
  const pastaValida = detectado !== null;

  const resultado = useMemo(() => montarConfig(form), [form]);
  const avancado = useMemo(() => analisarAvancado(form.avancado_texto), [form.avancado_texto]);
  const errosCampos = tentou && !resultado.ok ? resultado.erros : {};
  const sujo = JSON.stringify(form) !== JSON.stringify(inicial);

  const mudar = <K extends keyof FormProjeto>(k: K, v: FormProjeto[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const salvar = useComando({
    executar: (dto: SalvarProjetoDto) =>
      projeto
        ? api('projeto_atualizar', { params: { id: projeto.id }, entrada: dto })
        : api('projeto_criar', { entrada: dto }),
    invalidar: [['projetos'], ['projeto'], ['fila']],
    sucesso: projeto ? 'Projeto salvo' : 'Projeto criado',
    aoSucesso: (r) => {
      setTentou(false);
      aoSalvo?.(r.id);
    },
  });

  function aoSalvar() {
    setTentou(true);
    if (!resultado.ok) {
      if (resultado.avancado.length > 0 && avancadoRef.current) avancadoRef.current.open = true;
      toast.error('Corrija os campos marcados antes de salvar.');
      return;
    }
    if (!pastaValida) {
      toast.error('A pasta ainda não foi confirmada como repositório git.');
      return;
    }
    salvar.mutate({
      config: resultado.config,
      ...(conexao ? { conexao_id: conexao } : {}),
      ...(projeto ? { ativo: projeto.ativo } : {}),
    });
  }

  function abrirAvancado() {
    const el = avancadoRef.current;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="flex flex-col gap-6">
      <Bloco
        titulo="Repositório"
        descricao={
          enxuto
            ? 'A Forja descobre o resto sozinha: branch, comandos e o que é sensível.'
            : undefined
        }
      >
        <CampoPasta
          valor={form.repo_dir}
          aoMudar={(v) => mudar('repo_dir', v)}
          deteccao={deteccao}
          erro={errosCampos.repo_dir}
        />
        {!enxuto && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Campo rotulo="Nome" erro={errosCampos.nome} ajuda="Vazio = o nome da pasta.">
              {(id) => (
                <Input
                  id={id}
                  value={form.nome}
                  placeholder={
                    (form.repo_dir.trim() && nomeDaPasta(form.repo_dir.trim())) ||
                    r?.nome_sugerido ||
                    'erp-acme'
                  }
                  onChange={(e) => mudar('nome', e.target.value)}
                  aria-invalid={errosCampos.nome ? true : undefined}
                />
              )}
            </Campo>
            <Campo
              rotulo="Branch de destino"
              erro={errosCampos.branch_destino}
              ajuda={
                detectado?.branch_destino
                  ? `Vazio = a detectada (${detectado.branch_destino}).`
                  : 'Vazio = detectada (origin/HEAD, main, master…).'
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.branch_destino}
                  placeholder={detectado?.branch_destino ?? 'main'}
                  onChange={(e) => mudar('branch_destino', e.target.value)}
                  className="font-mono text-xs"
                  spellCheck={false}
                  aria-invalid={errosCampos.branch_destino ? true : undefined}
                />
              )}
            </Campo>
          </div>
        )}
      </Bloco>

      {detectado && (
        <>
          <Bloco
            titulo="Sistemas-alvo"
            descricao="A Fila mostra os chamados destes sistemas do Chamados."
          >
            <SistemasAlvo
              casamento={casamento}
              explicitos={form.sistemas}
              aoMudar={(v) => mudar('sistemas', v)}
            />
          </Bloco>
          <Bloco
            titulo="Detectado"
            descricao="O que a Forja descobriu no repositório. Os agentes recebem isto como ponto de partida."
          >
            <BlocoDetectado
              detectado={detectado}
              aoEditarAvancado={enxuto ? undefined : abrirAvancado}
            />
          </Bloco>
        </>
      )}

      {!enxuto && (
        <details
          ref={avancadoRef}
          className="group scroll-mt-4 rounded-xl border bg-card px-6 py-4 text-card-foreground shadow-cartao"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold select-none [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
              aria-hidden
            />
            Avançado
            <span className="text-sm font-normal text-muted-foreground">
              {avancado.ok && avancado.valor
                ? `· ${Object.keys(avancado.valor).join(', ')}`
                : avancado.ok
                  ? '· nada sobrescrito'
                  : '· com erro'}
            </span>
          </summary>
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              JSON que sobrescreve a autodetecção e os padrões globais. Tudo é opcional:{' '}
              <code className="font-mono text-xs">
                comandos, detectores, arquivos_locais, entrega, politica_status, gates, limites,
                modo_reforcado
              </code>
              .
            </p>
            <Textarea
              value={form.avancado_texto}
              onChange={(e) => mudar('avancado_texto', e.target.value)}
              rows={12}
              spellCheck={false}
              aria-label="Configuração avançada (JSON)"
              aria-invalid={!avancado.ok || undefined}
              className="min-h-48 font-mono text-xs"
            />
            {!avancado.ok && (
              <Faixa nivel="erro">
                <ul className="flex flex-col gap-0.5">
                  {avancado.erros.map((e) => (
                    <li key={e} className="font-mono text-xs">
                      {e}
                    </li>
                  ))}
                </ul>
              </Faixa>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={avancado.ok && avancado.valor !== undefined}
                onClick={() => mudar('avancado_texto', exemploAvancado(detectado))}
              >
                Partir do detectado
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={form.avancado_texto.trim() === '{}'}
                onClick={() => mudar('avancado_texto', '{}')}
              >
                Limpar (100% automático)
              </Button>
            </div>
          </div>
        </details>
      )}

      <div
        className={cn(
          'flex flex-wrap items-center justify-end gap-3',
          !enxuto && 'sticky bottom-0 -mx-1 border-t bg-background/95 px-1 py-3 backdrop-blur',
        )}
      >
        {!enxuto && (
          <span className="mr-auto text-xs text-muted-foreground">
            {sujo
              ? 'Alterações não salvas · execuções já iniciadas continuam com a configuração delas.'
              : 'Execuções já iniciadas continuam com a configuração delas.'}
          </span>
        )}
        {!enxuto && sujo && (
          <Button
            variant="ghost"
            onClick={() => {
              setForm(inicial);
              setTentou(false);
            }}
          >
            Descartar alterações
          </Button>
        )}
        <Button
          onClick={aoSalvar}
          disabled={
            salvar.isPending || deteccao.esperando || (!!projeto && !sujo) || !form.repo_dir.trim()
          }
        >
          {salvar.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
          {rotuloSalvar ?? (projeto ? 'Salvar' : 'Criar projeto')}
        </Button>
      </div>
    </div>
  );
}
