import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, resolverSha, statusPorcelain } from '../../git/git';
import {
  atualizarRefCas,
  avancarRefLocal,
  calcularPatchId,
  estadoCopiaUsuario,
  integrarEmWorktreeDestacada,
  jaIntegrado,
  mensagemMerge,
  patchIdConfere,
  pushDestino,
  resolverBaseIntegracao,
  type Remoto,
} from '../../git/integracao';
import { removerWorktree } from '../../git/worktrees';
import { criarAreaTemporaria, executarSpike, vereditoDe } from './apoio';

/**
 * S9 — fila de merge com a cópia do usuário na `main` e SUJA (specs/forja/08
 * §2; 03 §8.1–§8.2). Só git, em repositórios temporários, com as funções de
 * produção de `server/git` (`resolverBaseIntegracao`, `integrarEmWorktreeDestacada`,
 * `calcularPatchId`, `pushDestino`, `avancarRefLocal`, `atualizarRefCas`).
 *
 * Cenário: remoto bare; cópia do usuário com `main` em checkout e suja
 * (arquivo rastreado alterado + não rastreado); branch do chamado numa
 * worktree da Forja; um colega empurra para a `main` remota ANTES da
 * integração e de novo ENTRE a integração e o push (corrida) — o push
 * não-ff é recusado e o item refaz T0 → merge → push. A cópia do usuário não
 * pode mudar em nada.
 */

async function commitar(
  dir: string,
  arquivo: string,
  conteudo: string,
  msg: string,
): Promise<string> {
  await writeFile(join(dir, arquivo), conteudo);
  await git(['add', arquivo], { cwd: dir });
  await git(['commit', '--quiet', '-m', msg], { cwd: dir });
  return (await resolverSha(dir, 'HEAD')) as string;
}

async function identidade(dir: string): Promise<void> {
  await git(['config', 'user.email', 'spike@forja.local'], { cwd: dir });
  await git(['config', 'user.name', 'Spike Forja'], { cwd: dir });
}

function sha256Arquivo(caminho: string): string {
  return createHash('sha256').update(readFileSync(caminho)).digest('hex');
}

