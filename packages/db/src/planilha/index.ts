/**
 * Subpath SERVER-ONLY `@chamados/db/planilha` (D-045): gerador `.xlsx` sem
 * dependências (D-034), compartilhado pelo worker e pelo web. Usa `node:zlib` —
 * por isso NÃO vive em `@chamados/shared` (empacotado também para o browser).
 */
export {
  gerarXlsx,
  formatarDataPlanilha,
  pareceFormula,
  serialExcel,
  sanitizarNomeAba,
  MIME_XLSX,
  type PlanilhaXlsx,
  type FormatoColunaXlsx,
} from './xlsx';
