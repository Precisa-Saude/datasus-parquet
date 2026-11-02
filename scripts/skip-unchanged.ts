#!/usr/bin/env tsx
/**
 * Tira do upload as partições cujo conteúdo decodificado é idêntico ao já
 * publicado.
 *
 * O DATASUS reescreve 12 competências a cada publicação e também
 * re-exporta DBCs sem mudar o conteúdo (tamanho e mtime mudam, as linhas
 * não). Só dá para saber depois de decodificar — então decodificamos
 * tudo, mas não republicamos o que não mudou: sem upload para o S3, o
 * `Last-Modified` no CDN fica como está e o datasus-viz não reagrega.
 *
 * Para cada partição verificada (`_verified.json`):
 *   1. calcula a impressão do conteúdo do `part.parquet` local;
 *   2. lê o `output.fingerprint` do provenance publicado no S3;
 *   3. se iguais, move o `part.parquet` para `--unchanged-dir` e deixa um
 *      marker `part.parquet.unchanged` no lugar, que o `--mark-processed`
 *      aceita como prova de que a competência foi tratada. O provenance
 *      publicado continua valendo: descreve exatamente o objeto no S3.
 *
 * Provenance sem impressão (anterior a esta versão) ou ausente → a
 * partição conta como alterada e é publicada normalmente.
 *
 * Uso:
 *   pnpm skip-unchanged -- --from-verified build-refresh/_verified.json \
 *     --build-dir build-refresh --unchanged-dir build-unchanged \
 *     --bucket <S3_BUCKET>
 */
import { execFile } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import duckdb from 'duckdb';

import { mapLimit } from './ftp-header.js';
import {
  isUnchanged,
  publishedFingerprint,
  unchangedMarkdown,
  type UnchangedRow,
} from './lib/content-fingerprint.js';
import { partitionArtifactPaths } from './lib/refresh-targets.js';
import { type VerifiedFile } from './lib/verification.js';
import { fingerprintParquet } from './parquet-fingerprint.js';

const execFileAsync = promisify(execFile);

function get(argv: string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Valor ausente para ${flag}`);
  return value;
}

function provenanceKey(dataset: string, uf: string, year: number, month: number): string {
  return `${dataset}/provenance/ano=${year}/uf=${uf}/mes=${String(month).padStart(2, '0')}/part.provenance.json`;
}

/** Provenance publicado, ou `null` se não existir no bucket. */
async function fetchPublished(bucket: string, key: string): Promise<null | string> {
  try {
    const { stdout } = await execFileAsync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, '-'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NoSuchKey|404|does not exist/i.test(msg)) return null;
    throw err;
  }
}

function writeGh(file: string | undefined, text: string): void {
  if (file) appendFileSync(file, text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const verifiedPath = resolve(repoRoot, get(argv, '--from-verified', 'build/_verified.json'));
  const buildDir = resolve(repoRoot, get(argv, '--build-dir', 'build'));
  const unchangedDir = resolve(repoRoot, get(argv, '--unchanged-dir', 'build-unchanged'));
  const bucket = get(argv, '--bucket', process.env['S3_BUCKET'] ?? '');
  const dataset = get(argv, '--dataset', 'sia-pa');
  if (!bucket) throw new Error('--bucket (ou S3_BUCKET) é obrigatório');
  if (!existsSync(verifiedPath)) throw new Error(`_verified.json não encontrado: ${verifiedPath}`);

  const verified = (JSON.parse(readFileSync(verifiedPath, 'utf8')) as VerifiedFile).verified;
  const db = new duckdb.Database(':memory:');
  const unchanged: UnchangedRow[] = [];
  let changed = 0;
  let semImpressaoPublicada = 0;

  await mapLimit(verified, 4, async (v) => {
    const target = { month: v.month, uf: v.uf, year: v.year };
    const paths = partitionArtifactPaths(buildDir, dataset, target);
    if (!existsSync(paths.parquet)) return;
    const local = await fingerprintParquet(db, paths.parquet);
    const raw = await fetchPublished(bucket, provenanceKey(dataset, v.uf, v.year, v.month));
    const published = publishedFingerprint(raw);
    if (published === null) semImpressaoPublicada += 1;
    if (!isUnchanged(local, published)) {
      changed += 1;
      return;
    }
    const publishedAt = (JSON.parse(raw ?? '{}') as { generatedAt?: string }).generatedAt ?? null;
    const dest = paths.parquet.replace(buildDir, unchangedDir);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(paths.parquet, dest);
    writeFileSync(
      paths.unchangedMarker,
      `${JSON.stringify({ fingerprint: local, movedTo: dest, publishedAt }, null, 2)}\n`,
    );
    unchanged.push({ fingerprint: local, publishedAt, ...target });
  });
  await new Promise<void>((res) => db.close(() => res()));

  unchanged.sort((a, b) => a.uf.localeCompare(b.uf) || a.year - b.year || a.month - b.month);
  const outPath = resolve(buildDir, '_unchanged.json');
  writeFileSync(
    outPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), unchanged }, null, 2)}\n`,
  );

  writeGh(
    process.env['GITHUB_OUTPUT'],
    `unchangedCount=${unchanged.length}\nchangedCount=${changed}\n`,
  );
  writeGh(
    process.env['GITHUB_STEP_SUMMARY'],
    `## Conteúdo idêntico ao publicado\n\n- ${unchanged.length} partições puladas (decodificadas, não republicadas)\n- ${changed} partições com conteúdo novo\n- ${semImpressaoPublicada} sem impressão publicada (provenance antigo ou ausente)\n\n${unchangedMarkdown(unchanged)}\n`,
  );
  process.stderr.write(
    `✓ ${unchanged.length} partições idênticas ao publicado (movidas para ${unchangedDir}), ` +
      `${changed} com conteúdo novo, ${semImpressaoPublicada} sem impressão publicada → ${outPath}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
