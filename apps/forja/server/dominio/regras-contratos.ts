import type { PlanoV1, ResumoImplV1, TelaAfetada, VereditoV1 } from '../../comum/contratos';

/**
 * Regras de validação EM CÓDIGO dos contratos do modelo (specs/forja/04 §6),
 * as que não cabem em JSON Schema. Rodam DEPOIS do `safeParse` do zod
 * (`validarContrato`): aqui o dado já tem a forma certa e o que se confere é
 * coerência entre campos e com os fatos do app.
 *
 * Saída em três classes, porque a consequência difere (04 §6, coluna
 * "Consequência"):
 * - `erros` → **recusa com instrução**: 1 `--resume` do mesmo turno com a
 *   lista; persistindo, `precisa_humano` (`decidirRecusa` em `ciclos.ts`);
 * - `alertas`/`avisos` → só registro/feed, não bloqueiam;
 * - campos específicos (correções do app, candidatos a `fora_do_plano`…).
 *
 * `relatorio.v1` fica em `regras-relatorio.ts` (validação cruzada com selos).
 */

// ---------------------------------------------------------------------------
// Caminhos e rotas (04 §6: "caminho absoluto, com `..` ou em
// `arquivos_locais`/`.env*` → recusa"; FJ-026: rota relativa, sem host)
// ---------------------------------------------------------------------------

export type ProblemaCaminho = 'absoluto' | 'sobe_diretorio' | 'arquivo_local' | 'env';

/** Normaliza `./a//b` → `a/b` (sem resolver `..`: `..` é recusado, não corrigido). */
export function normalizarCaminho(caminho: string): string {
  return caminho
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/{2,}/g, '/');
}

/** Problema de um caminho previsto pelo planejador, ou `null` se aceitável. */
export function problemaCaminho(
  caminho: string,
  arquivosLocais: readonly string[] = [],
): ProblemaCaminho | null {
  const bruto = caminho.trim();
  if (/^([/~]|[A-Za-z]:[\\/]|\\\\)/.test(bruto)) return 'absoluto';
  const c = normalizarCaminho(bruto);
  if (c.split('/').includes('..')) return 'sobe_diretorio';
  const locais = arquivosLocais.map(normalizarCaminho);
  if (locais.some((l) => c === l || c.startsWith(`${l.replace(/\/$/, '')}/`))) {
    return 'arquivo_local';
  }
  const nome = c.split('/').pop() ?? c;
  if (nome.toLowerCase().startsWith('.env')) return 'env';
  return null;
}

