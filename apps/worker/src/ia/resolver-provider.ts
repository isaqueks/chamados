import type { AIProvider } from '@chamados/shared';
import { FakeProvider } from './providers/fake-provider';
import { ClaudeAgentProvider } from './providers/claude-agent-provider';

/**
 * Resolve o `AIProvider` concreto por configuração (specs/01 §4.2, RF-17). A
 * abstração fica instalada desde o MVP com UMA impl. real (Claude Agent SDK) +
 * o fake determinístico de apoio; um 2º engine (fase 3) é só mais um `case`.
 */
export interface ConfigProvider {
  provider: 'fake' | 'claude';
  modelo: string;
  apiKey?: string;
  /** Token de assinatura (D-012): `CLAUDE_CODE_OAUTH_TOKEN`. Alternativa à API key. */
  oauthToken?: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function resolverProvider(cfg: ConfigProvider): AIProvider {
  switch (cfg.provider) {
    case 'claude':
      return new ClaudeAgentProvider({
        modelo: cfg.modelo,
        apiKey: cfg.apiKey,
        oauthToken: cfg.oauthToken,
        log: cfg.log,
      });
    case 'fake':
      return new FakeProvider();
    default:
      throw new Error(`engine de IA não suportado: ${String(cfg.provider)}`);
  }
}
