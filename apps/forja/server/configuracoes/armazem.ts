import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfiguracoesGlobaisSchema,
  configuracoesGlobaisPadrao,
  type ConfiguracoesGlobais,
} from '../../comum/config-projeto';

/**
 * Configurações globais da Forja (specs/forja/02; FJ-030 §2) em
 * `<dados>/configuracoes.json`: modelos, cota, concorrência, limites e gates —
 * o que antes se repetia em cada projeto.
 *
 * POR QUE arquivo e não tabela: é UM documento pequeno, editável à mão em
 * emergência (e o `forja.db` é negado ao agente por inteiro; este arquivo
 * também, pela regra de `<dados>` — settings-gerados). Leitura síncrona com
 * cache: o domínio consulta a cada execução criada e a cada vaga, e o arquivo
 * só muda pela tela (gravar/restaurar passam por aqui e trocam o cache).
 *
 * Arquivo ausente = padrões (sem gravar nada). Arquivo inválido = erro
 * explícito na leitura (02 §1: nunca default silencioso sobre dado corrompido)
 * — o boot mostra o caminho e o problema; "Restaurar padrões" regrava.
 */

export const ARQUIVO_CONFIGURACOES = 'configuracoes.json';

export class ErroConfiguracoes extends Error {
  constructor(
    mensagem: string,
    readonly problemas: { campo: string; mensagem: string }[] = [],
  ) {
    super(mensagem);
    this.name = 'ErroConfiguracoes';
  }
}

/** Valida (completando os campos ausentes com o padrão) ou lança com a lista de problemas. */
export function validarConfiguracoes(bruto: unknown): ConfiguracoesGlobais {
  const r = ConfiguracoesGlobaisSchema.safeParse(bruto ?? {});
  if (!r.success) {
    throw new ErroConfiguracoes(
      'configurações globais inválidas',
      r.error.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })),
    );
  }
  return r.data;
}

export class ArmazemConfiguracoes {
  readonly caminho: string;
  private cache: ConfiguracoesGlobais | null = null;
  private readonly ouvintes = new Set<(c: ConfiguracoesGlobais) => void>();

  constructor(dirDados: string) {
    this.caminho = join(dirDados, ARQUIVO_CONFIGURACOES);
  }

  /** Configuração vigente (cacheada). Lança `ErroConfiguracoes` se o arquivo estiver corrompido. */
  ler(): ConfiguracoesGlobais {
    if (this.cache) return this.cache;
    let texto: string;
    try {
      texto = readFileSync(this.caminho, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = configuracoesGlobaisPadrao();
        return this.cache;
      }
      throw e;
    }
    let bruto: unknown;
    try {
      bruto = JSON.parse(texto);
    } catch (e) {
      throw new ErroConfiguracoes(`${this.caminho} não é JSON válido: ${(e as Error).message}`);
    }
    this.cache = validarConfiguracoes(bruto);
    return this.cache;
  }

  /** Valida, completa com os padrões e grava (atômico: temporário + rename, 0600). */
  gravar(bruto: unknown): ConfiguracoesGlobais {
    const c = validarConfiguracoes(bruto);
    this.escrever(c);
    return c;
  }

  /** "Restaurar padrões". */
  restaurar(): ConfiguracoesGlobais {
    const c = configuracoesGlobaisPadrao();
    this.escrever(c);
    return c;
  }

  /** Avisado depois de cada gravação (ex.: o domínio reajusta os semáforos de concorrência). */
  aoMudar(ouvinte: (c: ConfiguracoesGlobais) => void): () => void {
    this.ouvintes.add(ouvinte);
    return () => this.ouvintes.delete(ouvinte);
  }

  private escrever(c: ConfiguracoesGlobais): void {
    mkdirSync(join(this.caminho, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.caminho}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.caminho);
    this.cache = c;
    for (const o of this.ouvintes) o(c);
  }
}
