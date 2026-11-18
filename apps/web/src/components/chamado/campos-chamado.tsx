'use client';

import { useState } from 'react';
import type { JSONContent } from '@tiptap/react';
import {
  Natureza,
  Prioridade,
  ORDEM_ESTIMATIVA_CUSTO,
  rotuloEstimativaCusto,
} from '@chamados/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RichTextEditor, docTemConteudo } from '@/components/editor';
import { ROTULO_PRIORIDADE } from '@/lib/rotulos';

/**
 * Campos do formulário mínimo de abertura (specs/04 §2), compartilhados entre o
 * portal (`/portal/novo`) e o painel (`/app/chamados/novo` — D-040). Uma regra,
 * um lugar: sistema-alvo só aparece com >1 sistema ativo (senão o serviço
 * resolve), título 3..160, descrição rich text com imagens coladas/arrastadas
 * (o pipeline do servidor as transforma em anexos inline), natureza com
 * "Automático" (D-017) e prioridade com default `media`. Cada tela decide o
 * texto e o arranjo (o portal recolhe natureza/prioridade em "Opções avançadas";
 * o painel as mostra abertas).
 */

const SELECT_CLS =
  'flex h-9 w-full rounded-lg border border-input bg-card px-3 py-1 text-sm shadow-campo outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

const TITULO_MIN = 3;
const TITULO_MAX = 160;

/** Estado mínimo para habilitar o envio (o servidor revalida tudo). */
export function useCamposChamado(tituloInicial = '') {
  const [titulo, setTitulo] = useState(tituloInicial);
  const [temDescricao, setTemDescricao] = useState(false);
  return {
    titulo,
    setTitulo,
    aoMudarDescricao: (doc: JSONContent) => setTemDescricao(docTemConteudo(doc)),
    camposValidos: titulo.trim().length >= TITULO_MIN && temDescricao,
  };
}

export interface OpcaoSistema {
  id: string;
  nome: string;
}

/** Sistema-alvo: exibido e obrigatório só quando o tenant tem mais de um. */
export function CampoSistema({ sistemas }: { sistemas: OpcaoSistema[] }) {
  if (sistemas.length <= 1) return null;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="sistema_alvo_id">Sistema</Label>
      <select
        id="sistema_alvo_id"
        name="sistema_alvo_id"
        className={SELECT_CLS}
        required
        defaultValue=""
      >
        <option value="" disabled>
          Selecione o sistema
        </option>
        {sistemas.map((s) => (
          <option key={s.id} value={s.id}>
            {s.nome}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CampoTitulo({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="titulo">Título</Label>
      <Input
        id="titulo"
        name="titulo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required
        minLength={TITULO_MIN}
        maxLength={TITULO_MAX}
        autoComplete="off"
      />
    </div>
  );
}

export function CampoDescricao({
  onChange,
  placeholder,
  dica,
}: {
  onChange: (doc: JSONContent) => void;
  placeholder: string;
  dica?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Descrição</Label>
      <RichTextEditor
        name="descricao"
        ariaLabel="Descrição do chamado"
        placeholder={placeholder}
        onChange={onChange}
      />
      {dica && <p className="text-xs text-muted-foreground">{dica}</p>}
    </div>
  );
}

const NATUREZAS: { valor: Natureza; titulo: string; descricao: string }[] = [
  {
    valor: Natureza.problema,
    titulo: 'Problema',
    descricao: 'Algo não está funcionando como deveria.',
  },
  {
    valor: Natureza.alteracao,
    titulo: 'Alteração',
    descricao: 'Pedido de mudança ou melhoria.',
  },
  {
    valor: Natureza.duvida,
    titulo: 'Dúvida',
    descricao: 'Pergunta sobre como algo funciona.',
  },
];

/** Natureza com "Automático" (valor vazio → `problema` + reclassificação da IA — D-017). */
export function CampoNatureza({
  rotulo,
  rotuloAutomatico,
}: {
  rotulo: string;
  rotuloAutomatico: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="natureza">{rotulo}</Label>
      <select id="natureza" name="natureza" className={SELECT_CLS} defaultValue="">
        <option value="">{rotuloAutomatico}</option>
        {NATUREZAS.map((n) => (
          <option key={n.valor} value={n.valor}>
            {n.titulo} — {n.descricao}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Prioridade (default `media`; a IA/operador ajustam depois). */
export function CampoPrioridade({ rotulo, ajuda }: { rotulo: string; ajuda?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="prioridade">{rotulo}</Label>
      <select
        id="prioridade"
        name="prioridade"
        className={SELECT_CLS}
        defaultValue={Prioridade.media}
      >
        {Object.values(Prioridade).map((p) => (
          <option key={p} value={p}>
            {ROTULO_PRIORIDADE[p]}
          </option>
        ))}
      </select>
      {ajuda && <p className="text-xs text-muted-foreground">{ajuda}</p>}
    </div>
  );
}

/**
 * Estimativa de custo na abertura (D-043) — só no painel (a equipe define; o
 * cliente apenas vê). Vazio = sem estimativa.
 */
export function CampoEstimativaCusto({ rotulo, ajuda }: { rotulo: string; ajuda?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="estimativa_custo">{rotulo}</Label>
      <select id="estimativa_custo" name="estimativa_custo" className={SELECT_CLS} defaultValue="">
        <option value="">Sem estimativa</option>
        {ORDEM_ESTIMATIVA_CUSTO.map((e) => (
          <option key={e} value={e}>
            {rotuloEstimativaCusto(e)}
          </option>
        ))}
      </select>
      {ajuda && <p className="text-xs text-muted-foreground">{ajuda}</p>}
    </div>
  );
}
