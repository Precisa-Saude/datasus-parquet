#!/usr/bin/env tsx
/**
 * Confere cada partição arquivada contra o FTP antes do upload (issue #46).
 *
 * Para cada entrada do `pending.json`, compara as linhas do `part.parquet`
 * local com a soma do `recordCount` dos cabeçalhos das variantes lidos
 * direto do FTP — nunca do cache. Partição divergente, sem parquet ou com
 * cabeçalho ilegível é movida para `--rejected-dir`, para que o upload e o
 * provenance não a vejam, e fica fora do `_verified.json` (logo, fora do
 * state).
 *
 * Saídas: `<build>/_verified.json`, `verifiedCount`/`rejectedCount` em
 * $GITHUB_OUTPUT e uma tabela das rejeitadas em $GITHUB_STEP_SUMMARY.
 *
 * Uso:
 *   pnpm verify-partitions -- --from-pending state/pending.json \
 *     [--build-dir build] [--rejected-dir build-rejected]
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import duckdb from 'duckdb';

import { ftpRecordCount, mapLimit } from './ftp-header.js';
import { partitionArtifactPaths } from './lib/refresh-targets.js';
import {
  classify,
  rejectedMarkdown,
  type VerificationRow,
  type VerifiedFile,
} from './lib/verification.js';

interface PendingVariant {
  ftpPath: string;
}

interface PendingEntry {
  dataset: string;
  month: number;
  uf: string;
  variants: PendingVariant[];
  year: number;
}

function get(argv: string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Valor ausente para ${flag}`);
  return value;
}

function parquetRowCount(db: duckdb.Database, file: string): Promise<number> {
  return new Promise((res, rej) => {
    db.all(
      `SELECT CAST(COALESCE(SUM(row_group_num_rows), 0) AS BIGINT)::VARCHAR AS n FROM (
         SELECT DISTINCT row_group_id, row_group_num_rows
         FROM parquet_metadata('${file.replace(/'/g, "''")}'))`,
      (err, rows) => {
        if (err) return rej(err);
        res(Number((rows[0] as { n: string } | undefined)?.n ?? 0));
      },
    );
  });
}

function writeGh(file: string | undefined, text: string): void {
  if (file) appendFileSync(file, text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const pendingPath = resolve(repoRoot, get(argv, '--from-pending', 'state/pending.json'));
  const buildDir = resolve(repoRoot, get(argv, '--build-dir', 'build'));
  const rejectedDir = resolve(repoRoot, get(argv, '--rejected-dir', 'build-rejected'));
  if (!existsSync(pendingPath)) throw new Error(`pending não encontrado: ${pendingPath}`);

  const entries = (
    JSON.parse(readFileSync(pendingPath, 'utf8')) as { pending: PendingEntry[] }
  ).pending.filter((e) => e.dataset === 'sia-pa');

  const db = new duckdb.Database(':memory:');
  const rows: VerificationRow[] = await mapLimit(entries, 6, async (e) => {
    const target = { month: e.month, uf: e.uf, year: e.year };
    const { parquet } = partitionArtifactPaths(buildDir, 'sia-pa', target);
    const localRows = existsSync(parquet) ? await parquetRowCount(db, parquet) : null;
    let ftpRows: null | number = null;
    if (localRows !== null) {
      const counts = await Promise.all(e.variants.map((v) => ftpRecordCount(v.ftpPath)));
      ftpRows = counts.some((c) => c === null)
        ? null
        : counts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
    }
    return { ...target, ftpRows, rows: localRows, status: classify(localRows, ftpRows) };
  });
  await new Promise<void>((res) => db.close(() => res()));

  const verified = rows.filter((r) => r.status === 'ok');
  const rejected = rows.filter((r) => r.status !== 'ok');

  // Tira as rejeitadas do build/ para o upload não publicá-las.
  for (const r of rejected) {
    const dir = dirname(partitionArtifactPaths(buildDir, 'sia-pa', r).parquet);
    if (!existsSync(dir)) continue;
    const dest = resolve(rejectedDir, relative(buildDir, dir));
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true, recursive: true });
    renameSync(dir, dest);
  }

  const out: VerifiedFile = { generatedAt: new Date().toISOString(), rejected, verified };
  const outPath = resolve(buildDir, '_verified.json');
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

  writeGh(
    process.env['GITHUB_OUTPUT'],
    `verifiedCount=${verified.length}\nrejectedCount=${rejected.length}\n`,
  );
  writeGh(
    process.env['GITHUB_STEP_SUMMARY'],
    `## Verificação contra o FTP\n\n- ${verified.length} partições conferidas\n- ${rejected.length} rejeitadas\n\n${rejectedMarkdown(rejected)}\n`,
  );
  process.stderr.write(
    `✓ ${verified.length} verificadas, ${rejected.length} rejeitadas (movidas para ${rejectedDir}) → ${outPath}\n`,
  );
  for (const r of rejected.slice(0, 20)) {
    process.stderr.write(
      `  ✗ ${r.uf} ${r.year}-${String(r.month).padStart(2, '0')}: ${r.status} (parquet=${r.rows ?? '—'}, ftp=${r.ftpRows ?? '—'})\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
