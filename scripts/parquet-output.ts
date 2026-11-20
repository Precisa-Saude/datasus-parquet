/**
 * Campo `output` do provenance a partir de um `part.parquet`: SHA-256 do
 * arquivo, linhas e schema (DuckDB) e impressão do conteúdo
 * (`parquet-fingerprint.ts`). Compartilhado pelo `emit-provenance` e pela
 * proveniência retroativa, para que os dois descrevam o Parquet do mesmo
 * jeito.
 *
 * Fica fora de `lib/` porque faz IO.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import duckdb from 'duckdb';

import { type ProvenanceInput } from './lib/provenance.js';
import { fingerprintParquet } from './parquet-fingerprint.js';

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export async function parquetSchema(
  path: string,
): Promise<{ rows: number; schema: Array<{ name: string; type: string }> }> {
  const db = new duckdb.Database(':memory:');
  const escaped = path.replace(/'/g, "''");
  const [schemaRows, countRows] = await Promise.all([
    new Promise<Array<{ column_name: string; column_type: string }>>((res, rej) => {
      db.all(`DESCRIBE SELECT * FROM read_parquet('${escaped}')`, (err, rows) =>
        err ? rej(err) : res(rows as Array<{ column_name: string; column_type: string }>),
      );
    }),
    new Promise<Array<{ n: bigint | number }>>((res, rej) => {
      db.all(`SELECT COUNT(*) AS n FROM read_parquet('${escaped}')`, (err, rows) =>
        err ? rej(err) : res(rows as Array<{ n: bigint | number }>),
      );
    }),
  ]);
  await new Promise<void>((r) => db.close(() => r()));
  return {
    rows: Number(countRows[0]?.n ?? 0),
    schema: schemaRows.map((r) => ({ name: r.column_name, type: r.column_type })),
  };
}

/**
 * `output` do provenance para o Parquet em `path`. `file` é o caminho
 * relativo publicado (`ano=AAAA/uf=XX/mes=MM/part.parquet`).
 */
export async function parquetOutput(
  fingerprintDb: duckdb.Database,
  path: string,
  file: string,
): Promise<ProvenanceInput['output']> {
  const { rows, schema } = await parquetSchema(path);
  return {
    file,
    fingerprint: await fingerprintParquet(fingerprintDb, path),
    rows,
    schema,
    sha256: sha256OfFile(path),
  };
}
