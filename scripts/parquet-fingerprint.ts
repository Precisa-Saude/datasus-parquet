/**
 * Calcula a impressão digital do conteúdo de um Parquet via DuckDB.
 *
 * Fica fora de `lib/` porque faz IO; o SQL e o formato estão em
 * `lib/content-fingerprint.ts`, que é testado.
 */
import type duckdb from 'duckdb';

import {
  type FingerprintRow,
  fingerprintSql,
  formatFingerprint,
} from './lib/content-fingerprint.js';

export function fingerprintParquet(db: duckdb.Database, file: string): Promise<string> {
  return new Promise((res, rej) => {
    db.all(fingerprintSql(file), (err, rows) => {
      if (err) return rej(err);
      const row = rows[0] as FingerprintRow | undefined;
      if (!row) return rej(new Error(`impressão vazia para ${file}`));
      try {
        res(formatFingerprint(row));
      } catch (e: unknown) {
        rej(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