export async function executar(): Promise<number> {
  return executarSpike('s9', 'Fila de merge com a cópia do usuário na main (F-10)', async (r) => {
    const area = await criarAreaTemporaria('s9');
    try {
      const raiz = area.raiz;
      const remoto = join(raiz, 'remoto.git');
      const usuario = join(raiz, 'usuario');
      const colega = join(raiz, 'colega');
      const dados = join(raiz, 'dados');
      await git(['init', '--quiet', '--bare', '--initial-branch', 'main', remoto], { cwd: raiz });
      await git(['clone', '--quiet', remoto, colega], { cwd: raiz });
      await identidade(colega);
      await git(['checkout', '--quiet', '-b', 'main'], { cwd: colega });
      await commitar(colega, 'app.txt', 'linha 1\n', 'A');
      await commitar(colega, 'leia-me.txt', 'leia-me\n', 'A2');
      await git(['push', '--quiet', 'origin', 'main'], { cwd: colega });

      // Cópia do usuário: `main` em checkout, SUJA (rastreado alterado + não rastreado).
      await git(['clone', '--quiet', remoto, usuario], { cwd: raiz });
      await identidade(usuario);
      await writeFile(join(usuario, 'leia-me.txt'), 'leia-me\nedição local não commitada\n');
      await writeFile(join(usuario, 'rascunho.txt'), 'não rastreado\n');
      const antes = {
        status: (await statusPorcelain(usuario)).join('\n'),
        head: await resolverSha(usuario, 'HEAD'),
        leiaMe: sha256Arquivo(join(usuario, 'leia-me.txt')),
        rascunho: sha256Arquivo(join(usuario, 'rascunho.txt')),
      };

      // Branch do chamado numa worktree da Forja (a partir da main local).
      const wt = join(dados, 'worktrees', 'projeto', 'exec-1');
      await mkdir(join(dados, 'worktrees', 'projeto'), { recursive: true });
      await git(['worktree', 'add', '--quiet', '-b', 'forja/chamado-1-teste', wt, 'main'], {
        cwd: usuario,
      });
      await commitar(wt, 'novo.txt', 'feature do chamado\n', 'forja: passo 1/1');
      const shaBranch = (await resolverSha(wt, 'HEAD')) as string;
      const shaBaseBranch = (await resolverSha(usuario, 'refs/heads/main')) as string;
      // patch-id aprovado no G2: diff da branch sobre a base dela.
      const aprovado = await calcularPatchId(usuario, shaBaseBranch, shaBranch);

      // Colega empurra B antes da integração.
      await git(['pull', '--quiet', '--ff-only'], { cwd: colega });
      await commitar(colega, 'app.txt', 'linha 1\nlinha B do colega\n', 'B');
      await git(['push', '--quiet', 'origin', 'main'], { cwd: colega });

      const rem: Remoto = { nome: 'origin', urlEsperada: remoto };
      const integrar = async (n: number) => {
        const t0 = await resolverBaseIntegracao({
          repoDir: usuario,
          modo: 'merge_e_push',
          destino: 'main',
          remoto: rem,
        });
        const dirInt = join(dados, 'worktrees', 'projeto', '_integracao', `int-${n}`);
        const res = await integrarEmWorktreeDestacada({
          repoDir: usuario,
          dirDados: dados,
          dirIntegracao: dirInt,
          t0,
          branch: 'forja/chamado-1-teste',
          mensagem: mensagemMerge(1, 'teste do spike'),
        });
        if (res.tipo !== 'limpo')
          throw new Error(`conflito inesperado: ${res.arquivos.join(', ')}`);
        const integrado = await calcularPatchId(usuario, t0, res.sha);
        return { t0, sha: res.sha, dirInt, integrado };
      };

      const i1 = await integrar(1);
      // Corrida: o colega empurra C entre a integração e o push.
      await git(['pull', '--quiet', '--ff-only'], { cwd: colega });
      await commitar(colega, 'app.txt', 'linha 1\nlinha B do colega\nlinha C\n', 'C');
      await git(['push', '--quiet', 'origin', 'main'], { cwd: colega });
      const push1 = await pushDestino({
        repoDir: usuario,
        remoto: rem,
        sha: i1.sha,
        destino: 'main',
      });
      await removerWorktree(usuario, i1.dirInt, { dirDados: dados });

      const i2 = await integrar(2);
      const push2 = await pushDestino({
        repoDir: usuario,
        remoto: rem,
        sha: i2.sha,
        destino: 'main',
      });
      await removerWorktree(usuario, i2.dirInt, { dirDados: dados });
      const remotoMain = (
        await git(['rev-parse', 'refs/heads/main'], { cwd: remoto })
      ).stdout.trim();

      const copia = await estadoCopiaUsuario(usuario, 'main');
      const avanco = await avancarRefLocal({ repoDir: usuario, destino: 'main', novo: i2.sha });
      const depois = {
        status: (await statusPorcelain(usuario)).join('\n'),
        head: await resolverSha(usuario, 'HEAD'),
        leiaMe: sha256Arquivo(join(usuario, 'leia-me.txt')),
        rascunho: sha256Arquivo(join(usuario, 'rascunho.txt')),
      };
      await git(['fetch', '--quiet', 'origin'], { cwd: usuario });
      const atras = !(await jaIntegrado(usuario, i2.sha, 'refs/heads/main'));
      const integradoNoRemoto = await jaIntegrado(usuario, i2.sha, 'refs/remotes/origin/main');

      // CAS: ref que andou desde a leitura é recusada (fora de checkout).
      await git(['branch', 'outra', antes.head as string], { cwd: usuario });
      const lida = (await resolverSha(usuario, 'refs/heads/outra')) as string;
      await git(['update-ref', 'refs/heads/outra', i1.t0], { cwd: usuario }); // "andou"
      const cas = await atualizarRefCas(usuario, 'refs/heads/outra', i2.sha, lida);
      const outraDepois = await resolverSha(usuario, 'refs/heads/outra');
      const avancoCas = await avancarRefLocal({
        repoDir: usuario,
        destino: 'outra',
        novo: i2.sha,
        antigo: lida,
      });

      // Cópia LIMPA em checkout: ff da cópia (caso feliz do 03 §8.2).
      const limpa = join(raiz, 'usuario-limpa');
      await git(['clone', '--quiet', remoto, limpa], { cwd: raiz });
      await git(['reset', '--quiet', '--hard', antes.head as string], { cwd: limpa });
      const avancoLimpa = await avancarRefLocal({
        repoDir: limpa,
        destino: 'main',
        novo: remotoMain,
      });

      r.anexar('shas', {
        base: shaBaseBranch,
        branch: shaBranch,
        t0_1: i1.t0,
        merge_1: i1.sha,
        t0_2: i2.t0,
        merge_2: i2.sha,
        remoto_main: remotoMain,
      });
      r.anexar('patch_ids', { aprovado, integrado_1: i1.integrado, integrado_2: i2.integrado });
      r.anexar('push', { primeiro: push1, segundo: push2 });
      r.anexar('copia_usuario', { antes, depois, estado: copia, avanco });
      r.anexar('cas', { cas, outraDepois, avancoCas, avancoLimpa });

      r.criterio(
        'S9.a',
        'push direto `sha:refs/heads/main` não-ff é recusado e refeito (T0 → merge → push)',
        vereditoDe(
          push1.resultado === 'recusado_nao_ff' &&
            push2.resultado === 'aceito' &&
            remotoMain === i2.sha,
        ),
        `1º push: ${push1.resultado}${push1.resultado !== 'aceito' ? ` (${push1.detalhe.slice(0, 100)})` : ''}; 2º push: ${push2.resultado}; main remota = merge 2: ${remotoMain === i2.sha}`,
      );
      r.criterio(
        'S9.b',
        'cópia do usuário intacta (status, HEAD e conteúdo iguais antes/depois)',
        vereditoDe(JSON.stringify(antes) === JSON.stringify(depois)),
        `status antes="${antes.status.replace(/\n/g, ' | ')}" depois="${depois.status.replace(/\n/g, ' | ')}"; HEAD igual=${antes.head === depois.head}`,
      );
      r.criterio(
        'S9.c',
        'a ref local não é mexida com a cópia suja e o app sabe avisar "sua main local está atrás"',
        vereditoDe(
          copia.emCheckout &&
            copia.suja &&
            avanco.resultado === 'intocada' &&
            atras &&
            integradoNoRemoto,
        ),
        `estadoCopiaUsuario: emCheckout=${copia.emCheckout} suja=${copia.suja}; avancarRefLocal → ${avanco.resultado}${avanco.resultado === 'intocada' ? `/${avanco.motivo}` : ''}; local atrás=${atras}; merge na origin/main=${integradoNoRemoto}`,
      );
      r.criterio(
        'S9.d',
        'CAS recusa ref que andou desde a leitura (update-ref e avancarRefLocal)',
        vereditoDe(!cas && outraDepois === i1.t0 && avancoCas.resultado === 'cas_recusado'),
        `atualizarRefCas=${cas}; ref continuou no valor novo=${outraDepois === i1.t0}; avancarRefLocal → ${avancoCas.resultado}`,
      );
      r.criterio(
        'S9.e',
        'patch-id estável: o integrado (T0 diferente, após a corrida) confere com o aprovado',
        vereditoDe(
          patchIdConfere(aprovado, i1.integrado) && patchIdConfere(aprovado, i2.integrado),
        ),
        `aprovado=${String(aprovado).slice(0, 12)} integrado1=${String(i1.integrado).slice(0, 12)} integrado2=${String(i2.integrado).slice(0, 12)}`,
      );
      r.criterio(
        'S9.f',
        'cópia LIMPA em checkout avança por `merge --ff-only`',
        vereditoDe(avancoLimpa.resultado === 'avancada'),
        `avancarRefLocal → ${avancoLimpa.resultado}${avancoLimpa.resultado === 'avancada' ? `/${avancoLimpa.modo}` : ''}`,
      );
    } finally {
      await area.limpar();
    }
  });
}
