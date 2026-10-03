import type { EstadoItemFilaMerge, NivelVerificacao } from '../../comum/estados';
import type { ItemFilaMerge } from '../db/entidades/item-fila-merge';
import type { JsonLivre } from '../db/json';
import {
  avancarRefLocal,
  calcularPatchId,
  caminhoWorktreeIntegracao,
  ehAncestral,
  estadoCopiaUsuario,
  integrarDestinoNaBranch,
  integrarEmWorktreeDestacada,
  intersecaoComDestino,
  jaIntegrado,
  mensagemMerge,
  patchIdConfere,
  pushDestino,
  removerWorktree,
  resolverBaseIntegracao,
  urlDoRemoto,
  type CredencialHttps,
  type Remoto,
} from '../git';
import { reverificarIntegracao } from './etapas';
import type { ResultadoIntegracao } from './maquina-execucao';
import type { Nucleo } from './nucleo';
import { projetosTravados } from './outbox';

/**
 * Fila de merge serial por `(projeto, destino)` (specs/forja/03 §8; 02 §4.12).
 *
 * POR QUE "intenção antes de agir": cada passo de 03 §8.1 grava no SQLite o
 * que vai fazer (estado do item, `sha_destino_antes`, `sha_merge` ANTES do
 * push) para a reconciliação do boot (03 §9.5) decidir sem adivinhar: com
 * `sha_merge` já ancestral do destino, a execução é `mergeado` e NUNCA se
 * re-mergeia; sem, recomeça do passo 1 (nada foi publicado).
 *
 * Invariantes (03 §8.1): nunca `--force`, nunca `stash`/`reset` na cópia do
 * usuário, nunca `update-ref` numa branch em checkout — tudo isso está nos
 * primitivos de `server/git/integracao.ts`; aqui fica a sequência e o efeito
 * na máquina.
 *
 * Sem reverificação por comando (FJ-032): a Forja não executa comandos do
 * projeto. Se o destino andou desde a aprovação E cruza arquivos do patch, um
 * turno T2 do revisor (Opus) reverifica o resultado integrado antes de avançar
 * a ref; sem interseção, integra direto.
 */

/** Recusas de push seguidas antes de `precisa_humano` (03 §8.2). */
export const MAX_RECUSAS_PUSH = 3;
/** `merge_local` com cópia suja: espera até 30 min, tentando a cada 1 min (03 §8.2). */
export const ESPERA_COPIA_SUJA_MS = 30 * 60_000;
export const INTERVALO_COPIA_SUJA_MS = 60_000;
const PREFIXO_COPIA_SUJA = 'copia_suja:';

export interface OpcoesFilaMerge {
  /** Credencial HTTPS do remoto (nunca em config/log, 05 §9). */
  credencial?: (projetoId: string) => CredencialHttps | undefined;
}

/**
 * Fixa `projeto.remoto_url` (05 §9) se ainda vazia: no cadastro e, na falta,
 * no preparo — antes de qualquer agente do projeto rodar.
 */
export async function capturarUrlRemoto(n: Nucleo, projetoId: string): Promise<void> {
  const p = await n.banco.ler((r) => r.projetos.obter(projetoId));
  if (!p || p.remoto_url) return;
  // Remoto efetivo (detectado ou do Avançado, FJ-030 §1).
  const remoto = n.configDoProjeto(p).repo.remoto;
  if (!remoto) return;
  const url = await urlDoRemoto(p.repo_dir, remoto).catch(() => null);
  if (url) await n.banco.transacao((r) => r.projetos.fixarRemotoUrl(projetoId, url));
}

export class FilaMerge {
  /** Item bloqueado por cópia suja: não tentar antes de (relógio do app). */
  private readonly naoAntesDe = new Map<string, number>();

  constructor(
    private readonly n: Nucleo,
    private readonly opcoes: OpcoesFilaMerge = {},
  ) {}

  /** O item pode ser processado agora (pacing da cópia suja)? */
  prontoParaTentar(itemId: string): boolean {
    return (this.naoAntesDe.get(itemId) ?? 0) <= this.n.agora().getTime();
  }

