import type { EntityManager } from 'typeorm';
import {
  autorizar,
  Papel,
  StatusChamado,
  Prioridade,
  TipoEvento,
  type Ator,
} from '@chamados/shared';
import { ChamadoSchema } from '../entities/chamado';
import { EventoChamadoSchema } from '../entities/evento-chamado';

/**
 * Métricas READ-ONLY do dashboard do painel (specs/08 §4.5, §3.1). Sem gráficos
 * históricos no MVP — cards agregados e listas acionáveis. Roda sob
 * `runInTenantContext` (RLS escopa o tenant) e após `autorizar()`. Nenhuma métrica
 * expõe dado interno ao cliente: o dashboard é área de operador/admin.
 */

/** Status considerados "abertos" (não terminais e ainda não resolvidos). */
const STATUS_ABERTOS: StatusChamado[] = [
  StatusChamado.novo,
  StatusChamado.em_triagem,
  StatusChamado.aguardando_cliente,
  StatusChamado.em_atendimento,
];

const MS_48H = 48 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;

export interface MetricasDashboard {
  /** Contagem por status (todos os sete valores canônicos). */
  porStatus: Record<StatusChamado, number>;
  /** Backlog aberto (soma dos status abertos). */
  backlogAberto: number;
  /** Resolvidos nos últimos 7 dias (evento `chamado_resolvido`). */
  resolvidosSemana: number;
  /** Urgentes sem operador atribuído (abertos). */
  urgentesSemAtribuicao: number;
  /** Aguardando cliente há mais de 48h. */
  aguardandoClienteAtrasado: number;
  /** Tempo médio até a 1ª resposta da equipe, em minutos (null se não derivável). */
  tempoMedioPrimeiraRespostaMin: number | null;
}

function equipe(ator: Ator): boolean {
  return (
    (ator.papel === Papel.operador || ator.papel === Papel.admin) &&
    autorizar(ator, 'chamado', 'ler', { tenant_id: ator.tenant_id })
  );
}

function statusZerados(): Record<StatusChamado, number> {
  return {
    [StatusChamado.novo]: 0,
    [StatusChamado.em_triagem]: 0,
    [StatusChamado.aguardando_cliente]: 0,
    [StatusChamado.em_atendimento]: 0,
    [StatusChamado.resolvido]: 0,
    [StatusChamado.fechado]: 0,
    [StatusChamado.cancelado]: 0,
  };
}

/** Coleta todas as métricas agregadas do dashboard em poucas queries. */
export async function metricasDashboard(em: EntityManager, ator: Ator): Promise<MetricasDashboard> {
  if (!equipe(ator)) {
    return {
      porStatus: statusZerados(),
      backlogAberto: 0,
      resolvidosSemana: 0,
      urgentesSemAtribuicao: 0,
      aguardandoClienteAtrasado: 0,
      tempoMedioPrimeiraRespostaMin: null,
    };
  }

  const agora = Date.now();
  const limite48h = new Date(agora - MS_48H);
  const limite7d = new Date(agora - MS_7D);

  // Contagem por status.
  const porStatus = statusZerados();
  const linhasStatus = await em
    .createQueryBuilder(ChamadoSchema, 'c')
    .select('c.status', 'status')
    .addSelect('COUNT(*)', 'n')
    .where('c.deleted_at IS NULL')
    .groupBy('c.status')
    .getRawMany<{ status: StatusChamado; n: string }>();
  for (const l of linhasStatus) porStatus[l.status] = Number(l.n);

  const backlogAberto = STATUS_ABERTOS.reduce((soma, s) => soma + porStatus[s], 0);

  // Resolvidos na semana: eventos de resolução nos últimos 7 dias.
  const resolvidosSemana = await em
    .createQueryBuilder(EventoChamadoSchema, 'e')
    .where('e.tipo = :tipo', { tipo: TipoEvento.chamado_resolvido })
    .andWhere('e.created_at >= :desde', { desde: limite7d })
    .getCount();

  // Urgentes sem atribuição (abertos).
  const urgentesSemAtribuicao = await em
    .createQueryBuilder(ChamadoSchema, 'c')
    .where('c.deleted_at IS NULL')
    .andWhere('c.operador_id IS NULL')
    .andWhere('c.prioridade = :urg', { urg: Prioridade.urgente })
    .andWhere('c.status IN (:...abertos)', { abertos: STATUS_ABERTOS })
    .getCount();

  // Aguardando cliente há mais de 48h.
  const aguardandoClienteAtrasado = await em
    .createQueryBuilder(ChamadoSchema, 'c')
    .where('c.deleted_at IS NULL')
    .andWhere('c.status = :aguardando', { aguardando: StatusChamado.aguardando_cliente })
    .andWhere('c.updated_at <= :limite', { limite: limite48h })
    .getCount();

  // Tempo médio até a 1ª resposta da equipe (primeira mensagem pública de
  // não-cliente), sobre chamados criados nos últimos 7 dias. Derivável da timeline.
  const tempoMedioPrimeiraRespostaMin = await calcularTempoMedioPrimeiraResposta(em, limite7d);

  return {
    porStatus,
    backlogAberto,
    resolvidosSemana,
    urgentesSemAtribuicao,
    aguardandoClienteAtrasado,
    tempoMedioPrimeiraRespostaMin,
  };
}

