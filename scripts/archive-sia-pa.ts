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
 *   pnpm archive-sia-pa -- --ufs SP --years 2021 --months 03,04,05  # cleanup precise
 *
 * Observações:
 *   - Lê via `@precisa-saude/datasus` que gerencia cache FTP local
 *     (`~/.cache/datasus-brasil/`). Se o DBC não estiver em cache,
 *     baixa automaticamente.
 *   - Compressão zstd. Row-groups ordenados por `(PA_CMP, PA_CODUNI)`
 *     para pushdown por competência e estabelecimento.
 *   - Idempotente: pula partições já existentes. Deletar para re-emitir.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDbcRecords } from '@precisa-saude/datasus-dbc';
import { download, sia, type SiaProducaoAmbulatorialRecord } from '@precisa-saude/datasus-sdk';
import duckdb from 'duckdb';

const SIA_PA_DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const VARIANT_SUFFIXES = ['a', 'b', 'c', 'd', 'e'];

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /550|not found|does not exist/i.test(msg);
}

/**
 * Erros de transporte FTP (ECONNRESET, ETIMEDOUT, etc.) são rotineiros
 * em `ftp.datasus.gov.br` — o servidor reseta a data connection com
 * frequência, especialmente em arquivos grandes (UFs SP/MG/RJ). NÃO são
 * indicação de DBC corrompido: o mesmo arquivo decodifica perfeitamente
 * num retry. Verificado em 2026-05-21 nas 43 partições do issue #20:
 * zero corrupções reais, 16 ECONNRESETs transitórios.
 *
 * Sem essa distinção, o pipeline marca falsos positivos como `.failed`
 * / `.skipped` e perde partições reais. Erros de decode (DBF inválido,
 * registro truncado mid-stream, header errado) continuam falhando rápido
 * — só o transporte ganha retries generosos.
 */
function isTransportError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (
    code !== undefined &&
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENETRESET', 'EPIPE', 'EAI_AGAIN'].includes(code)
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|ECONNABORTED|ENETRESET|EPIPE|EAI_AGAIN|data socket|control socket|\b421\b/i.test(
    msg,
  );
}

/**
 * Stream de records de (UF, ano, mês) com suporte a split files.
 *
 * Alguns meses de UFs grandes (SP desde 2013, MG/RJ desde 2021) não
 * têm o arquivo canônico `PA{UF}{YY}{MM}.dbc` porque o DBF bruto
 * excedia o limite de 2 GB do formato — DATASUS publica em vez disso
 * `PA{UF}{YY}{MM}a.dbc`, `b.dbc`, etc. Os records são disjuntos entre
 * variantes e devem ser concatenados logicamente no consumo.
 *
 * Estratégia: tenta canônico primeiro; se der 550, probe sufixos
 * `a-e` e yields records de todas as variantes encontradas. Erros
 * não-550 propagam (abort seguro).
 */
