/**
 * Provisiona um tenant de desenvolvimento completo e idempotente:
 *   tenant "acme" + admin + operador + cliente + agente_ia (service account).
 *
 * As senhas de dev são conhecidas e IMPRESSAS no console (apenas dev). Reexecutar
 * não duplica nada. Acesse pelo subdomínio: http://acme.localhost:3000/login
 */
import { carregarEnvRaiz } from './carregar-env';

carregarEnvRaiz();

const { criarAppDataSource } = await import('../data-source');
const { runInTenantContext } = await import('../rls');
const { provisionarTenant, atualizarStatusTenant, criarUsuarioAtivoComSenha, existeContaPorEmail } =
  await import('../auth');
const { UsuarioSchema } = await import('../entities/usuario');
const { ChamadoSchema } = await import('../entities/chamado');
const { criarChamado, transicionarStatus, atribuirOperador, definirComplexidade, atorSistema } =
  await import('../chamados/chamado-service');
const { criarMensagem } = await import('../chamados/mensagem-service');
const {
  Papel,
  StatusTenant,
  StatusChamado,
  Natureza,
  Prioridade,
  Complexidade,
  VisibilidadeMensagem,
} = await import('@chamados/shared');

const SLUG = 'acme';
const SENHA_DEV = 'Dev@12345';
const HUMANOS = [
  { papel: Papel.admin, email: 'admin@acme.dev', nome: 'Alice Admin' },
  { papel: Papel.operador, email: 'operador@acme.dev', nome: 'Otávio Operador' },
  { papel: Papel.cliente, email: 'cliente@acme.dev', nome: 'Carla Cliente' },
] as const;

