#!/usr/bin/env tsx
/**
 * Converte arquivos SIA-PA (Produção Ambulatorial) de DBC → Parquet
 * raw sem transformação: todas as colunas `PA_*` do DBF preservadas,
 * zero filtro, zero enriquecimento, zero agregação.
 *
 * Saída:
 *
 *     build/sia-pa/ano=YYYY/uf=XX/mes=MM/part.parquet
 *
 * Partição por mês preserva o schema exato do DBF daquela competência
 * — útil porque SIA-PA teve evoluções graduais de schema entre
 * vintages. Consumers unem across schemas via
 * `read_parquet(..., union_by_name=true)` no DuckDB.
 *
 * Uso:
 *   pnpm archive-sia-pa -- --ufs AC --years 2024
 *   pnpm archive-sia-pa -- --ufs ALL --years 2008-2025
 *
 * Observações:
 *   - Lê via `@precisa-saude/datasus` que gerencia cache FTP local
 *     (`~/.cache/datasus-brasil/`). Se o DBC não estiver em cache,
 *     baixa automaticamente.
 *   - Compressão zstd. Row-groups ordenados por `(PA_CMP, PA_CODUNI)`
 *     para pushdown por competência e estabelecimento.
 *   - Idempotente: pula partições já existentes. Deletar para re-emitir.
 */

import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sia, type SiaProducaoAmbulatorialRecord } from '@precisa-saude/datasus';
import duckdb from 'duckdb';

interface Cli {
  outDir: string;
  throttleMs: number;
  ufs: string[];
  yearPauseMs: number;
  years: number[];
}

const ALL_UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO',
  'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR',
  'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];

function parseArgs(argv: string[]): Cli {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return fallback;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Valor ausente para ${flag}`);
    }
    return value;
  };
  const rawUfs = get('--ufs', 'AC').toUpperCase();
  const ufs = (rawUfs === 'ALL' ? ALL_UFS : rawUfs.split(',').map((s) => s.trim())).sort();
  const yearsArg = get('--years', '2024');
  const years: number[] = [];
  for (const chunk of yearsArg.split(',')) {
    const [a, b] = chunk.split('-').map((s) => Number(s.trim()));
    if (a === undefined || !Number.isInteger(a)) throw new Error(`--years inválido: '${yearsArg}'`);
    const end = Number.isInteger(b) ? (b as number) : a;
    for (let y = a; y <= end; y += 1) years.push(y);
  }
  years.sort((x, y) => (x ?? 0) - (y ?? 0));
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outDir = resolve(repoRoot, get('--out', 'build/sia-pa'));
  const throttleMs = Number(get('--throttle-ms', '500'));
  const yearPauseMs = Number(get('--year-pause-ms', '2000'));
  return { outDir, throttleMs, ufs, yearPauseMs, years };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function writeMonthPartition(
  cli: Cli,
  uf: string,
  year: number,
  month: number,
): Promise<{ rows: number; skipped?: boolean }> {
  const partitionDir = resolve(
    cli.outDir,
    `ano=${year}/uf=${uf}/mes=${String(month).padStart(2, '0')}`,
  );
  const parquetFile = resolve(partitionDir, 'part.parquet');

  if (existsSync(parquetFile) && statSync(parquetFile).size > 0) {
    return { rows: 0, skipped: true };
  }

  mkdirSync(partitionDir, { recursive: true });
  const ndjsonFile = resolve(partitionDir, 'part.ndjson');

  let rows = 0;
  const fd = openSync(ndjsonFile, 'w');
  try {
    for await (const raw of sia.streamProducaoAmbulatorial({ month, uf, year })) {
      const record = raw as SiaProducaoAmbulatorialRecord;
      writeSync(fd, `${JSON.stringify(record)}\n`);
      rows += 1;
    }
  } catch (err) {
    closeSync(fd);
    rmSync(ndjsonFile, { force: true });
    process.stderr.write(`FALHA ${uf} ${year}-${month}: ${(err as Error).message}\n`);
    return { rows: 0 };
  }
  closeSync(fd);

  if (rows === 0) {
    rmSync(ndjsonFile);
    return { rows: 0 };
  }

  await new Promise<void>((res, rej) => {
    const db = new duckdb.Database(':memory:');
    db.all(
      `COPY (
         SELECT * FROM read_json_auto('${ndjsonFile.replace(/'/g, "''")}',
           format='newline_delimited', maximum_object_size=67108864)
         ORDER BY TRY_CAST(PA_CMP AS VARCHAR), TRY_CAST(PA_CODUNI AS VARCHAR)
       ) TO '${parquetFile.replace(/'/g, "''")}'
       (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`,
      (err) => {
        db.close(() => (err ? rej(err) : res()));
      },
    );
  });

  rmSync(ndjsonFile);
  const sz = statSync(parquetFile).size;
  process.stderr.write(
    `  ✓ ano=${year}/uf=${uf}/mes=${String(month).padStart(2, '0')}/part.parquet ` +
      `(${rows.toLocaleString('pt-BR')} linhas, ${bytesHuman(sz)})\n`,
  );
  return { rows };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  mkdirSync(cli.outDir, { recursive: true });
  process.stderr.write(
    `Archive SIA-PA → Parquet | UFs=${cli.ufs.join(',')} | anos=${cli.years.join(',')} | out=${cli.outDir}\n`,
  );

  let totalRows = 0;
  let skipped = 0;
  for (let yIdx = 0; yIdx < cli.years.length; yIdx += 1) {
    const year = cli.years[yIdx]!;
    for (const uf of cli.ufs) {
      process.stderr.write(`[${year}] ${uf}\n`);
      for (let month = 1; month <= 12; month += 1) {
        const r = await writeMonthPartition(cli, uf, year, month);
        totalRows += r.rows;
        if (r.skipped) skipped += 1;
        if (cli.throttleMs > 0) await sleep(cli.throttleMs);
      }
    }
    if (cli.yearPauseMs > 0 && yIdx < cli.years.length - 1) {
      await sleep(cli.yearPauseMs);
    }
  }

  const batchManifest = resolve(cli.outDir, '_archive-run.json');
  writeFileSync(
    batchManifest,
    `${JSON.stringify(
      {
        finishedAt: new Date().toISOString(),
        params: { ufs: cli.ufs, years: cli.years },
        stats: { rowsEmitted: totalRows, skippedExisting: skipped },
      },
      null,
      2,
    )}\n`,
  );

  process.stderr.write(
    `✓ ${totalRows.toLocaleString('pt-BR')} linhas emitidas em ${cli.outDir} ` +
      `(${skipped} partições puladas)\n`,
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