async function calcularTempoMedioPrimeiraResposta(
  em: EntityManager,
  desde: Date,
): Promise<number | null> {
  const linhas: Array<{ media: string | null }> = await em.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (fr.primeira - c.created_at)) / 60.0) AS media
       FROM chamado c
       JOIN LATERAL (
         SELECT MIN(m.created_at) AS primeira
           FROM mensagem m
           JOIN usuario u ON u.id = m.autor_id
          WHERE m.chamado_id = c.id
            AND m.deleted_at IS NULL
            AND m.visibilidade = 'publica'
            AND u.papel <> 'cliente'
       ) fr ON TRUE
      WHERE c.deleted_at IS NULL
        AND c.created_at >= $1
        AND fr.primeira IS NOT NULL`,
    [desde.toISOString()],
  );
  const media = linhas[0]?.media;
  if (media === null || media === undefined) return null;
  const n = Number(media);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Item acionável do bloco "Precisa de você" (specs/08 §3.1). */
export interface ItemAcionavel {
  id: string;
  numero: string;
  titulo: string;
  status: StatusChamado;
  prioridade: Prioridade;
  solicitante_nome: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BlocosPrecisaDeVoce {
  urgentesSemAtribuicao: ItemAcionavel[];
  paradosHaMuito: ItemAcionavel[];
}

function baseItemQb(em: EntityManager) {
  return em
    .createQueryBuilder(ChamadoSchema, 'c')
    .leftJoin('Usuario', 'sol', 'sol.id = c.cliente_id')
    .select('c.id', 'id')
    .addSelect('c.numero', 'numero')
    .addSelect('c.titulo', 'titulo')
    .addSelect('c.status', 'status')
    .addSelect('c.prioridade', 'prioridade')
    .addSelect('c.created_at', 'created_at')
    .addSelect('c.updated_at', 'updated_at')
    .addSelect('sol.nome', 'solicitante_nome')
    .where('c.deleted_at IS NULL');
}

function toItem(r: {
  id: string;
  numero: string;
  titulo: string;
  status: StatusChamado;
  prioridade: Prioridade;
  created_at: Date;
  updated_at: Date;
  solicitante_nome: string | null;
}): ItemAcionavel {
  return {
    id: r.id,
    numero: String(r.numero),
    titulo: r.titulo,
    status: r.status,
    prioridade: r.prioridade,
    solicitante_nome: r.solicitante_nome,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Listas acionáveis do bloco "Precisa de você" (specs/08 §3.1): urgentes sem
 * atribuição (mais antigos primeiro) e chamados parados há mais de 48h
 * (aguardando cliente / em atendimento sem movimento).
 */
export async function blocosPrecisaDeVoce(
  em: EntityManager,
  ator: Ator,
  limite = 6,
): Promise<BlocosPrecisaDeVoce> {
  if (!equipe(ator)) return { urgentesSemAtribuicao: [], paradosHaMuito: [] };

  const limite48h = new Date(Date.now() - MS_48H);

  const urgentes = await baseItemQb(em)
    .andWhere('c.operador_id IS NULL')
    .andWhere('c.prioridade = :urg', { urg: Prioridade.urgente })
    .andWhere('c.status IN (:...abertos)', { abertos: STATUS_ABERTOS })
    .orderBy('c.created_at', 'ASC')
    .limit(limite)
    .getRawMany();

  const parados = await baseItemQb(em)
    .andWhere('c.status IN (:...st)', {
      st: [StatusChamado.aguardando_cliente, StatusChamado.em_atendimento],
    })
    .andWhere('c.updated_at <= :limite', { limite: limite48h })
    .orderBy('c.updated_at', 'ASC')
    .limit(limite)
    .getRawMany();

  return {
    urgentesSemAtribuicao: urgentes.map(toItem),
    paradosHaMuito: parados.map(toItem),
  };
}
