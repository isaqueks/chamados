import { describe, it, expect } from 'vitest';
import { autorizar, type Ator } from './autorizacao';
import { Papel } from './enums';

const TENANT = '11111111-1111-1111-1111-111111111111';

function ator(papel: Papel, id = 'u-1', tenant_id = TENANT): Ator {
  return { papel, id, tenant_id };
}

describe('autorizar — matriz papel × recurso × ação (specs/03 §8)', () => {
  describe('cliente NÃO vê recurso interno (fronteira inegociável §7)', () => {
    it('cliente não lê nota interna', () => {
      expect(autorizar(ator(Papel.cliente), 'mensagem_interna', 'ler')).toBe(false);
    });

    it('cliente não escreve nota interna', () => {
      expect(autorizar(ator(Papel.cliente), 'mensagem_interna', 'escrever')).toBe(false);
    });

    it('cliente não classifica complexidade', () => {
      expect(autorizar(ator(Papel.cliente), 'chamado', 'classificar_complexidade')).toBe(false);
    });

    it('cliente não lê ExecucaoIA', () => {
      expect(autorizar(ator(Papel.cliente), 'execucao_ia', 'ler')).toBe(false);
    });

    it('cliente lê mensagem pública do próprio chamado (ownership)', () => {
      const c = ator(Papel.cliente, 'cli-1');
      expect(autorizar(c, 'mensagem_publica', 'ler', { autor_id: 'cli-1' })).toBe(true);
      expect(autorizar(c, 'mensagem_publica', 'ler', { autor_id: 'outro' })).toBe(false);
    });

    it('cliente lê o próprio chamado, não o de outro', () => {
      const c = ator(Papel.cliente, 'cli-1');
      expect(autorizar(c, 'chamado', 'ler', { cliente_id: 'cli-1' })).toBe(true);
      expect(autorizar(c, 'chamado', 'ler', { cliente_id: 'cli-2' })).toBe(false);
    });

    it('cliente NÃO muda prioridade/natureza pós-criação (define só na abertura)', () => {
      const c = ator(Papel.cliente, 'cli-1');
      // Mesmo sendo o dono do chamado, o cliente não reclassifica depois de abrir.
      expect(autorizar(c, 'chamado', 'mudar_prioridade', { cliente_id: 'cli-1' })).toBe(false);
      expect(autorizar(c, 'chamado', 'mudar_natureza', { cliente_id: 'cli-1' })).toBe(false);
    });

    it('cliente PODE mudar status do próprio chamado (cancelar/reabrir/responder)', () => {
      const c = ator(Papel.cliente, 'cli-1');
      expect(autorizar(c, 'chamado', 'mudar_status', { cliente_id: 'cli-1' })).toBe(true);
      expect(autorizar(c, 'chamado', 'mudar_status', { cliente_id: 'cli-2' })).toBe(false);
    });
  });

  describe('operador NÃO gerencia usuários (§8.2)', () => {
    it('operador não lista usuários', () => {
      expect(autorizar(ator(Papel.operador), 'usuario', 'listar')).toBe(false);
    });

    it('operador não edita papel/desativa usuários', () => {
      expect(autorizar(ator(Papel.operador), 'usuario', 'editar')).toBe(false);
      expect(autorizar(ator(Papel.operador), 'usuario', 'desativar')).toBe(false);
    });

    it('operador convida cliente só se o tenant habilitar', () => {
      const op = ator(Papel.operador);
      expect(
        autorizar(op, 'usuario', 'convidar', {
          papel_convidado: Papel.cliente,
          operador_pode_convidar_cliente: true,
        }),
      ).toBe(true);
      expect(
        autorizar(op, 'usuario', 'convidar', {
          papel_convidado: Papel.cliente,
          operador_pode_convidar_cliente: false,
        }),
      ).toBe(false);
    });

    it('operador NÃO convida operador nem admin', () => {
      const op = ator(Papel.operador);
      expect(
        autorizar(op, 'usuario', 'convidar', {
          papel_convidado: Papel.operador,
          operador_pode_convidar_cliente: true,
        }),
      ).toBe(false);
      expect(
        autorizar(op, 'usuario', 'convidar', {
          papel_convidado: Papel.admin,
          operador_pode_convidar_cliente: true,
        }),
      ).toBe(false);
    });

    it('operador não gerencia branding/guardrails/config de notificações', () => {
      const op = ator(Papel.operador);
      expect(autorizar(op, 'branding', 'gerenciar')).toBe(false);
      expect(autorizar(op, 'guardrail_ia', 'gerenciar')).toBe(false);
      expect(autorizar(op, 'config_notificacoes', 'editar')).toBe(false);
      expect(autorizar(op, 'config_notificacoes', 'ler')).toBe(true); // ⚠️ leitura ok
    });

    it('operador NÃO edita config do tenant, mas PODE ler (recurso dedicado M10)', () => {
      const op = ator(Papel.operador);
      expect(autorizar(op, 'config_tenant', 'editar')).toBe(false);
      expect(autorizar(op, 'config_tenant', 'ler')).toBe(true); // ⚠️ leitura ok
    });
  });

  describe('admin ⊇ operador e capacidades exclusivas', () => {
    it('admin faz o que o operador faz (herança)', () => {
      const a = ator(Papel.admin);
      expect(autorizar(a, 'chamado', 'fechar')).toBe(true);
      expect(autorizar(a, 'chamado', 'atribuir')).toBe(true);
      expect(autorizar(a, 'mensagem_interna', 'ler')).toBe(true);
    });

    it('operador/admin reclassificam prioridade e natureza', () => {
      for (const p of [Papel.operador, Papel.admin]) {
        expect(autorizar(ator(p), 'chamado', 'mudar_prioridade')).toBe(true);
        expect(autorizar(ator(p), 'chamado', 'mudar_natureza')).toBe(true);
      }
    });

    it('admin gerencia usuários, branding e guardrails', () => {
      const a = ator(Papel.admin);
      expect(autorizar(a, 'usuario', 'listar')).toBe(true);
      expect(autorizar(a, 'usuario', 'editar')).toBe(true);
      expect(autorizar(a, 'usuario', 'desativar')).toBe(true);
      expect(autorizar(a, 'branding', 'gerenciar')).toBe(true);
      expect(autorizar(a, 'guardrail_ia', 'gerenciar')).toBe(true);
      expect(autorizar(a, 'sessao', 'encerrar_terceiros')).toBe(true);
    });

    it('admin edita a config do tenant (recurso dedicado M10)', () => {
      const a = ator(Papel.admin);
      expect(autorizar(a, 'config_tenant', 'editar')).toBe(true);
      expect(autorizar(a, 'config_tenant', 'ler')).toBe(true);
    });

    it('cliente e agente_ia não acessam config do tenant', () => {
      expect(autorizar(ator(Papel.cliente), 'config_tenant', 'editar')).toBe(false);
      expect(autorizar(ator(Papel.cliente), 'config_tenant', 'ler')).toBe(false);
      expect(autorizar(ator(Papel.agente_ia), 'config_tenant', 'editar')).toBe(false);
      expect(autorizar(ator(Papel.agente_ia), 'config_tenant', 'ler')).toBe(false);
    });

    it('admin convida qualquer papel', () => {
      const a = ator(Papel.admin);
      expect(autorizar(a, 'usuario', 'convidar', { papel_convidado: Papel.operador })).toBe(true);
      expect(autorizar(a, 'usuario', 'convidar', { papel_convidado: Papel.admin })).toBe(true);
    });
  });

  describe('agente_ia limitado ao domínio do chamado (§6)', () => {
    it('pode atuar dentro do chamado (nota interna, complexidade, mensagem pública)', () => {
      const ia = ator(Papel.agente_ia, 'ia-1');
      expect(autorizar(ia, 'mensagem_interna', 'escrever')).toBe(true);
      expect(autorizar(ia, 'mensagem_publica', 'escrever')).toBe(true);
      expect(autorizar(ia, 'chamado', 'classificar_complexidade')).toBe(true);
      expect(autorizar(ia, 'chamado', 'mudar_prioridade')).toBe(true);
      expect(autorizar(ia, 'chamado', 'mudar_natureza')).toBe(true);
      expect(autorizar(ia, 'chamado', 'ler', { tenant_id: TENANT })).toBe(true);
    });

    it('NÃO fecha/cancela chamado nem aprova PR (guardrail humano)', () => {
      const ia = ator(Papel.agente_ia);
      expect(autorizar(ia, 'chamado', 'fechar')).toBe(false);
      expect(autorizar(ia, 'chamado', 'cancelar')).toBe(false);
      expect(autorizar(ia, 'chamado', 'atribuir')).toBe(false);
      expect(autorizar(ia, 'pr_ia', 'aprovar')).toBe(false);
    });

    it('NÃO administra o tenant (usuários, sistemas-alvo, branding)', () => {
      const ia = ator(Papel.agente_ia);
      expect(autorizar(ia, 'usuario', 'convidar', { papel_convidado: Papel.cliente })).toBe(false);
      expect(autorizar(ia, 'sistema_alvo', 'ler')).toBe(false);
      expect(autorizar(ia, 'sistema_alvo', 'editar')).toBe(false);
      expect(autorizar(ia, 'branding', 'gerenciar')).toBe(false);
      expect(autorizar(ia, 'categoria', 'editar')).toBe(false);
    });
  });

  describe('default deny', () => {
    it('nega ação/recurso sem regra explícita', () => {
      // cliente escrever nota interna já testado; aqui: papel sem regra p/ ação.
      expect(autorizar(ator(Papel.cliente), 'sistema_alvo', 'ler')).toBe(false);
      expect(autorizar(ator(Papel.cliente), 'branding', 'gerenciar')).toBe(false);
    });
  });
});
