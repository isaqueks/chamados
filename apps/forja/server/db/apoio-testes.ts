import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configProjetoDeResolvida,
  configResolvidaPadrao,
  type ConfigResolvida,
} from '../../comum/config-projeto';
import type { BancoForja } from './banco';
import { abrirBanco } from './data-source';
import type { Execucao } from './entidades/execucao';
import type { Relogio } from './ids';

/**
 * Apoio aos testes de `server/db` (só usado por `*.test.ts`): banco SQLite real
 * num diretório temporário, relógio controlável e uma semente mínima
 * (conexão → projeto → chamado → execução) para os testes de cada agregado.
 */

export interface Ambiente {
  dir: string;
  banco: BancoForja;
  relogio: Relogio & { avancar(ms: number): void };
  limpar(): Promise<void>;
}

export function relogioDeTeste(inicio = Date.parse('2026-10-02T12:00:00.000Z')) {
  let agora = inicio;
  const r = (() => new Date(agora)) as Relogio & { avancar(ms: number): void };
  r.avancar = (ms: number) => {
    agora += ms;
  };
  return r;
}

export async function ambienteTemporario(): Promise<Ambiente> {
  const dir = mkdtempSync(join(tmpdir(), 'forja-db-'));
  const relogio = relogioDeTeste();
  const banco = await abrirBanco({ dirDados: dir }, { relogio });
  return {
    dir,
    banco,
    relogio,
    async limpar() {
      await banco.fechar();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function configDeTeste(): ConfigResolvida {
  return configResolvidaPadrao({
    dir: '/tmp/repo-de-teste',
    remoto: 'origin',
    branch_destino: 'main',
    prefixo_branch: 'forja/',
  });
}

export interface Semente {
  conexaoId: string;
  projetoId: string;
  chamadoCacheId: string;
  execucao: Execucao;
}

/** Conexão + projeto + chamado #numero + execução `na_fila`. */
export async function semear(banco: BancoForja, numero = 42): Promise<Semente> {
  return banco.transacao(async (r) => {
    const conexao =
      (await r.conexoes.obterPorNome('dev-local')) ??
      (await r.conexoes.criar({
        nome: 'dev-local',
        url_base: 'http://localhost:3000',
        ambiente: 'dev',
        email: 'forja@exemplo.dev',
        local_senha: 'keyring',
      }));
    const projeto =
      (await r.projetos.obterPorSlug('acme')) ??
      (await r.projetos.criar({
        nome: 'Acme',
        slug: 'acme',
        conexao_id: conexao.id,
        config: configProjetoDeResolvida('Acme', configDeTeste()),
      }));
    const chamado = await r.chamados.gravarDaLista({
      conexao_id: conexao.id,
      chamado_id: `uuid-chamado-${numero}`,
      numero,
      titulo: `Chamado ${numero}`,
      status: 'em_atendimento',
      natureza: 'alteracao',
      prioridade: 'media',
    });
    const execucao = await r.execucoes.criar({
      conexao_id: conexao.id,
      chamado_id: chamado.chamado_id,
      chamado_cache_id: chamado.id,
      projeto_id: projeto.id,
      numero,
      config_snapshot: configDeTeste(),
    });
    return {
      conexaoId: conexao.id,
      projetoId: projeto.id,
      chamadoCacheId: chamado.id,
      execucao,
    };
  });
}
