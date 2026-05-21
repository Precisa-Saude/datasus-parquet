#!/usr/bin/env tsx
/**
 * Reprodução mínima do issue #20 — DBCs corrompidos no FTP DATASUS
 * (43 partições SIA-PA não decodificáveis).
 *
 * Baixa um sample representativo das 43 partições afetadas direto do
 * FTP `ftp.datasus.gov.br/dissemin/publicos/SIASUS/200801_/Dados/` e
 * tenta decodar via `@precisa-saude/datasus-dbc`. Para cada DBC:
 *   - lista o tamanho em bytes do payload baixado (prova que o FTP
 *     entrega bytes, ou seja, não é 550)
 *   - tenta `readDbcRecords` e loga o primeiro erro, com stack
 *
 * Saída: log em stdout (com timestamps) — copy/paste pra ticket
 * DATASUS. Sem retries, sem cache, sem watchdog: apenas evidência
 * crua de corrupção persistente.
 *
 * Uso:
 *   pnpm tsx scripts/repro-issue-20.ts
 *   pnpm tsx scripts/repro-issue-20.ts 2>&1 | tee /tmp/datasus-issue-20.log
 */

import { readDbcRecords } from '@precisa-saude/datasus-dbc';
import { download } from '@precisa-saude/datasus-sdk';

const SIA_PA_DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const VARIANT_SUFFIXES = ['', 'a', 'b', 'c', 'd', 'e'];

interface Sample {
  month: number;
  note: string;
  uf: string;
  year: number;
}

// 43 partições listadas no issue #20. Resultado da verificação (2026-05-21):
// 0 decode failures, 16 ECONNRESETs transitórios em data socket — não é
// corrupção server-side. Issue fechado, classificador transport-vs-decode
// adicionado ao archive-sia-pa.
const SAMPLES: Sample[] = [
  { month: 3, note: '', uf: 'SP', year: 2015 },
  { month: 7, note: '', uf: 'RJ', year: 2021 },
  { month: 3, note: '', uf: 'SP', year: 2021 },
  { month: 4, note: '', uf: 'SP', year: 2021 },
  { month: 5, note: '', uf: 'SP', year: 2021 },
  { month: 6, note: '', uf: 'SP', year: 2021 },
  { month: 7, note: '', uf: 'SP', year: 2021 },
  { month: 11, note: '', uf: 'SP', year: 2021 },
  { month: 10, note: '', uf: 'RJ', year: 2022 },
  { month: 10, note: '', uf: 'SP', year: 2022 },
  { month: 11, note: '', uf: 'SP', year: 2022 },
  { month: 12, note: '', uf: 'SP', year: 2022 },
  { month: 1, note: '', uf: 'MG', year: 2023 },
  { month: 5, note: '', uf: 'MG', year: 2023 },
  { month: 9, note: '', uf: 'MG', year: 2023 },
  { month: 5, note: '', uf: 'RJ', year: 2023 },
  { month: 11, note: '', uf: 'RJ', year: 2023 },
  { month: 4, note: '', uf: 'SP', year: 2023 },
  { month: 5, note: '', uf: 'SP', year: 2023 },
  { month: 6, note: '', uf: 'SP', year: 2023 },
  { month: 7, note: '', uf: 'SP', year: 2023 },
  { month: 9, note: '', uf: 'SP', year: 2023 },
  { month: 10, note: '', uf: 'SP', year: 2023 },
  { month: 11, note: '', uf: 'SP', year: 2023 },
  { month: 12, note: '', uf: 'SP', year: 2023 },
  { month: 1, note: '', uf: 'MG', year: 2024 },
  { month: 2, note: '', uf: 'MG', year: 2024 },
  { month: 3, note: '', uf: 'MG', year: 2024 },
  { month: 4, note: '', uf: 'MG', year: 2024 },
  { month: 5, note: '', uf: 'MG', year: 2024 },
  { month: 6, note: '', uf: 'MG', year: 2024 },
  { month: 7, note: '', uf: 'MG', year: 2024 },
  { month: 8, note: '', uf: 'MG', year: 2024 },
  { month: 9, note: '', uf: 'MG', year: 2024 },
  { month: 10, note: '', uf: 'MG', year: 2024 },
  { month: 11, note: '', uf: 'MG', year: 2024 },
  { month: 12, note: '', uf: 'MG', year: 2024 },
  { month: 7, note: '', uf: 'PR', year: 2024 },
  { month: 9, note: '', uf: 'RJ', year: 2024 },
  { month: 10, note: '', uf: 'RJ', year: 2024 },
  { month: 8, note: '', uf: 'SP', year: 2024 },
  { month: 1, note: '', uf: 'MG', year: 2025 },
  { month: 5, note: '', uf: 'RJ', year: 2025 },
];

function ts(): string {
  return new Date().toISOString();
}

function log(...args: unknown[]): void {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stdout.write(`[${ts()}] ${line}\n`);
}

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /550|not found|does not exist/i.test(msg);
}

async function tryDecode(path: string): Promise<{
  bytes: number;
  decoded: number;
  error?: string;
  errorStack?: string;
}> {
  log(`  fetch ftp://ftp.datasus.gov.br${path}`);
  const bytes = await download({ path });
  log(`  fetched ${bytes.byteLength} bytes (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);
  let decoded = 0;
  try {
    for await (const _record of readDbcRecords(bytes)) {
      decoded += 1;
      if (decoded % 50_000 === 0) log(`    ... decoded ${decoded} records so far`);
    }
    return { bytes: bytes.byteLength, decoded };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    return { bytes: bytes.byteLength, decoded, error, errorStack };
  }
}

async function reproSample(s: Sample): Promise<void> {
  const yy = String(s.year % 100).padStart(2, '0');
  const mm = String(s.month).padStart(2, '0');
  log('');
  log('='.repeat(72));
  log(`SAMPLE ${s.uf} ${s.year}-${mm} (${s.note})`);
  log('='.repeat(72));

  for (const suffix of VARIANT_SUFFIXES) {
    const file = `PA${s.uf}${yy}${mm}${suffix}.dbc`;
    const path = `${SIA_PA_DIR}/${file}`;
    log(`-- variant '${suffix || 'canonical'}': ${file}`);
    try {
      const result = await tryDecode(path);
      if (result.error) {
        log(`  DECODE FAILED after ${result.decoded} records`);
        log(`  error: ${result.error}`);
        if (result.errorStack) {
          for (const line of result.errorStack.split('\n').slice(0, 8)) {
            log(`    ${line}`);
          }
        }
      } else {
        log(`  decoded OK: ${result.decoded} records`);
      }
    } catch (err) {
      if (isNotFound(err)) {
        log(`  variant absent (550) — ok, end of variants`);
        if (suffix === '') {
          // canonical absent: continue probing variants a-e
          continue;
        }
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log(`  FTP ERROR: ${msg}`);
    }
  }
}

async function main(): Promise<void> {
  log(`repro-issue-20 — DATASUS SIA-PA DBC corruption check`);
  log(`node ${process.version} · platform ${process.platform}`);
  log(`samples: ${SAMPLES.length} of 43 partitions listed in issue #20`);
  for (const s of SAMPLES) {
    try {
      await reproSample(s);
    } catch (err) {
      log(`SAMPLE FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log('');
  log('done.');
}

await main();
