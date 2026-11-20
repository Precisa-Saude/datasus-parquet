/**
 * Listagem de um diretório do FTP DATASUS (tamanho e mtime de cada
 * arquivo), compartilhada pelo `detect-new` e pela proveniência retroativa.
 *
 * Fica fora de `lib/` porque faz rede; o agrupamento por partição está em
 * `lib/ftp-groups.ts`, que é testado.
 */
import { Client } from 'basic-ftp';

import { type ListedFile } from './lib/ftp-groups.js';
import { parseDosMtime, UNKNOWN_MTIME } from './lib/ftp-mtime.js';

export const FTP_HOST = 'ftp.datasus.gov.br';

export async function listFtpDir(dir: string): Promise<ListedFile[]> {
  const client = new Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: FTP_HOST, port: 21, secure: false });
    const entries = await client.list(dir);
    // O servidor não anuncia MLSD: `modifiedAt` vem vazio e o mtime está só
    // em `rawModifiedAt`, no formato DOS (`lib/ftp-mtime.ts`).
    return entries
      .filter((e) => e.type === 1)
      .map((e) => ({
        mtime: e.modifiedAt ?? parseDosMtime(e.rawModifiedAt) ?? UNKNOWN_MTIME,
        name: e.name,
        size: e.size,
      }));
  } finally {
    client.close();
  }
}
