/**
 * `comum/` — contrato entre o servidor (`server/`) e a SPA (`web/`), specs/forja/01
 * §4.1. Sem dependência de Node nem de DOM: o servidor nunca importa de `web/`,
 * e `web/` nunca importa de `server/`; os dois importam daqui.
 */
export * from './estados';
export * from './protocolo-eventos';
export * from './contratos';
export * from './dto';
export * from './config-projeto';