async function* streamMonthWithVariants(
  uf: string,
  year: number,
  month: number,
): AsyncIterable<SiaProducaoAmbulatorialRecord> {
  try {
    for await (const record of sia.streamProducaoAmbulatorial({ month, uf, year })) {
      yield record;
    }
    return;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  const yy = String(year % 100).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  let found = 0;
  for (const suffix of VARIANT_SUFFIXES) {
    const variantPath = `${SIA_PA_DIR}/PA${uf}${yy}${mm}${suffix}.dbc`;
    let bytes: Uint8Array;
    try {
      bytes = await download({ path: variantPath });
    } catch (err) {
      if (isNotFoundError(err)) break;
      throw err;
    }
    for await (const record of readDbcRecords(bytes)) {
      yield record as SiaProducaoAmbulatorialRecord;
    }
    found += 1;
  }
  if (found === 0) {
    throw new Error(`550 nenhum DBC encontrado para ${uf} ${year}-${mm} (canônico + a-e)`);
  }
}

interface Cli {
  months: number[];
  outDir: string;
  throttleMs: number;
  ufs: string[];
  yearPauseMs: number;
  years: number[];
}

const ALL_UFS = [
  'AC',
  'AL',
  'AM',
  'AP',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MG',
  'MS',
  'MT',
  'PA',
  'PB',
  'PE',
  'PI',
  'PR',
  'RJ',
  'RN',
  'RO',
  'RR',
  'RS',
  'SC',
  'SE',
  'SP',
  'TO',
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
  // --months: lista CSV de números 1-12 (ex.: "01,03,07" ou "1,2,12").
  // Default ALL = todos os 12 meses, espelhando comportamento histórico.
  // Útil pra cleanup pass: re-tentar tuplas específicas sem re-decodar
  // 12 meses inteiros por (UF, ano).
  const monthsArg = get('--months', 'ALL').toUpperCase();
  const months =
    monthsArg === 'ALL'
      ? Array.from({ length: 12 }, (_, i) => i + 1)
      : monthsArg.split(',').map((raw) => {
          const trimmed = raw.trim();
          const n = Number(trimmed);
          if (!Number.isInteger(n) || n < 1 || n > 12) {
            throw new Error(
              `--months inválido: item '${trimmed}' (em '${monthsArg}') deve ser inteiro entre 1 e 12`,
            );
          }
          return n;
        });
  months.sort((x, y) => x - y);
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outDir = resolve(repoRoot, get('--out', 'build/sia-pa'));
  const throttleMs = Number(get('--throttle-ms', '500'));
  const yearPauseMs = Number(get('--year-pause-ms', '2000'));
  return { months, outDir, throttleMs, ufs, yearPauseMs, years };
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
  const skippedMarker = resolve(partitionDir, 'part.parquet.skipped');

  if (existsSync(parquetFile) && statSync(parquetFile).size > 0) {
    return { rows: 0, skipped: true };
  }
  // Watchdog (`scripts/archive-watchdog.sh`) cria esse marker quando
  // um DBC corrompe N vezes seguidas — pula pra não loopar pra sempre.
  if (existsSync(skippedMarker)) {
    return { rows: 0, skipped: true };
  }

  mkdirSync(partitionDir, { recursive: true });
  const ndjsonFile = resolve(partitionDir, 'part.ndjson');
  const failedMarker = resolve(partitionDir, 'part.parquet.failed');

  // Retry inline com classificação transport-vs-decode (ver isTransportError).
  // Transporte (ECONNRESET, ETIMEDOUT, etc.) ganha retries generosos com
  // backoff exponencial — o FTP DATASUS reseta data sockets rotineiramente
  // em arquivos grandes e o mesmo arquivo decodifica fine no próximo tente.
  // Decode (DBF inválido, registro truncado, header errado) falha rápido:
  // não adianta re-baixar o mesmo arquivo se o conteúdo está mesmo quebrado.
  // `.failed` marker registra a falha pra inspeção sem bloquear re-runs
  // (idempotência só pula `part.parquet` ou `.skipped`).
  const MAX_TRANSPORT_RETRIES = 10;
  const MAX_DECODE_RETRIES = 3;
  let lastError: unknown;
  let rows = 0;
  let transportAttempts = 0;
  let decodeAttempts = 0;
  while (transportAttempts < MAX_TRANSPORT_RETRIES && decodeAttempts < MAX_DECODE_RETRIES) {
    rows = 0;
    const fd = openSync(ndjsonFile, 'w');
    try {
      for await (const record of streamMonthWithVariants(uf, year, month)) {
        writeSync(fd, `${JSON.stringify(record)}\n`);
        rows += 1;
      }
      closeSync(fd);
      lastError = undefined;
      break;
    } catch (err) {
      closeSync(fd);
      rmSync(ndjsonFile, { force: true });
      lastError = err;
      const transport = isTransportError(err);
      if (transport) {
        transportAttempts += 1;
        if (transportAttempts >= MAX_TRANSPORT_RETRIES) break;
        // Exponencial com teto: 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
        const backoffMs = Math.min(2000 * 2 ** (transportAttempts - 1), 60_000);
        process.stderr.write(
          `  ⚠ ${uf} ${year}-${month} transporte ${transportAttempts}/${MAX_TRANSPORT_RETRIES}: ` +
            `${(err as Error).message} — retry em ${backoffMs}ms\n`,
        );
        await sleep(backoffMs);
      } else {
        decodeAttempts += 1;
        if (decodeAttempts >= MAX_DECODE_RETRIES) break;
        const backoffMs = 2000 * decodeAttempts;
        process.stderr.write(
          `  ⚠ ${uf} ${year}-${month} decode ${decodeAttempts}/${MAX_DECODE_RETRIES}: ` +
            `${(err as Error).message} — retry em ${backoffMs}ms\n`,
        );
        await sleep(backoffMs);
      }
    }
  }

  if (lastError !== undefined) {
    const msg = (lastError as Error).message;
    const kind = isTransportError(lastError) ? 'transporte' : 'decode';
    const totalAttempts = transportAttempts + decodeAttempts;
    writeFileSync(
      failedMarker,
      `${new Date().toISOString()} ${uf} ${year}-${month}\n${kind}\n${msg}\n`,
    );
    process.stderr.write(
      `  ✗ FALHA ${uf} ${year}-${month} após ${totalAttempts} tentativas (${kind}): ${msg} ` +
        `(marker: ${failedMarker})\n`,
    );
    return { rows: 0 };
  }

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
      for (const month of cli.months) {
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
