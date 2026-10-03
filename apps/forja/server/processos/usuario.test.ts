import { describe, expect, it } from 'vitest';
import { MENSAGEM_ROOT, recusaPorRoot } from './usuario';

describe('recusa de iniciar como root (05 §5.3)', () => {
  it('uid 0 recusa; outro uid ou plataforma sem getuid inicia', () => {
    expect(recusaPorRoot(0)).toBe(MENSAGEM_ROOT);
    expect(recusaPorRoot(1000)).toBeNull();
    expect(recusaPorRoot(undefined)).toBeNull();
  });
});