  private async publicarItem(item: ItemFilaMerge): Promise<void> {
    await this.n.publicar({
      execucao_id: item.execucao_id,
      etapa_id: null,
      tipo: 'fila_merge.item',
      nivel: item.estado === 'conflito' ? 'aviso' : 'info',
      resumo: `Fila de merge: item ${item.ordem} → ${item.estado}${item.motivo ? ` (${item.motivo})` : ''}`,
      dados: { item_id: item.id, estado: item.estado, ordem: item.ordem, motivo: item.motivo },
    });
  }

  private async mudarItem(
    id: string,
    estado: EstadoItemFilaMerge,
    extras: Partial<ItemFilaMerge> = {},
  ): Promise<ItemFilaMerge> {
    const item = await this.n.banco.transacao((r) => r.filaMerge.mudarEstado(id, estado, extras));
    await this.publicarItem(item);
    return item;
  }

  /** `nome` = o remoto do `config_snapshot` da execução (FJ-030 §1: detectado ou do Avançado). */
  private remoto(
    projeto: { id: string; remoto_url?: string | null },
    nome: string | null,
  ): Remoto | null {
    if (!nome) return null;
    const credencial = this.opcoes.credencial?.(projeto.id);
    return {
      nome,
      // URL confirmada no cadastro: conferida antes de cada fetch/push (05 §9).
      ...(projeto.remoto_url ? { urlEsperada: projeto.remoto_url } : {}),
      ...(credencial ? { credencial } : {}),
    };
  }

