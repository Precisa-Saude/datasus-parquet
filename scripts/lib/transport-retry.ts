/**
 * Classificação de erro de transporte FTP e retry de download com backoff,
 * compartilhados pelo `archive-sia-pa` e pelo `provenance-catchup`.
 */

import { SizeMismatchError } from './dbc-source.js';

/** Tentativas para erro de transporte: 2 s, 4 s, … até 60 s entre elas (~5 min no total). */
export const TRANSPORT_ATTEMPTS = 10;
/** Tentativas para qualquer outro erro, com espera linear de 5 s × tentativa. */
export const OTHER_ATTEMPTS = 3;

const TRANSPORT_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENETRESET',
  'EPIPE',
  'EAI_AGAIN',
];

/**
 * Erros de transporte FTP (ECONNRESET, ETIMEDOUT, etc.) são rotineiros
 * em `ftp.datasus.gov.br` — o servidor reseta a data connection com
 * frequência, especialmente em arquivos grandes (UFs SP/MG/RJ), e às vezes
 * recusa conexões por alguns minutos (ECONNREFUSED na porta 21). NÃO são
 * indicação de DBC corrompido: o mesmo arquivo decodifica perfeitamente
 * num retry. Verificado em 2026-05-21 nas 43 partições do issue #20:
 * zero corrupções reais, 16 ECONNRESETs transitórios.
 *
 * Sem essa distinção, o pipeline marca falsos positivos como `.failed`
 * / `.skipped` e perde partições reais. Erros de decode (DBF inválido,
 * registro truncado mid-stream, header errado) continuam falhando rápido
 * — só o transporte ganha retries generosos.
 */
export function isTransportError(err: unknown): boolean {
  // Tamanho divergente da listagem = download truncado ou cópia antiga no
  // cache; um download novo resolve, então entra no retry de transporte.
  if (err instanceof SizeMismatchError) return true;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && TRANSPORT_CODES.includes(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ECONNABORTED|ENETRESET|EPIPE|EAI_AGAIN|data socket|control socket|\b421\b/i.test(
    msg,
  );
}

/** Espera antes da tentativa seguinte a `attempt` (1-based): exponencial com teto. */
export function transportBackoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** (attempt - 1), 60_000);
}

export interface RetryOptions {
  sleep: (ms: number) => Promise<void>;
  /** Chamado antes de cada espera; `max` é o teto da classe do erro. */
  onRetry: (err: unknown, attempt: number, max: number, waitMs: number) => void;
}

/**
 * Roda `fn` até dar certo. Transporte e demais erros têm contadores
 * separados; quando o da classe do erro esgota, lança o último erro.
 */
export async function fetchWithRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let transport = 0;
  let other = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const isTransport = isTransportError(err);
      const attempt = isTransport ? (transport += 1) : (other += 1);
      const max = isTransport ? TRANSPORT_ATTEMPTS : OTHER_ATTEMPTS;
      if (attempt >= max) throw err;
      const waitMs = isTransport ? transportBackoffMs(attempt) : 5000 * attempt;
      opts.onRetry(err, attempt, max, waitMs);
      await opts.sleep(waitMs);
    }
  }
}
