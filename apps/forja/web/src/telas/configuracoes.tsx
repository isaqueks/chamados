import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2Icon, RotateCcwIcon } from 'lucide-react';
import type { ConfiguracoesDto, ConfiguracoesGlobaisDto } from '@comum/dto';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Input } from '@/ui/input';
import { Campo, CampoSelect } from '@/componentes/apoio/campos';
import {
  CampoInterruptor,
  CampoNumero,
  type MensagensCampo,
} from '@/componentes/apoio/campos-por-caminho';
import { useComando } from '@/componentes/apoio/comando';
import { DialogoConfirmacao } from '@/componentes/apoio/confirmar';
import {
  CabecalhoPagina,
  Carregando,
  ErroCarregar,
  Pagina,
} from '@/componentes/apoio/estrutura-tela';
import { plural } from '@/componentes/apoio/texto';
import { contarAjustes, validarConfiguracoes } from '@/componentes/configuracoes/logica';

/**
 * Configurações (FJ-030 §2): as preferências GLOBAIS da Forja, que saíram da
 * config de cada projeto — modelos, cota, concorrência, limites e gates. Uma
 * tela só, curta, com "Restaurar padrões". O projeto ainda pode sobrescrever
 * `limites`/`gates` no Avançado dele (texto).
 */

const CHAVE = ['configuracoes'];
const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPCOES_ESFORCO = ESFORCOS.map((e) => ({ valor: e, rotulo: e }));

type Mudar = (fn: (c: ConfiguracoesGlobaisDto) => void) => void;