  /**
   * Passos 1–7 de 03 §8.1 para o item ativo da execução (que já está em
   * `integrando`). Devolve o resultado aplicado à máquina, ou `travado` quando
   * a sentinela trava o projeto (nada acontece até "Reconhecer").
   */
  async processar(
    execucaoId: string,
  ): Promise<ResultadoIntegracao | 'sem_item' | 'travado' | 'sentinela'> {
    const n = this.n;
    const { execucao, projeto, config } = await n.carregar(execucaoId);
    if ((await projetosTravados(n)).has(projeto.id)) return 'travado';
    let item = await n.banco.ler((r) => r.filaMerge.ativoDaExecucao(execucaoId));
    if (!item) {
      // `integrando` sem item (ex.: "Tentar de novo" depois de `falhou`, ou item
      // devolvido por fora): com aprovação vigente, re-enfileira; sem ela, G2.
      const vigente = await n.banco.ler((r) => r.aprovacoes.vigente(execucaoId));
      if (!vigente) {
        await n.transicionar(execucaoId, {
          tipo: 'integracao_concluida',
          resultado: 'patch_id_mudou',
          texto: 'sem aprovação vigente para integrar: aprove de novo',
        });
        return 'sem_item';
      }
      item = await n.banco.transacao((r) =>
        r.filaMerge.enfileirar({
          projeto_id: execucao.projeto_id,
          branch_destino: execucao.branch_destino,
          execucao_id: execucaoId,
          aprovacao_id: vigente.id,
        }),
      );
    }
    const modo = config.entrega.modo === 'merge_local' ? 'merge_local' : 'merge_e_push';
    const remoto = this.remoto(projeto, config.repo.remoto);
    const titulo =
      (await n.banco.ler((r) => r.chamados.obter(execucao.chamado_cache_id)))?.titulo ?? '';
    const etapa = await n.banco.transacao((r) =>
      r.etapas.criar({
        execucao_id: execucaoId,
        tipo: 'integrar',
        ciclo: execucao.ciclo_total + 1,
        sha_inicio: execucao.sha_verificado,
      }),
    );
    const fecharEtapa = async (
      motivo: 'concluido' | 'comando_vermelho' | 'comando_ambiente' | 'cancelado',
    ) => {
      await n.banco.transacao((r) =>
        r.etapas.finalizar(etapa.id, {
          estado:
            motivo === 'concluido' ? 'concluida' : motivo === 'cancelado' ? 'cancelada' : 'falhou',
          motivo_fim: motivo,
        }),
      );
    };
    const dirInt = caminhoWorktreeIntegracao(n.deps.dirDados, projeto.slug, item.id);
    const limparInt = () =>
      removerWorktree(projeto.repo_dir, dirInt, { dirDados: n.deps.dirDados }).catch(() => {});
    const concluir = async (
      resultado: ResultadoIntegracao,
      texto?: string,
      patch: Parameters<Nucleo['transicionar']>[2] = {},
    ): Promise<ResultadoIntegracao> => {
      const t = await n.transicionar(
        execucaoId,
        { tipo: 'integracao_concluida', resultado, texto },
        patch,
      );
      if (t.decisao.tipo === 'recusado') {
        // Nunca em silêncio: depois do push o código JÁ está no destino.
        n.log(`integração #${execucao.numero}: "${resultado}" recusado (${t.decisao.erro})`);
        await n.publicar({
          execucao_id: execucaoId,
          etapa_id: etapa.id,
          tipo: 'cli.alerta',
          nivel: 'erro',
          resumo:
            resultado === 'mergeado'
              ? `#${execucao.numero}: o merge foi publicado no destino, mas a execução já estava em "${t.execucao.estado}"`
              : `#${execucao.numero}: resultado da integração "${resultado}" recusado em "${t.execucao.estado}"`,
          dados: { codigo: 'integracao_recusada', bloqueante: resultado === 'mergeado' },
        });
      }
      return resultado;
    };
    // `sha_merge` já publicado (push com resultado incerto, reboot): nunca re-mergeia (03 §9.5, I-8).
    const jaPublicado = async (t0: string, shaMerge: string | null): Promise<boolean> =>
      !!shaMerge && (await ehAncestral(projeto.repo_dir, shaMerge, t0).catch(() => false));
    const concluirPublicado = async (shaMerge: string, motivo: string) => {
      await limparInt();
      await this.mudarItem(item!.id, 'concluido', {
        modo_avanco: modo === 'merge_e_push' ? 'push_direto' : 'update_ref',
        push_em: modo === 'merge_e_push' ? n.iso() : null,
        motivo,
      });
      await fecharEtapa('concluido');
      return concluir('mergeado', undefined, { patch: { sha_merge: shaMerge } });
    };

    // Cópia suja em `merge_local`: o prazo conta desde a 1ª vez (lido ANTES de sobrescrever o motivo).
    const bloqueadoDesde = item.motivo?.startsWith(PREFIXO_COPIA_SUJA)
      ? Date.parse(item.motivo.slice(PREFIXO_COPIA_SUJA.length))
      : null;
    const esperarCopiaSuja = async (motivoCopia: string): Promise<ResultadoIntegracao> => {
      await n.banco.transacao((r) => r.execucoes.atualizar(execucaoId, { sha_merge: null }));
      await limparInt();
      const desde = bloqueadoDesde ?? n.agora().getTime();
      if (n.agora().getTime() - desde >= ESPERA_COPIA_SUJA_MS) {
        await this.mudarItem(item!.id, 'devolvido', {
          motivo: 'cópia local suja além do tempo de espera',
        });
        await fecharEtapa('comando_vermelho');
        return concluir('copia_suja_expirou');
      }
      await this.mudarItem(item!.id, 'aguardando', {
        motivo: `${PREFIXO_COPIA_SUJA}${new Date(desde).toISOString()}`,
        copia_local_atras: true,
      });
      this.naoAntesDe.set(item!.id, n.agora().getTime() + INTERVALO_COPIA_SUJA_MS);
      await fecharEtapa('cancelado');
      return concluir('recomecar', `limpe sua ${execucao.branch_destino} local (${motivoCopia})`);
    };

    let recusasPush = 0;
    for (let tentativa = 0; tentativa < 10; tentativa++) {
      // `merge_local` com a cópia suja: espera ANTES de integrar (03 §8.2).
      if (modo === 'merge_local') {
        const copia = await estadoCopiaUsuario(projeto.repo_dir, execucao.branch_destino);
        if (copia.emCheckout && copia.suja) return esperarCopiaSuja('copia_suja');
      }
      // Passo 1: base T0 (intenção gravada antes).
      item = await this.mudarItem(item.id, 'integrando', {
        motivo: null,
        worktree_integracao_dir: dirInt,
      });
      let t0: string;
      try {
        t0 = await resolverBaseIntegracao({
          repoDir: projeto.repo_dir,
          modo,
          destino: execucao.branch_destino,
          remoto,
        });
      } catch (e) {
        await this.mudarItem(item.id, 'devolvido', { motivo: (e as Error).message.slice(0, 300) });
        await fecharEtapa('comando_ambiente');
        return concluir('setup_falhou', `base da integração: ${(e as Error).message}`);
      }
      item = await n.banco.transacao((r) =>
        r.filaMerge.atualizar(item!.id, { sha_destino_antes: t0 }),
      );
      const shaMergeAnterior = (await n.banco.ler((r) => r.execucoes.exigir(execucaoId))).sha_merge;
      if (await jaPublicado(t0, shaMergeAnterior)) {
        return concluirPublicado(shaMergeAnterior as string, 'já estava no destino');
      }

      // Passos 2–3: worktree destacada em T0 + merge --no-ff.
      const integ = await integrarEmWorktreeDestacada({
        repoDir: projeto.repo_dir,
        dirDados: n.deps.dirDados,
        dirIntegracao: dirInt,
        t0,
        branch: execucao.branch as string,
        mensagem: mensagemMerge(execucao.numero, titulo || `#${execucao.numero}`),
        estrategia: config.entrega.estrategia,
      });
      if (integ.tipo === 'conflito') {
        await this.mudarItem(item.id, 'conflito', {
          arquivos_em_conflito: integ.arquivos,
          tentativas_conflito: item.tentativas_conflito + 1,
          motivo: `conflito em ${integ.arquivos.length} arquivo(s)`,
        });
        await fecharEtapa('comando_vermelho');
        return concluir('conflito', `conflito com o destino: ${integ.arquivos.join(', ')}`);
      }

      // Passo 4: patch-id do integrado × aprovado (03 §2.5).
      const patchInt = await calcularPatchId(dirInt, t0, integ.sha);
      const aprov = await n.banco.ler((r) => r.aprovacoes.vigente(execucaoId));
      item = await n.banco.transacao((r) =>
        r.filaMerge.atualizar(item!.id, { sha_integrado: integ.sha, patch_id_integrado: patchInt }),
      );
      if (!patchIdConfere(aprov?.patch_id ?? null, patchInt)) {
        await limparInt();
        await this.mudarItem(item.id, 'devolvido', { motivo: "patch-id mudou: reaprovação (G2')" });
        await fecharEtapa('cancelado');
        return concluir('patch_id_mudou', undefined, {
          dentro: async (r) => {
            if (aprov && (await r.aprovacoes.vigente(execucaoId))?.id === aprov.id)
              await r.aprovacoes.invalidar(aprov.id, 'patch-id integrado diferente do aprovado');
            await r.artefatos.criar({
              execucao_id: execucaoId,
              tipo: 'diff',
              conteudo: { base: t0, sha: integ.sha, reaprovacao: true } as unknown as JsonLivre,
              sha_git: integ.sha,
              patch_id: patchInt,
            });
          },
        });
      }

      // Passo 5 (FJ-032): sem comando do projeto. Destino andou desde a
      // aprovação ∧ arquivos em comum → turno T2 do revisor no resultado
      // integrado; senão integra direto.
      const shaAprovado = aprov?.sha ?? execucao.sha_verificado ?? (execucao.branch as string);
      const cruzamento = await intersecaoComDestino(projeto.repo_dir, t0, shaAprovado).catch(
        () => ({ andou: true, base: null, arquivos: ['(não foi possível comparar)'] }),
      );
      let nivelReverificado: NivelVerificacao | null = null;
      if (cruzamento.andou && cruzamento.arquivos.length > 0) {
        item = await this.mudarItem(item.id, 'verificando', {
          motivo: `reverificação pelo revisor: ${cruzamento.arquivos.length} arquivo(s) em comum com o destino`,
        });
        const rv = await reverificarIntegracao(n, execucaoId, {
          dir: dirInt,
          base: t0,
          sha: integ.sha,
          destino: execucao.branch_destino,
          arquivosEmComum: cruzamento.arquivos,
        });
        if (rv.tipo === 'parado') {
          await limparInt();
          await this.mudarItem(item.id, 'aguardando', { motivo: 'reverificação interrompida' });
          await fecharEtapa('cancelado');
          return concluir('recomecar', 'reverificação interrompida; recomeça do passo 1');
        }
        if (rv.tipo === 'falhou') {
          await limparInt();
          await this.mudarItem(item.id, 'devolvido', { motivo: rv.texto.slice(0, 300) });
          await fecharEtapa('comando_ambiente');
          return concluir('reverificacao_falhou', rv.texto);
        }
        if (rv.tipo === 'reprovado') {
          // O app integra o destino na branch do chamado (limpo, já provado no passo 3) e abre T1.
          await limparInt();
          await integrarDestinoNaBranch(
            execucao.worktree_dir as string,
            t0,
            `forja: integra ${execucao.branch_destino} (${t0.slice(0, 8)}) para corrigir a reverificação`,
          ).catch(() => null);
          await this.mudarItem(item.id, 'devolvido', { motivo: 'reverificação reprovada' });
          await fecharEtapa('comando_vermelho');
          return concluir('reverificacao_vermelha', rv.texto);
        }
        nivelReverificado = rv.nivel.nivel;
      }

      // Passo 6: avançar o destino (03 §8.2). `sha_merge` gravado ANTES (03 §9.5).
      item = await this.mudarItem(item.id, 'publicando');
      await n.banco.transacao((r) => r.execucoes.atualizar(execucaoId, { sha_merge: integ.sha }));
      let modoAvanco: ItemFilaMerge['modo_avanco'] = null;
      let copiaAtras = false;
      if (modo === 'merge_e_push') {
        if (!remoto) {
          await limparInt();
          await fecharEtapa('comando_ambiente');
          return concluir('setup_falhou', 'merge_e_push sem remoto configurado');
        }
        const push = await pushDestino({
          repoDir: projeto.repo_dir,
          remoto,
          sha: integ.sha,
          destino: execucao.branch_destino,
        });
        if (push.resultado === 'erro') {
          // Resultado INCERTO (timeout, conexão caída depois do aceite): só um
          // fetch bem-sucedido diz se foi publicado. Sem confirmação negativa,
          // `sha_merge` fica — a próxima tentativa confere antes de re-mergear.
          let publicado: boolean | null = null;
          try {
            const t1 = await resolverBaseIntegracao({
              repoDir: projeto.repo_dir,
              modo,
              destino: execucao.branch_destino,
              remoto,
            });
            publicado = await jaPublicado(t1, integ.sha);
          } catch {
            publicado = null;
          }
          if (publicado) {
            return concluirPublicado(integ.sha, 'push confirmado depois de resultado incerto');
          }
          if (publicado === false) {
            await n.banco.transacao((r) => r.execucoes.atualizar(execucaoId, { sha_merge: null }));
          }
          await limparInt();
          await this.mudarItem(item.id, 'devolvido', {
            motivo: `push com erro: ${push.detalhe}`.slice(0, 300),
          });
          await fecharEtapa('comando_vermelho');
          return concluir(
            'push_recusado_3x',
            publicado === null
              ? `push com resultado incerto (${push.detalhe}); a próxima tentativa confere o remoto antes de integrar`
              : `push recusado: ${push.detalhe}`,
          );
        }
        if (push.resultado !== 'aceito') {
          // Não-ff: o remoto recusou — com certeza não publicou.
          await n.banco.transacao((r) => r.execucoes.atualizar(execucaoId, { sha_merge: null }));
          recusasPush += 1;
          if (recusasPush >= MAX_RECUSAS_PUSH) {
            await limparInt();
            await this.mudarItem(item.id, 'devolvido', {
              motivo: `push recusado: ${push.detalhe}`.slice(0, 300),
            });
            await fecharEtapa('comando_vermelho');
            return concluir('push_recusado_3x', `push recusado: ${push.detalhe}`);
          }
          continue; // não-ff: o destino andou — volta ao passo 1
        }
        // Cortesia local: o remoto já é a verdade (03 §8.2).
        const local = await avancarRefLocal({
          repoDir: projeto.repo_dir,
          destino: execucao.branch_destino,
          novo: integ.sha,
        });
        if (local.resultado === 'avancada') modoAvanco = local.modo;
        else {
          modoAvanco = 'push_direto';
          copiaAtras = true;
        }
      } else {
        const local = await avancarRefLocal({
          repoDir: projeto.repo_dir,
          destino: execucao.branch_destino,
          novo: integ.sha,
          antigo: t0,
        });
        if (local.resultado === 'cas_recusado') {
          await n.banco.transacao((r) => r.execucoes.atualizar(execucaoId, { sha_merge: null }));
          continue;
        }
        if (local.resultado === 'intocada') return esperarCopiaSuja(local.motivo);
        modoAvanco = local.modo;
      }

      // Passo 7: registrar, remover a integração, → mergeado.
      await limparInt();
      await this.mudarItem(item.id, 'concluido', {
        modo_avanco: modoAvanco,
        push_em: modo === 'merge_e_push' ? n.iso() : null,
        copia_local_atras: copiaAtras,
        motivo: copiaAtras ? `sua ${execucao.branch_destino} local está atrás` : null,
      });
      await fecharEtapa('concluido');
      return concluir('mergeado', undefined, {
        patch: {
          sha_merge: integ.sha,
          ...(nivelReverificado ? { nivel_verificacao: nivelReverificado } : {}),
        },
      });
    }
    await this.mudarItem(item.id, 'devolvido', { motivo: 'o destino não parou de andar' });
    await fecharEtapa('comando_vermelho');
    return concluir('push_recusado_3x', 'o destino mudou a cada tentativa de integração');
  }

