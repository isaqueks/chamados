/**
 * Ponto de entrada dos spikes S1–S10 (specs/forja/08 §2):
 * `npm run spike:sN -w @chamados/forja` → `spike-sN.ts`.
 *
 * Cada spike roda num diretório temporário (clone descartável, nunca o
 * repositório de trabalho), imprime um veredito PASSOU/FALHOU/PENDENTE por
 * critério e grava o JSON + o stream bruto em `FORJA_SPIKES_SAIDA` (padrão
 * `<tmp>/forja-spikes`). Os spikes de CLI usam a assinatura REAL do usuário:
 * haiku para a mecânica e uma única rodada Fable + Opus (S2.d).
 *
 * S1 e S6 só condicionam o modo reforçado opcional (08 §1.4) e ficam fora
 * desta rodada: o comando responde PENDENTE.
 */
const SPIKES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] as const;
type NomeSpike = (typeof SPIKES)[number];

const SO_MODO_REFORCADO: readonly NomeSpike[] = ['s1', 's6'];

async function principal(): Promise<number> {
  const nome = process.argv[2] as NomeSpike | undefined;
  if (!nome || !SPIKES.includes(nome)) {
    console.error(`uso: spike.ts ${SPIKES.join('|')}`);
    return 1;
  }
  if (SO_MODO_REFORCADO.includes(nome)) {
    console.log(
      `[${nome}] PENDENTE — spike do modo reforçado opcional (08 §1.4); não bloqueia o MVP e não foi implementado nesta rodada.`,
    );
    return 0;
  }
  const modulo = (await import(`./spike-${nome}.ts`)) as { executar: () => Promise<number> };
  return modulo.executar();
}

principal().then(
  (codigo) => process.exit(codigo),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