/** Rota de tela relativa a `BASE_URL`: começa com `/`, sem `//host`, sem esquema, sem `..`. */
export function rotaRelativaValida(rota: string): boolean {
  if (!rota.startsWith('/') || rota.startsWith('//')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rota) || rota.includes('://')) return false;
  const caminho = rota.split(/[?#]/)[0] ?? '';
  return !caminho.split('/').includes('..');
}

function errosTelas(telas: readonly TelaAfetada[], rotulo: string): string[] {
  const erros: string[] = [];
  const vistos = new Set<string>();
  for (const t of telas) {
    if (vistos.has(t.id)) erros.push(`${rotulo}: id de tela repetido ${t.id}`);
    vistos.add(t.id);
    if (!rotaRelativaValida(t.rota)) {
      erros.push(`${rotulo} ${t.id}: rota "${t.rota}" não é relativa (sem host, sem "..")`);
    }
  }
  return erros;
}

function repetidos(ids: readonly string[]): string[] {
  const vistos = new Set<string>();
  const rep = new Set<string>();
  for (const id of ids) (vistos.has(id) ? rep : vistos).add(id);
  return [...rep];
}

// ---------------------------------------------------------------------------
// plano.v1
// ---------------------------------------------------------------------------

export interface ContextoPlano {
  /** `destino` de cada item de `projeto.arquivos_locais`. */
  arquivos_locais: readonly string[];
}

export interface ValidacaoPlano {
  /** Violações → recusa com instrução (04 §6). */
  erros: string[];
  /** `.env*`/arquivos locais também viram alerta (04 §6) — além da recusa. */
  alertas: string[];
  /** ⚙ `arquivos_previstos` recalculado (⊇ união dos passos): o app corrige e registra. */
  arquivos_previstos: string[];
  /** Arquivos que o app acrescentou a `arquivos_previstos`. */
  corrigidos: string[];
}

/** Grafo `depende_de` acíclico? (DFS com cores; ids desconhecidos ignorados aqui.) */
function temCiclo(passos: readonly { id: string; depende_de: readonly string[] }[]): boolean {
  // Ids repetidos (já recusados à parte) somam as arestas: um ciclo não se esconde atrás deles.
  const adj = new Map<string, string[]>();
  for (const p of passos) adj.set(p.id, [...(adj.get(p.id) ?? []), ...p.depende_de]);
  const cor = new Map<string, 'cinza' | 'preto'>();
  const visitar = (id: string): boolean => {
    const c = cor.get(id);
    if (c === 'cinza') return true;
    if (c === 'preto') return false;
    cor.set(id, 'cinza');
    for (const d of adj.get(id) ?? []) if (adj.has(d) && visitar(d)) return true;
    cor.set(id, 'preto');
    return false;
  };
  return passos.some((p) => visitar(p.id));
}

export function validarPlano(plano: PlanoV1, ctx: ContextoPlano): ValidacaoPlano {
  const erros: string[] = [];
  const alertas: string[] = [];
  const implementavel = plano.natureza_confirmada !== 'nao_implementavel';

  if (implementavel) {
    if (plano.criterios_de_aceite.length < 1) erros.push('plano sem critério de aceite');
    if (plano.passos.length < 1) erros.push('plano sem passos');
  } else if (!plano.motivo_nao_implementavel) {
    erros.push('nao_implementavel exige motivo_nao_implementavel');
  }

  const idsCa = plano.criterios_de_aceite.map((c) => c.id);
  const idsPasso = plano.passos.map((p) => p.id);
  for (const id of repetidos(idsCa)) erros.push(`critério de aceite repetido: ${id}`);
  for (const id of repetidos(idsPasso)) erros.push(`passo repetido: ${id}`);
  for (const p of plano.passos) {
    for (const d of p.depende_de) {
      if (!idsPasso.includes(d)) erros.push(`${p.id} depende de passo inexistente ${d}`);
      if (d === p.id) erros.push(`${p.id} depende de si mesmo`);
    }
  }
  if (temCiclo(plano.passos)) erros.push('dependências entre passos formam um ciclo');
  for (const e2e of plano.plano_de_testes.e2e) {
    if (!idsCa.includes(e2e.criterio_id)) {
      erros.push(`plano de testes e2e aponta para critério inexistente ${e2e.criterio_id}`);
    }
  }

  const todos = [...plano.arquivos_previstos, ...plano.passos.flatMap((p) => p.arquivos_previstos)];
  for (const c of new Set(todos)) {
    const problema = problemaCaminho(c, ctx.arquivos_locais);
    if (!problema) continue;
    erros.push(`caminho recusado (${problema}): ${c}`);
    if (problema === 'env' || problema === 'arquivo_local') {
      alertas.push(`o plano prevê mexer em arquivo local/segredo: ${c}`);
    }
  }

  const declarados = plano.arquivos_previstos.map(normalizarCaminho);
  const corrigidos = [
    ...new Set(
      plano.passos
        .flatMap((p) => p.arquivos_previstos.map(normalizarCaminho))
        .filter((c) => !declarados.includes(c)),
    ),
  ];

  const altera = plano.schema_banco.altera;
  const temMudancas = plano.schema_banco.mudancas.length > 0;
  const areaSchema = plano.areas.includes('schema_banco');
  if (altera !== temMudancas || altera !== areaSchema) {
    erros.push('schema_banco.altera, mudancas não vazio e areas ∋ schema_banco devem concordar');
  }

  const areaUi = plano.areas.includes('ui');
  if (areaUi !== plano.telas_afetadas.length > 0) {
    erros.push('areas ∋ ui exige telas_afetadas não vazio (e vice-versa)');
  }
  erros.push(...errosTelas(plano.telas_afetadas, 'tela'));

  return {
    erros,
    alertas,
    arquivos_previstos: [...new Set([...declarados, ...corrigidos])],
    corrigidos,
  };
}

/** O plano prevê UI? (`evidenciar antes`, 03 §5.4: áreas, telas ou arquivos de frontend.) */
export function planoPreveUi(
  plano: Pick<PlanoV1, 'areas' | 'telas_afetadas' | 'arquivos_previstos'>,
  casaFrontend: (caminho: string) => boolean,
): boolean {
  return (
    plano.areas.includes('ui') ||
    plano.telas_afetadas.length > 0 ||
    plano.arquivos_previstos.some((a) => casaFrontend(a))
  );
}

// ---------------------------------------------------------------------------
// resumo_impl.v1
// ---------------------------------------------------------------------------

export interface ContextoResumoImpl {
  /** Ciclo corrente do app (`etapa.ciclo`). */
  ciclo: number;
  plano: Pick<
    PlanoV1,
    'passos' | 'arquivos_previstos' | 'telas_afetadas' | 'dependencias_previstas'
  >;
  /** `git diff --name-only sha_base..HEAD` (vale o git). */
  arquivos_reais: readonly string[];
  /** Algum lockfile mudou no diff. */
  lockfile_mudou: boolean;
  /** HEAD da worktree == último checkpoint do app. */
  head_igual_checkpoint: boolean;
}

export interface ValidacaoResumoImpl {
  erros: string[];
  avisos: string[];
  /** Arquivo real fora de `arquivos_previstos` e de `desvios_do_plano` → prompt do T2. */
  fora_do_plano: string[];
  /** Dependência nova sem previsão: aviso vermelho + `revisao_seguranca: obrigatoria`. */
  revisao_seguranca_obrigatoria: boolean;
  /** `bloqueios` não vazio → `precisa_humano` com o motivo. */
  bloqueios: string[];
  /** O agente versionou por conta própria (HEAD ≠ checkpoint): alerta vermelho. */
  agente_versionou: boolean;
}

export function validarResumoImpl(
  resumo: ResumoImplV1,
  ctx: ContextoResumoImpl,
): ValidacaoResumoImpl {
  const erros: string[] = [];
  const avisos: string[] = [];
  if (resumo.ciclo !== ctx.ciclo) erros.push(`ciclo ${resumo.ciclo} ≠ ciclo do app ${ctx.ciclo}`);

  const idsPlano = ctx.plano.passos.map((p) => p.id);
  const idsResumo = resumo.passos.map((p) => p.id);
  for (const id of idsResumo) {
    if (!idsPlano.includes(id)) erros.push(`passo ${id} não existe no plano`);
  }
  for (const id of idsPlano) {
    if (!idsResumo.includes(id)) erros.push(`passo ${id} do plano não aparece no resumo`);
  }
  for (const id of repetidos(idsResumo)) erros.push(`passo repetido no resumo: ${id}`);

  const reais = new Set(ctx.arquivos_reais.map(normalizarCaminho));
  const declarados = new Set(
    resumo.passos.flatMap((p) => p.arquivos_alterados.map(normalizarCaminho)),
  );
  const naoDeclarados = [...reais].filter((a) => !declarados.has(a));
  const inexistentes = [...declarados].filter((a) => !reais.has(a));
  if (naoDeclarados.length > 0 || inexistentes.length > 0) {
    avisos.push(
      `arquivos declarados × git divergem (vale o git): não declarados [${naoDeclarados.join(', ')}], declarados sem diff [${inexistentes.join(', ')}]`,
    );
  }

  const previstos = new Set(ctx.plano.arquivos_previstos.map(normalizarCaminho));
  const desvios = new Set(resumo.desvios_do_plano.map((d) => normalizarCaminho(d.arquivo)));
  const fora_do_plano = [...reais].filter((a) => !previstos.has(a) && !desvios.has(a)).sort();

  const semPrevisao = ctx.plano.dependencias_previstas.length === 0;
  const revisao_seguranca_obrigatoria =
    semPrevisao && (resumo.dependencias_adicionadas.length > 0 || ctx.lockfile_mudou);
  if (revisao_seguranca_obrigatoria) {
    avisos.push('dependência nova sem previsão no plano: revisão de segurança obrigatória');
  }

  const idsTelasPlano = new Set(ctx.plano.telas_afetadas.map((t) => t.id));
  const rotasPlano = new Set(ctx.plano.telas_afetadas.map((t) => t.rota));
  for (const t of resumo.telas_afetadas) {
    if (idsTelasPlano.has(t.id))
      erros.push(`tela ${t.id} já está no plano (declare só telas novas)`);
    if (rotasPlano.has(t.rota)) {
      erros.push(`rota ${t.rota} já está no plano (declare só telas novas)`);
    }
  }
  erros.push(...errosTelas(resumo.telas_afetadas, 'tela do resumo'));

  return {
    erros,
    avisos,
    fora_do_plano,
    revisao_seguranca_obrigatoria,
    bloqueios: resumo.bloqueios.map((b) => `${b.precisa}: ${b.descricao}`),
    agente_versionou: !ctx.head_igual_checkpoint,
  };
}

// ---------------------------------------------------------------------------
// veredito.v1
// ---------------------------------------------------------------------------

export interface ContextoVeredito {
  /** O SHA que o app verificou e passou no prompt do T2. */
  sha_verificado: string;
  /** Ids dos CA do plano oficial. */
  ids_criterios: readonly string[];
  /** Refs válidas listadas no prompt (`artefato:<id>`; sem `log:` desde FJ-032 — o app não roda comandos). */
  refs_validas: readonly string[];
  revisao_seguranca_obrigatoria: boolean;
}

export interface ValidacaoVeredito {
  /** `sha_avaliado == sha_verificado` (eco). `false` → não conta; T2 roda de novo 1×. */
  valido: boolean;
  motivo_invalido: string | null;
  /** Violações de conteúdo → recusa com instrução. */
  erros: string[];
  /** Ex.: "aprovado" com bloqueante — o app trata como reprovado e registra. */
  incoerencias: string[];
  /** Decisão depois do rebaixamento de incoerência (04 §6). */
  decisao_efetiva: VereditoV1['decisao'];
}

export function validarVeredito(veredito: VereditoV1, ctx: ContextoVeredito): ValidacaoVeredito {
  const valido = veredito.sha_avaliado === ctx.sha_verificado;
  const erros: string[] = [];
  const incoerencias: string[] = [];

  const ids = veredito.criterios.map((c) => c.id);
  for (const id of ctx.ids_criterios) {
    if (!ids.includes(id)) erros.push(`critério ${id} do plano sem avaliação`);
  }
  for (const id of ids) {
    if (!ctx.ids_criterios.includes(id)) erros.push(`critério ${id} não existe no plano`);
  }
  for (const id of repetidos(ids)) erros.push(`critério ${id} avaliado mais de uma vez`);

  const refs = new Set(ctx.refs_validas);
  for (const c of veredito.criterios) {
    if (c.evidencia_ref !== null && !refs.has(c.evidencia_ref)) {
      erros.push(`${c.id}: evidencia_ref "${c.evidencia_ref}" não é uma ref listada`);
    }
    if (c.status === 'nao_verificavel' && c.evidencia.trim().length === 0) {
      erros.push(`${c.id}: nao_verificavel sem justificativa`);
    }
  }
  if (ctx.revisao_seguranca_obrigatoria && !veredito.revisores.includes('revisor_seguranca')) {
    erros.push('revisão de segurança obrigatória sem revisor_seguranca');
  }

  let decisao_efetiva = veredito.decisao;
  if (veredito.decisao === 'aprovado') {
    const bloqueantes = veredito.achados.filter((a) => a.severidade === 'bloqueante');
    const naoAtendidos = veredito.criterios.filter((c) => c.status === 'nao_atendido');
    if (bloqueantes.length > 0) {
      incoerencias.push(
        `aprovado com achado bloqueante (${bloqueantes.map((a) => a.id).join(', ')})`,
      );
    }
    if (naoAtendidos.length > 0) {
      incoerencias.push(
        `aprovado com critério não atendido (${naoAtendidos.map((c) => c.id).join(', ')})`,
      );
    }
    if (incoerencias.length > 0) decisao_efetiva = 'reprovado';
  }

  return {
    valido,
    motivo_invalido: valido
      ? null
      : `sha_avaliado ${veredito.sha_avaliado.slice(0, 8)} ≠ sha_verificado ${ctx.sha_verificado.slice(0, 8)}`,
    erros,
    incoerencias,
    decisao_efetiva,
  };
}