  /**
   * Boot (03 §9.5): item em processamento com `sha_merge` já no destino →
   * `mergeado` (nunca re-mergeia); sem isso → recomeça do passo 1.
   */
  async reconciliar(): Promise<{ mergeados: string[]; recomecados: string[] }> {
    const n = this.n;
    const itens = await n.banco.ler((r) => r.filaMerge.emProcessamento());
    const mergeados: string[] = [];
    const recomecados: string[] = [];
    for (const item of itens) {
      const { execucao, projeto, config } = await n.carregar(item.execucao_id);
      let integrado = false;
      // `null` = não deu para conferir (rede): `sha_merge` fica para a próxima
      // tentativa conferir antes de integrar — nunca apaga sem confirmação negativa.
      let conferido = true;
      if (execucao.sha_merge) {
        try {
          const modo = config.entrega.modo === 'merge_local' ? 'merge_local' : 'merge_e_push';
          const ref =
            modo === 'merge_local'
              ? `refs/heads/${execucao.branch_destino}`
              : await resolverBaseIntegracao({
                  repoDir: projeto.repo_dir,
                  modo,
                  destino: execucao.branch_destino,
                  remoto: this.remoto(projeto, config.repo.remoto),
                });
          integrado = await jaIntegrado(projeto.repo_dir, execucao.sha_merge, ref);
        } catch {
          integrado = false;
          conferido = false;
        }
      }
      const dirInt = caminhoWorktreeIntegracao(n.deps.dirDados, projeto.slug, item.id);
      await removerWorktree(projeto.repo_dir, dirInt, { dirDados: n.deps.dirDados }).catch(
        () => {},
      );
      if (integrado && execucao.estado === 'integrando') {
        await this.mudarItem(item.id, 'concluido', { motivo: 'reconciliado no boot' });
        await n.transicionar(item.execucao_id, {
          tipo: 'integracao_concluida',
          resultado: 'mergeado',
        });
        mergeados.push(item.execucao_id);
      } else {
        await this.mudarItem(item.id, 'aguardando', { motivo: 'recomeça após reinício' });
        if (execucao.sha_merge && conferido) {
          await n.banco.transacao((r) =>
            r.execucoes.atualizar(item.execucao_id, { sha_merge: null }),
          );
        }
        recomecados.push(item.execucao_id);
      }
    }
    return { mergeados, recomecados };
  }
}