async function main(): Promise<void> {
  const ds = criarAppDataSource();
  await ds.initialize();
  console.log('[seed-dev] conectado como role da aplicação (sem bypass).');

  try {
    // 1) Provisiona o tenant (cria agente_ia automaticamente). Idempotente.
    const prov = await provisionarTenant(ds, {
      slug: SLUG,
      nome: 'ACME Ltda',
      nomeExibicao: 'ACME Suporte',
      status: StatusTenant.em_provisionamento,
    });
    console.log(
      `[seed-dev] tenant ${SLUG} ${prov.criado ? 'criado' : 'já existia'} (id=${prov.tenant_id}); ` +
        `agente_ia=${prov.agente_ia_id}; categoria_geral=${prov.categoria_geral_id}`,
    );

    // 2) Cria os usuários humanos (idempotente por e-mail).
    await runInTenantContext(ds, prov.tenant_id, async (em) => {
      for (const h of HUMANOS) {
        if (await existeContaPorEmail(em, h.email)) {
          console.log(`[seed-dev]   • ${h.papel.padEnd(9)} ${h.email} (já existe)`);
          continue;
        }
        await criarUsuarioAtivoComSenha(em, {
          tenant_id: prov.tenant_id,
          email: h.email,
          nome: h.nome,
          papel: h.papel,
          senha: SENHA_DEV,
        });
        console.log(`[seed-dev]   • ${h.papel.padEnd(9)} ${h.email} (criado)`);
      }
    });

    // 3) Ativa o tenant (setup concluído).
    await atualizarStatusTenant(ds, prov.tenant_id, StatusTenant.ativo);

    // 4) Chamados de exemplo (idempotente): variam natureza/prioridade e status
    //    alcançados por transições LEGÍTIMAS (para os marcos seguintes). Sem
    //    sistema-alvo cadastrado, caem na categoria geral (specs/04 §2).
    await runInTenantContext(ds, prov.tenant_id, async (em) => {
      const jaTem = await em.count(ChamadoSchema, {});
      if (jaTem > 0) {
        console.log(`[seed-dev] chamados de exemplo já existem (${jaTem}); pulando.`);
        return;
      }

      const cliente = await em.findOne(UsuarioSchema, { where: { email: 'cliente@acme.dev' } });
      const operadorU = await em.findOne(UsuarioSchema, { where: { email: 'operador@acme.dev' } });
      if (!cliente || !operadorU) {
        console.warn('[seed-dev] cliente/operador não encontrados; sem chamados de exemplo.');
        return;
      }

      const atorCliente = { id: cliente.id, tenant_id: prov.tenant_id, papel: Papel.cliente };
      const atorOperador = { id: operadorU.id, tenant_id: prov.tenant_id, papel: Papel.operador };
      const atorIA = { id: prov.agente_ia_id, tenant_id: prov.tenant_id, papel: Papel.agente_ia };
      const sistema = atorSistema(prov.tenant_id);

      async function abrir(
        titulo: string,
        descricao: string,
        natureza: (typeof Natureza)[keyof typeof Natureza],
        prioridade: (typeof Prioridade)[keyof typeof Prioridade],
      ): Promise<string> {
        const r = await criarChamado(em, atorCliente, { titulo, descricao, natureza, prioridade });
        if (!r.ok) throw new Error(`falha ao criar chamado de exemplo: ${r.motivo}`);
        return r.id;
      }
      async function msg(
        chamadoId: string,
        ator: { id: string; tenant_id: string; papel: (typeof Papel)[keyof typeof Papel] },
        visibilidade: (typeof VisibilidadeMensagem)[keyof typeof VisibilidadeMensagem],
        corpo: string,
      ): Promise<void> {
        const r = await criarMensagem(em, ator, { chamado_id: chamadoId, visibilidade, corpo });
        if (!r.ok) throw new Error(`falha ao criar mensagem de exemplo: ${r.motivo}`);
      }

      // #1 novo (problema/alta) — recém-aberto, aguardando triagem.
      const c1 = await abrir(
        'Erro 500 ao salvar pedido',
        'Ao finalizar um pedido, aparece a mensagem de erro 500 e nada é salvo.',
        Natureza.problema,
        Prioridade.alta,
      );
      await msg(
        c1,
        atorCliente,
        VisibilidadeMensagem.publica,
        'Consigo reproduzir sempre no Chrome.',
      );

      // #2 em_atendimento (problema/media) — operador assumiu; complexidade média.
      const c2 = await abrir(
        'Botão de exportar não responde',
        'O botão "Exportar CSV" na tela de relatórios não faz nada ao ser clicado.',
        Natureza.problema,
        Prioridade.media,
      );
      await transicionarStatus(em, sistema, c2, StatusChamado.em_triagem);
      await transicionarStatus(em, atorOperador, c2, StatusChamado.em_atendimento);
      await atribuirOperador(em, atorOperador, c2, operadorU.id);
      await definirComplexidade(em, atorOperador, c2, Complexidade.medio);
      await msg(
        c2,
        atorOperador,
        VisibilidadeMensagem.publica,
        'Olá! Já estamos investigando o problema do CSV.',
      );
      await msg(
        c2,
        atorOperador,
        VisibilidadeMensagem.interna,
        'Nota interna: parece erro de encoding ao gerar o arquivo. Verificar o serviço de exportação.',
      );

      // #3 aguardando_cliente (alteracao/baixa) — a IA pediu mais informações.
      const c3 = await abrir(
        'Adicionar filtro por data no relatório',
        'Seria possível filtrar o relatório mensal por intervalo de datas?',
        Natureza.alteracao,
        Prioridade.baixa,
      );
      await transicionarStatus(em, sistema, c3, StatusChamado.em_triagem);
      await msg(
        c3,
        atorOperador,
        VisibilidadeMensagem.publica,
        'Você prefere filtrar por data de criação ou por data de fechamento?',
      );
      await transicionarStatus(em, atorIA, c3, StatusChamado.aguardando_cliente);
      await msg(
        c3,
        atorOperador,
        VisibilidadeMensagem.interna,
        'Nota interna: aguardando cliente definir o critério de data antes de gerar a SPEC.',
      );

      // #4 resolvido (problema/urgente) — ciclo completo até resolvido.
      const c4 = await abrir(
        'Login intermitente em horário de pico',
        'Alguns usuários não conseguem entrar entre 9h e 10h; cai na tela de login.',
        Natureza.problema,
        Prioridade.urgente,
      );
      await transicionarStatus(em, sistema, c4, StatusChamado.em_triagem);
      await transicionarStatus(em, atorOperador, c4, StatusChamado.em_atendimento);
      await atribuirOperador(em, atorOperador, c4, operadorU.id);
      await definirComplexidade(em, atorOperador, c4, Complexidade.facil);
      await msg(
        c4,
        atorOperador,
        VisibilidadeMensagem.publica,
        'Aumentamos o pool de conexões; pode testar novamente?',
      );
      await transicionarStatus(em, atorOperador, c4, StatusChamado.resolvido);

      console.log(
        '[seed-dev]   • 4 chamados de exemplo criados com mensagens (públicas e internas).',
      );
    });

    console.log('\n[seed-dev] PRONTO. Acesse: http://acme.localhost:3000/login');
    console.log('[seed-dev] Credenciais de dev (senha comum a todos):');
    for (const h of HUMANOS) {
      console.log(`[seed-dev]   ${h.papel.padEnd(9)} ${h.email}  /  ${SENHA_DEV}`);
    }
    console.log(
      '[seed-dev]   agente_ia  (service account — sem login por senha; credencial no cofre se AGENTE_IA_TOKEN estiver setado)',
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('[seed-dev] erro:', err);
  process.exit(1);
});
