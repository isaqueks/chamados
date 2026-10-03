import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { criarRepoTemporario, type RepoTemporario } from './apoio-testes';
import {
  calcularSelos,
  casaAlgum,
  diffDependencias,
  expandirChaves,
  selosDoDiff,
  type Detectores,
} from './selos';

/** Defaults de 02 §6 / 04 §7.1. */
const DETECTORES: Detectores = {
  banco: ['**/migrations/**', '**/*.entity.ts', '**/schema.prisma', '**/*.sql'],
  regra_negocio: ['packages/shared/**', '**/servicos/**', '**/*-service.ts', '**/maquina-estados*'],
  sensivel: [
    'package.json',
    '*lock*',
    '.github/**',
    '.husky/**',
    '.claude/**',
    'Dockerfile*',
    '**/auth/**',
  ],
  docs_exigidas: ['CHANGELOG.md', 'specs/**'],
  frontend: ['apps/web/src/app/**/*.tsx', 'apps/web/src/components/**', '**/*.css'],
};

describe('glob', () => {
  it('expande chaves', () => {
    expect(expandirChaves('a/{b,c}/{d,e}.ts')).toEqual([
      'a/b/d.ts',
      'a/b/e.ts',
      'a/c/d.ts',
      'a/c/e.ts',
    ]);
  });

  it.each([
    ['packages/db/src/migrations/1-x.ts', '**/migrations/**', true],
    ['migrations/1.sql', '**/migrations/**', true],
    ['src/xmigrations/1.ts', '**/migrations/**', false],
    ['package.json', 'package.json', true],
    ['apps/web/package.json', 'package.json', false],
    ['apps/web/package.json', '**/package.json', true],
    ['package-lock.json', '*lock*', true],
    ['apps/x/package-lock.json', '*lock*', false],
    ['.github/workflows/ci.yml', '.github/**', true],
    ['.claude/settings.json', '.claude/**', true],
    ['apps/web/src/app/page.tsx', 'apps/web/src/app/**/*.tsx', true],
    ['apps/web/src/app/(auth)/login/page.tsx', 'apps/web/src/app/**/*.tsx', true],
    ['src/styles/.hidden.css', '**/*.css', true],
    ['src/a.ts', 'src/[ab].ts', true],
    ['src/c.ts', 'src/[!ab].ts', true],
    ['src/a.ts', 'src/?.ts', true],
    ['src/a/b.ts', 'src/*.ts', false],
    ['src/x.test.ts', 'src/*.{test,spec}.ts', true],
  ])('%s × %s → %s', (caminho, glob, esperado) => {
    expect(casaAlgum(caminho, [glob])).toBe(esperado);
  });
});

describe('calcularSelos', () => {
  it('liga cada selo pelos globs e lista os sensíveis', () => {
    const { selos, por_arquivo } = calcularSelos(
      [
        'packages/db/src/migrations/17-x.ts',
        'packages/shared/src/maquina-estados.ts',
        'package.json',
        'apps/web/src/components/botao.tsx',
        'README.md',
      ],
      DETECTORES,
    );
    expect(selos).toEqual({
      altera_banco: true,
      altera_regra_negocio: true,
      altera_ui: true,
      sensivel: ['package.json'],
      docs_exigidas_ok: false,
    });
    expect(por_arquivo.find((a) => a.caminho === 'README.md')?.selos).toEqual([]);
  });

  it('altera_ui também pelo plano (areas ∋ ui), sem arquivo de frontend', () => {
    expect(calcularSelos(['src/i18n.json'], DETECTORES, ['ui']).selos.altera_ui).toBe(true);
    expect(calcularSelos(['src/i18n.json'], DETECTORES, ['api']).selos.altera_ui).toBe(false);
  });

  it('docs_exigidas_ok: cada glob tocado; null sem docs exigidas', () => {
    expect(
      calcularSelos(['CHANGELOG.md', 'specs/forja/03.md'], DETECTORES).selos.docs_exigidas_ok,
    ).toBe(true);
    expect(calcularSelos(['CHANGELOG.md'], DETECTORES).selos.docs_exigidas_ok).toBe(false);
    expect(
      calcularSelos(['x'], { ...DETECTORES, docs_exigidas: [] }).selos.docs_exigidas_ok,
    ).toBeNull();
  });
});

describe('diffDependencias', () => {
  it('lista só pacotes adicionados', () => {
    const antes = JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '1' } });
    const depois = JSON.stringify({
      dependencies: { a: '2', c: '1' },
      devDependencies: { b: '1' },
      peerDependencies: { d: '*' },
    });
    expect(diffDependencias(antes, depois)).toEqual(['c', 'd']);
    expect(diffDependencias(null, depois)).toEqual(['a', 'b', 'c', 'd']);
    expect(diffDependencias(antes, '{quebrado')).toEqual([]);
  });
});

describe('selosDoDiff (git real)', () => {
  let r: RepoTemporario;
  beforeEach(() => {
    r = criarRepoTemporario();
    r.escrever('package.json', JSON.stringify({ dependencies: { zod: '4' } }));
    r.commitar('pkg');
  });
  afterEach(() => r.limpar());

  it('usa o diff base...sha da branch, ignorando o que o destino fez depois', async () => {
    const base = r.g(['rev-parse', 'HEAD']);
    r.g(['checkout', '-q', '-b', 'forja/chamado-1-x']);
    r.escrever('db/migrations/001.sql', 'create table x();');
    r.escrever('package.json', JSON.stringify({ dependencies: { zod: '4', 'left-pad': '1' } }));
    r.escrever('apps/web/src/components/a.tsx', 'export {}');
    const sha = r.commitar('impl');
    r.g(['checkout', '-q', 'main']);
    r.escrever('.github/workflows/ci.yml', 'x');
    r.commitar('destino andou');

    const s = await selosDoDiff({ dir: r.repo, base: 'main', sha, detectores: DETECTORES });
    expect(s.arquivos.sort()).toEqual([
      'apps/web/src/components/a.tsx',
      'db/migrations/001.sql',
      'package.json',
    ]);
    expect(s.selos.altera_banco).toBe(true);
    expect(s.selos.altera_ui).toBe(true);
    expect(s.selos.sensivel).toEqual(['package.json']);
    expect(s.dependencias_novas).toEqual(['left-pad']);
    const comBase = await selosDoDiff({ dir: r.repo, base, sha, detectores: DETECTORES });
    expect(comBase.arquivos.sort()).toEqual(s.arquivos.sort());
  });
});
