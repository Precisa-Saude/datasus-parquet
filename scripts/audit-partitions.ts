#!/usr/bin/env tsx
/**
 * Auditoria completa do bucket contra o FTP (issue #46).
 *
 * Compara, para cada partição SIA-PA, as linhas do `part.parquet` publicado
 * no S3 (lidas do footer, sem baixar o arquivo) com a soma do `recordCount`
 * dos cabeçalhos das variantes no FTP (12 bytes por arquivo). Não baixa
 * nenhum DBC inteiro.
 *
 * Motivo: em 2026-10-01 a auditoria manual achou 2025-04..07 com versões
 * antigas no S3 e RJ 2021-10 sem a variante `b` (~48% dos registros), apesar
 * de o state dizer que estava tudo processado.
 *
 * Saídas: `--out` (JSON) e `--markdown` (corpo de issue), `divergentCount`
 * em $GITHUB_OUTPUT e resumo em $GITHUB_STEP_SUMMARY. Sai 0 mesmo com
 * divergência — quem decide abrir issue é o workflow.
 *
 * Uso:
 *   pnpm audit-partitions -- [--bucket <nome>] [--out audit.json] [--markdown audit.md]
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'basic-ftp';
import duckdb from 'duckdb';

import { FTP_HOST, ftpRecordCount, mapLimit } from './ftp-header.js';
import { parseSiaPaFileName } from './lib/sia-pa-parser.js';
import {
  classify,
  partitionKey,
  rejectedMarkdown,
  type VerificationRow,
} from './lib/verification.js';

const SIA_PA_DIR = '/dissemin/publicos/SIASUS/200801_/Dados';

function get(argv: string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Valor ausente para ${flag}`);
  return value;
}

async function listFiles(): Promise<string[]> {
  const client = new Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: FTP_HOST, port: 21, secure: false });
    return (await client.list(SIA_PA_DIR)).filter((e) => e.type === 1).map((e) => e.name);
  } finally {
    client.close();
  }
}

function query(db: duckdb.Database, sql: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((res, rej) => {
    db.all(sql, (err, rows) => (err ? rej(err) : res(rows as Array<Record<string, unknown>>)));
  });
}

async function s3Counts(bucket: string, years: number[]): Promise<Map<string, number>> {
  const db = new duckdb.Database(':memory:');
  await new Promise<void>((res, rej) => {
    db.exec(
      "INSTALL aws; LOAD aws; CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'sa-east-1');",
      (err) => (err ? rej(err) : res()),
    );
  });
  const out = new Map<string, number>();
  for (const year of years) {
    const rows = await query(
      db,
      `SELECT file_name AS f, CAST(SUM(row_group_num_rows) AS BIGINT)::VARCHAR AS n FROM (
         SELECT DISTINCT file_name, row_group_id, row_group_num_rows
         FROM parquet_metadata('s3://${bucket}/sia-pa/ano=${year}/uf=*/mes=*/part.parquet'))
       GROUP BY 1`,
    );
    for (const r of rows) {
      const m = /ano=(\d+)\/uf=([A-Z]+)\/mes=(\d+)\/part\.parquet$/.exec(String(r['f']));
      if (m) {
        out.set(
          partitionKey({ month: Number(m[3]), uf: m[2] as string, year: Number(m[1]) }),
          Number(r['n']),
        );
      }
    }
    process.stderr.write(`  s3 ${year}: ${rows.length} partições\n`);
  }
  await new Promise<void>((res) => db.close(() => res()));
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const bucket = get(argv, '--bucket', process.env['S3_BUCKET'] ?? '');
  if (bucket === '') throw new Error('informe --bucket ou S3_BUCKET');
  const outPath = resolve(repoRoot, get(argv, '--out', 'audit.json'));
  const mdPath = resolve(repoRoot, get(argv, '--markdown', 'audit.md'));

  const files = await listFiles();
  const parts = new Map<string, { files: string[]; month: number; uf: string; year: number }>();
  for (const name of files) {
    const p = parseSiaPaFileName(name);
    if (!p) continue;
    const key = partitionKey(p);
    const bucketEntry = parts.get(key) ?? { files: [], month: p.month, uf: p.uf, year: p.year };
    bucketEntry.files.push(name);
    parts.set(key, bucketEntry);
  }
  process.stderr.write(`FTP: ${parts.size} partições em ${files.length} arquivos\n`);

  // S3 antes do FTP: os footers saem em minutos, e as ~6.600 leituras de
  // cabeçalho no FTP levam ~1 h — se o S3 viesse depois, a sessão AWS do
  // runner (1 h por padrão) expiraria no meio (HTTP 400, run 36936032619).
  const years = [...new Set([...parts.values()].map((p) => p.year))].sort((a, b) => a - b);
  const s3 = await s3Counts(bucket, years);

  const flat = [...parts.values()].flatMap((p) => p.files);
  // 12 leituras simultâneas: cada uma é um GET de 12 bytes, e o tempo é
  // dominado pela latência de conexão do FTP, não por banda.
  const counts = await mapLimit(flat, 12, (name) => ftpRecordCount(`${SIA_PA_DIR}/${name}`));
  const byFile = new Map(flat.map((name, i) => [name, counts[i] ?? null]));

  const rows: VerificationRow[] = [...parts.entries()].map(([key, p]) => {
    const fileCounts = p.files.map((f) => byFile.get(f) ?? null);
    const ftpRows = fileCounts.some((c) => c === null)
      ? null
      : fileCounts.reduce<number>((sum, c) => sum + (c ?? 0), 0);
    const rowsS3 = s3.get(key) ?? null;
    return {
      ftpRows,
      month: p.month,
      rows: rowsS3,
      status: classify(rowsS3, ftpRows),
      uf: p.uf,
      year: p.year,
    };
  });
  const problems = rows
    .filter((r) => r.status !== 'ok')
    .sort((a, b) => partitionKey(a).localeCompare(partitionKey(b)));
  const onlyInS3 = [...s3.keys()].filter((k) => !parts.has(k)).sort();

  writeFileSync(
    outPath,
    `${JSON.stringify({ checked: rows.length, generatedAt: new Date().toISOString(), onlyInS3, problems }, null, 2)}\n`,
  );
  const md = [
    `Auditoria de ${new Date().toISOString().slice(0, 10)}: ${rows.length} partições comparadas entre o S3 e o FTP.`,
    '',
    `- Divergentes ou ausentes no S3: **${problems.length}**`,
    `- Presentes no S3 e ausentes do FTP: **${onlyInS3.length}**${onlyInS3.length ? ` (${onlyInS3.slice(0, 10).join(', ')})` : ''}`,
    '',
    rejectedMarkdown(problems, 100),
    '',
    '"Linhas no parquet" é o que está publicado no S3; "recordCount no FTP" é a soma dos cabeçalhos das variantes. `sem-parquet` = partição ausente no S3.',
  ].join('\n');
  writeFileSync(mdPath, `${md}\n`);

  const divergent = problems.length + onlyInS3.length;
  if (process.env['GITHUB_OUTPUT'])
    appendFileSync(process.env['GITHUB_OUTPUT'], `divergentCount=${divergent}\n`);
  if (process.env['GITHUB_STEP_SUMMARY'])
    appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `## Auditoria S3 × FTP\n\n${md}\n`);
  process.stderr.write(
    `✓ ${rows.length} partições; ${problems.length} problemas; ${onlyInS3.length} só no S3 → ${outPath}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
