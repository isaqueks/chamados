import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BannerDto } from '@comum/dto';
import { aoSessaoExpirada, api, urlRota } from '@/lib/api';
import {
  deveIrAoOnboarding,
  precisaOnboarding,
  ROTA_ONBOARDING,
} from '@/componentes/onboarding/logica';
import { assinarSse, type EstadoConexaoSse } from '@/lib/sse';
import { TelaSessaoExpirada } from '@/telas/sessao-expirada';
import { Banners } from './banners';
import { Cabecalho } from './cabecalho';
import { ProjetoAtualProvider } from './projeto-atual';
import { Sidebar } from './sidebar';

/**
 * Shell da Forja (specs/forja/06 §1): sidebar escura + cabeçalho fixo +
 * banners + a tela. O shell vem de `GET /api/shell` e é invalidado pelos
 * eventos do SSE global (`GET /api/eventos`, 01 §8.1). Enquanto a rota não
 * existir no servidor (501), o shell renderiza vazio, sem quebrar as telas.
 */

const CHAVE_SIDEBAR = 'forja:sidebar-recolhida';
const ATRASO_BANNER_STREAM_MS = 30_000;

function lerRecolhida(): boolean {
  try {
    return window.localStorage.getItem(CHAVE_SIDEBAR) === '1';
  } catch {
    return false;
  }
}

export function Layout() {
  const clienteQuery = useQueryClient();
  const [sessaoExpirada, setSessaoExpirada] = useState(false);
  const [recolhida, setRecolhida] = useState(lerRecolhida);
  const [estadoStream, setEstadoStream] = useState<EstadoConexaoSse>('conectando');
  const [streamCaiuHaMuito, setStreamCaiuHaMuito] = useState(false);

  useEffect(() => aoSessaoExpirada(() => setSessaoExpirada(true)), []);

  // Primeiro acesso (sem conexão ou sem projeto): a Fila cede lugar ao
  // onboarding de 2 passos (FJ-030 §5). Mesmas chaves das telas: cache comum.
  const { pathname } = useLocation();
  const conexoes = useQuery({
    queryKey: ['conexoes'],
    queryFn: ({ signal }) => api('conexoes_listar', { sinal: signal }),
  });
  const projetos = useQuery({
    queryKey: ['projetos'],
    queryFn: ({ signal }) => api('projetos_listar', { sinal: signal }),
  });
  const irAoOnboarding = deveIrAoOnboarding(
    pathname,
    precisaOnboarding(conexoes.data?.conexoes, projetos.data?.projetos),
  );

  const { data: shell } = useQuery({
    queryKey: ['shell'],
    queryFn: ({ signal }) => api('shell_obter', { sinal: signal }),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const assinatura = assinarSse({
      caminho: urlRota('eventos_global'),
      aoEvento: () => {
        void clienteQuery.invalidateQueries({ queryKey: ['shell'] });
      },
      aoRecarregar: () => {
        void clienteQuery.invalidateQueries();
      },
      aoEstado: setEstadoStream,
    });
    return () => assinatura.fechar();
  }, [clienteQuery]);

  useEffect(() => {
    if (estadoStream === 'conectado') {
      setStreamCaiuHaMuito(false);
      return;
    }
    const t = setTimeout(() => setStreamCaiuHaMuito(true), ATRASO_BANNER_STREAM_MS);
    return () => clearTimeout(t);
  }, [estadoStream]);

  const n = shell?.aguardando_voce.length ?? 0;
  useEffect(() => {
    document.title = n > 0 ? `(${n}) Forja` : 'Forja';
  }, [n]);

  if (sessaoExpirada) return <TelaSessaoExpirada />;

  const banners: BannerDto[] = [...(shell?.banners ?? [])];
  if (streamCaiuHaMuito) {
    banners.push({
      tipo: 'stream_desconectado',
      nivel: 'aviso',
      mensagem: 'Atualizações ao vivo desconectadas há mais de 30 s. Recarregue a página.',
      acao: null,
    });
  }

  function alternarSidebar(): void {
    setRecolhida((r) => {
      try {
        window.localStorage.setItem(CHAVE_SIDEBAR, r ? '0' : '1');
      } catch {
        // ignora
      }
      return !r;
    });
  }

  return (
    <ProjetoAtualProvider>
      <div className="flex h-svh overflow-hidden bg-background text-foreground">
        <Sidebar
          contadores={shell?.contadores ?? null}
          recolhida={recolhida}
          alternar={alternarSidebar}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Cabecalho shell={shell ?? null} estadoStream={estadoStream} />
          <Banners banners={banners} />
          <main className="flex-1 overflow-y-auto">
            {irAoOnboarding ? <Navigate to={ROTA_ONBOARDING} replace /> : <Outlet />}
          </main>
        </div>
      </div>
    </ProjetoAtualProvider>
  );
}
