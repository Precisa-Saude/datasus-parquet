/**
 * Leitura do cabeçalho (12 bytes) de um DBC direto do FTP, via `curl -r`.
 *
 * Fonte independente do cache local para conferir contagens (issue #46).
 * Fica fora de `lib/` porque faz rede; a interpretação do cabeçalho está
 * em `lib/verification.ts` (`parseRecordCount`), que é testada.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseRecordCount } from './lib/verification.js';

const execFileAsync = promisify(execFile);

export const FTP_HOST = 'ftp.datasus.gov.br';

/** `recordCount` do DBC em `ftpPath`, ou `null` se não der para ler após as tentativas. */
export async function ftpRecordCount(ftpPath: string, attempts = 4): Promise<null | number> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const { stdout } = await execFileAsync(
        'curl',
        [
          '-s',
          '--connect-timeout',
          '20',
          '--max-time',
          '60',
          '-r',
          '0-11',
          `ftp://${FTP_HOST}${ftpPath}`,
        ],
        { encoding: 'buffer', maxBuffer: 1024 },
      );
      const count = parseRecordCount(new Uint8Array(stdout));
      if (count !== null) return count;
    } catch {
      // curl sai com código ≠ 0 em timeout/reset; tenta de novo.
    }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  return null;
}

/** Executa `fn` sobre `items` com no máximo `limit` em paralelo, preservando a ordem. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
