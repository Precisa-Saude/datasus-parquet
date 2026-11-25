import { describe, expect, it } from 'vitest';

import { SizeMismatchError } from '../lib/dbc-source.js';
import {
  fetchWithRetry,
  isTransportError,
  OTHER_ATTEMPTS,
  TRANSPORT_ATTEMPTS,
  transportBackoffMs,
} from '../lib/transport-retry.js';

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('isTransportError', () => {
  it.each([
    ['código ECONNREFUSED', errno('ECONNREFUSED')],
    ['código ECONNRESET', errno('ECONNRESET')],
    ['código EAI_AGAIN', errno('EAI_AGAIN')],
    [
      'ECONNREFUSED do basic-ftp',
      new Error('connect ECONNREFUSED 189.28.143.164:21 (control socket)'),
    ],
    ['timeout do data socket', new Error('Timeout (data socket)')],
    ['timeout do control socket', new Error('Timeout (control socket)')],
    ['resposta 421 do FTP', new Error('421 Too many connections')],
    ['tamanho divergente', new SizeMismatchError('PASP1602b.dbc', 10, 5)],
    ['string', 'ETIMEDOUT'],
  ])('%s é transporte', (_, err) => {
    expect(isTransportError(err)).toBe(true);
  });

  it.each([
    ['DBF inválido', new Error('DBF header inválido')],
    ['arquivo ausente (550)', new Error('550 No such file or directory')],
    ['undefined', undefined],
  ])('%s não é transporte', (_, err) => {
    expect(isTransportError(err)).toBe(false);
  });
});

describe('transportBackoffMs', () => {
  it('dobra a partir de 2 s com teto de 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(transportBackoffMs)).toEqual([
      2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });
});

describe('fetchWithRetry', () => {
  function harness(failures: unknown[]) {
    const waits: number[] = [];
    const retries: Array<{ attempt: number; max: number }> = [];
    let calls = 0;
    const fn = (): Promise<string> => {
      const err = failures[calls];
      calls += 1;
      return err === undefined ? Promise.resolve('ok') : Promise.reject(err);
    };
    const opts = {
      onRetry: (_err: unknown, attempt: number, max: number) => retries.push({ attempt, max }),
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
    return { calls: () => calls, fn, opts, retries, waits };
  }

  it('sem erro: uma chamada, sem espera', async () => {
    const h = harness([]);
    await expect(fetchWithRetry(h.fn, h.opts)).resolves.toBe('ok');
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it('FTP recusando conexão por alguns minutos: espera com backoff e conclui', async () => {
    const refused = new Error('connect ECONNREFUSED 189.28.143.164:21 (control socket)');
    const h = harness(Array(TRANSPORT_ATTEMPTS - 1).fill(refused));
    await expect(fetchWithRetry(h.fn, h.opts)).resolves.toBe('ok');
    expect(h.calls()).toBe(TRANSPORT_ATTEMPTS);
    expect(h.waits).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
    expect(h.retries.at(-1)).toEqual({ attempt: TRANSPORT_ATTEMPTS - 1, max: TRANSPORT_ATTEMPTS });
  });

  it('transporte esgotado: lança o último erro', async () => {
    const errs = Array.from({ length: TRANSPORT_ATTEMPTS }, (_, i) => errno('ECONNRESET', `#${i}`));
    const h = harness(errs);
    await expect(fetchWithRetry(h.fn, h.opts)).rejects.toThrow(`#${TRANSPORT_ATTEMPTS - 1}`);
    expect(h.calls()).toBe(TRANSPORT_ATTEMPTS);
    expect(h.waits).toHaveLength(TRANSPORT_ATTEMPTS - 1);
  });

  it('erro que não é de transporte: mantém as 3 tentativas com espera linear', async () => {
    const errs = Array.from({ length: OTHER_ATTEMPTS }, () => new Error('550 No such file'));
    const h = harness(errs);
    await expect(fetchWithRetry(h.fn, h.opts)).rejects.toThrow('550');
    expect(h.calls()).toBe(OTHER_ATTEMPTS);
    expect(h.waits).toEqual([5000, 10_000]);
    expect(h.retries.map((r) => r.max)).toEqual([OTHER_ATTEMPTS, OTHER_ATTEMPTS]);
  });

  it('contadores separados: erros de transporte não gastam as tentativas dos outros', async () => {
    const reset = errno('ECONNRESET');
    const other = new Error('falha qualquer');
    const h = harness([other, reset, reset, other]);
    await expect(fetchWithRetry(h.fn, h.opts)).resolves.toBe('ok');
    expect(h.calls()).toBe(5);
    expect(h.waits).toEqual([5000, 2000, 4000, 10_000]);
  });
});