function Secao({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao?: string;
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

function Grade({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{children}</div>;
}

function CampoModelo({
  rotulo,
  valor,
  aoMudar,
  erroModelo,
}: {
  rotulo: string;
  valor: ConfiguracoesGlobaisDto['modelos']['orquestrador'];
  aoMudar: (v: ConfiguracoesGlobaisDto['modelos']['orquestrador']) => void;
  erroModelo?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_8rem] items-start gap-3">
      <Campo rotulo={rotulo} erro={erroModelo}>
        {(id) => (
          <Input
            id={id}
            value={valor.modelo}
            onChange={(e) => aoMudar({ ...valor, modelo: e.target.value })}
            className="font-mono text-xs"
            spellCheck={false}
            aria-invalid={erroModelo ? true : undefined}
          />
        )}
      </Campo>
      <Campo rotulo="Esforço">
        {(id) => (
          <CampoSelect
            id={id}
            valor={valor.esforco}
            opcoes={
              (ESFORCOS as readonly string[]).includes(valor.esforco)
                ? OPCOES_ESFORCO
                : [...OPCOES_ESFORCO, { valor: valor.esforco, rotulo: valor.esforco }]
            }
            aoMudar={(v) => aoMudar({ ...valor, esforco: v })}
          />
        )}
      </Campo>
    </div>
  );
}

function Formulario({ dados }: { dados: ConfiguracoesDto }) {
  const inicial = dados.configuracoes;
  const [form, setForm] = useState(inicial);
  const [tentou, setTentou] = useState(false);
  const [restaurar, setRestaurar] = useState(false);

  useEffect(() => setForm(inicial), [inicial]);

  const mudar: Mudar = (fn) =>
    setForm((c) => {
      const n = JSON.parse(JSON.stringify(c)) as ConfiguracoesGlobaisDto;
      fn(n);
      return n;
    });

  const validacao = useMemo(() => validarConfiguracoes(form), [form]);
  const erros = tentou && !validacao.ok ? validacao.erros : {};
  const msgs: MensagensCampo = { erros, avisos: {} };
  const sujo = JSON.stringify(form) !== JSON.stringify(inicial);
  const ajustes = contarAjustes(inicial, dados.padrao);

  const salvar = useComando({
    executar: (dto: ConfiguracoesGlobaisDto) => api('configuracoes_gravar', { entrada: dto }),
    invalidar: [CHAVE],
    sucesso: 'Configurações salvas: valem para as próximas execuções',
    aoSucesso: () => setTentou(false),
  });
  const restaurarCmd = useComando({
    executar: () => api('configuracoes_restaurar'),
    invalidar: [CHAVE],
    sucesso: 'Padrões restaurados',
    aoSucesso: () => {
      setRestaurar(false);
      setTentou(false);
    },
  });

  function aoSalvar() {
    setTentou(true);
    if (validacao.ok) salvar.mutate(validacao.dto);
  }

  const o = form.limites.orcamento_usd;
  const t = form.limites.timeout_min;

  return (
    <div className="flex flex-col gap-6">
      <Secao
        titulo="Modelos"
        descricao="O orquestrador planeja e conduz; os subagentes implementam e revisam."
      >
        <CampoModelo
          rotulo="Orquestrador"
          valor={form.modelos.orquestrador}
          erroModelo={erros['modelos.orquestrador.modelo']}
          aoMudar={(v) => mudar((c) => void (c.modelos.orquestrador = v))}
        />
        <CampoModelo
          rotulo="Subagentes"
          valor={form.modelos.subagentes}
          erroModelo={erros['modelos.subagentes.modelo']}
          aoMudar={(v) => mudar((c) => void (c.modelos.subagentes = v))}
        />
      </Secao>

      <Secao
        titulo="Cota e concorrência"
        descricao="Acima do limiar da janela da assinatura, nada novo começa; o que está em voo termina."
      >
        <Grade>
          <CampoNumero
            caminho="cota.five_hour"
            rotulo="Janela de 5 h"
            valor={form.cota.five_hour}
            escala={100}
            sufixo="%"
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.cota.five_hour = v))}
          />
          <CampoNumero
            caminho="cota.seven_day"
            rotulo="Janela de 7 dias"
            valor={form.cota.seven_day}
            escala={100}
            sufixo="%"
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.cota.seven_day = v))}
          />
          <CampoNumero
            caminho="concorrencia.implementacoes"
            rotulo="Implementações"
            valor={form.concorrencia.implementacoes}
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.concorrencia.implementacoes = v))}
          />
          <CampoNumero
            caminho="concorrencia.planejadores"
            rotulo="Planejadores"
            valor={form.concorrencia.planejadores}
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.concorrencia.planejadores = v))}
          />
        </Grade>
        <CampoInterruptor
          rotulo="Permitir créditos extras"
          descricao={
            form.cota.permitir_creditos_extras
              ? 'Passando da cota, a Forja segue consumindo créditos pagos.'
              : 'Passando da cota, a Forja para e espera a janela renovar.'
          }
          marcado={form.cota.permitir_creditos_extras}
          aoMudar={(v) => mudar((c) => void (c.cota.permitir_creditos_extras = v))}
        />
      </Secao>

      <Secao titulo="Limites" descricao="Por chamado. O projeto pode sobrescrever no Avançado.">
        <Grade>
          <CampoNumero
            caminho="limites.ciclos.max_auto"
            rotulo="Ciclos automáticos"
            valor={form.limites.ciclos.max_auto}
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.limites.ciclos.max_auto = v))}
          />
          <CampoNumero
            caminho="limites.ciclos.max_total"
            rotulo="Ciclos no total"
            valor={form.limites.ciclos.max_total}
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.limites.ciclos.max_total = v))}
          />
          <CampoNumero
            caminho="limites.orcamento_usd.por_chamado"
            rotulo="Orçamento por chamado"
            valor={o.por_chamado}
            passo={0.5}
            sufixo="US$"
            msgs={msgs}
            aoMudar={(v) => mudar((c) => void (c.limites.orcamento_usd.por_chamado = v))}
          />
        </Grade>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Orçamento por etapa (US$)
            </legend>
            <div className="grid grid-cols-2 gap-4">
              {(
                [
                  ['planejar', 'Planejar'],
                  ['implementar', 'Implementar'],
                  ['revisar', 'Revisar'],
                  ['relatar', 'Relatar'],
                ] as const
              ).map(([k, rotulo]) => (
                <CampoNumero
                  key={k}
                  caminho={`limites.orcamento_usd.${k}`}
                  rotulo={rotulo}
                  valor={o[k]}
                  passo={0.5}
                  msgs={msgs}
                  aoMudar={(v) => mudar((c) => void (c.limites.orcamento_usd[k] = v))}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Tempo máximo por etapa (min)
            </legend>
            <div className="grid grid-cols-2 gap-4">
              {(
                [
                  ['planejar', 'Planejar'],
                  ['implementar', 'Implementar'],
                  ['revisar', 'Revisar'],
                  ['relatar', 'Relatar'],
                ] as const
              ).map(([k, rotulo]) => (
                <CampoNumero
                  key={k}
                  caminho={`limites.timeout_min.${k}`}
                  rotulo={rotulo}
                  valor={t[k]}
                  msgs={msgs}
                  aoMudar={(v) => mudar((c) => void (c.limites.timeout_min[k] = v))}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </Secao>

      <Secao
        titulo="Gates"
        descricao="Por padrão você só clica em Implementar e em Aprovar e mergear; o resto vira aviso."
      >
        <Campo rotulo="Aprovar o plano antes de implementar">
          {(id) => (
            <CampoSelect
              id={id}
              className="sm:w-80"
              valor={form.gates.plano}
              opcoes={[
                { valor: 'nunca', rotulo: 'Nunca, só com alerta de segurança (padrão)' },
                { valor: 'por_risco', rotulo: 'Quando há risco' },
                { valor: 'sempre', rotulo: 'Sempre' },
              ]}
              aoMudar={(v) => mudar((c) => void (c.gates.plano = v))}
            />
          )}
        </Campo>
      </Secao>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <span className="mr-auto text-xs text-muted-foreground">
          {tentou && !validacao.ok
            ? `${plural(Object.keys(validacao.erros).length, 'campo')} com erro`
            : sujo
              ? 'Alterações não salvas · execuções em andamento seguem com o que tinham.'
              : ajustes === 0
                ? 'Usando os padrões.'
                : `${plural(ajustes, 'ajuste')} em relação aos padrões.`}
        </span>
        <Button
          variant="ghost"
          disabled={ajustes === 0 && !sujo}
          onClick={() => setRestaurar(true)}
        >
          <RotateCcwIcon aria-hidden />
          Restaurar padrões
        </Button>
        {sujo && (
          <Button
            variant="ghost"
            onClick={() => {
              setForm(inicial);
              setTentou(false);
            }}
          >
            Descartar
          </Button>
        )}
        <Button onClick={aoSalvar} disabled={!sujo || salvar.isPending}>
          {salvar.isPending && <Loader2Icon className="animate-spin" aria-hidden />}
          Salvar
        </Button>
      </div>

      <DialogoConfirmacao
        aberto={restaurar}
        aoMudarAberto={setRestaurar}
        titulo="Restaurar os padrões?"
        descricao={`Volta modelos (${dados.padrao.modelos.orquestrador.modelo} / ${dados.padrao.modelos.subagentes.modelo}), cota, concorrência, limites e gates aos valores de fábrica. O Avançado de cada projeto não muda.`}
        rotuloConfirmar="Restaurar padrões"
        pendente={restaurarCmd.isPending}
        aoConfirmar={() => restaurarCmd.mutate(undefined)}
      />
    </div>
  );
}

export function TelaConfiguracoes() {
  const consulta = useQuery({
    queryKey: CHAVE,
    queryFn: ({ signal }) => api('configuracoes_obter', { sinal: signal }),
  });
  return (
    <Pagina>
      <CabecalhoPagina
        titulo="Configurações"
        descricao="Valem para todos os projetos. Os padrões servem para quase todo mundo."
        extra={
          consulta.data && (
            <p className="font-mono text-xs text-muted-foreground">{consulta.data.arquivo}</p>
          )
        }
      />
      {consulta.isPending ? (
        <Carregando linhas={5} />
      ) : consulta.isError ? (
        <ErroCarregar erro={consulta.error} tentarDeNovo={() => void consulta.refetch()} />
      ) : (
        <Formulario dados={consulta.data} />
      )}
    </Pagina>
  );
}
