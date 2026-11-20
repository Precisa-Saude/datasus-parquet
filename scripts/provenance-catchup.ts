#!/usr/bin/env tsx
/**
 * Proveniência retroativa: escreve `part.provenance.json` para partições
 * SIA-PA já publicadas sem provenance, ou com o do formato inválido de
 * antes de 19/11/2026, sem decodificar DBC e sem tocar no Parquet. Regras
 * (seleção, certificação da fonte, orçamento, marcador `reconstructed`) em
 * `lib/provenance-catchup.ts`; operação em docs/operations.md.
 *
 * Por partição certificada, do mais antigo ao mais novo, até o orçamento:
 *   - cada DBC vem do cache do SDK se estiver lá com o tamanho da listagem,
 *     senão é baixado (`fetchVerified`, o mesmo caminho do archive); o
 *     SHA-256 é calculado dos bytes, sem decodificar;
 *   - o Parquet vem do `--build-dir` se tamanho e ETag conferirem com o S3
 *     (`lib/s3-objects.ts`), senão é baixado do S3 (e conferido do mesmo
 *     jeito); `output` sai de `parquet-output.ts`, como no `emit-provenance`;
 *   - linhas do Parquet ≠ soma dos `recordCount` dos cabeçalhos → pulada;
 *   - o provenance é gravado em `<work-dir>/sia-pa/provenance/…` e, fora do
 *     `--dry-run`, enviado para a mesma chave no bucket — o único upload.
 *
 * Uso:
 *   pnpm provenance-catchup -- --bucket <S3_BUCKET> --pending state/pending.json
 *   pnpm provenance-catchup -- --bucket <S3_BUCKET> --pending /tmp/pending.json \
 *     --budget-gb 5 --dry-run
 *   # sem S3 nem FTP (testes): diretório no lugar do bucket, listagem salva
 *   pnpm provenance-catchup -- --local-bucket /tmp/bucket --ftp-listing /tmp/ftp.json \
 *     --pending /tmp/pending.json --state /tmp/state.json --dry-run
 *
 * Sai com erro se alguma partição falhar (depois de tentar todas);
 * partição pulada ou restante por orçamento não é erro.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { download } from '@precisa-saude/datasus-sdk';
import duckdb from 'duckdb';

import { awsBucket, type CatchupBucket, localBucket } from './catchup-bucket.js';
import { listFtpDir } from './ftp-listing.js';
import { datasusCacheDir } from './lib/cache-dir.js';
import { type DownloadFn, fetchVerified } from './lib/dbc-source.js';
import { groupListing, type ListingGroup, parseListingFile } from './lib/ftp-groups.js';
import { gitSha } from './lib/git-sha.js';
import { pipelinePackages } from './lib/package-version.js';
import { type KnownEntry } from './lib/pending-selection.js';
import { describeSource, serializeProvenance, toPartitionSources } from './lib/provenance.js';
import {
  buildReconstructedProvenance,
  bytesToDownload,
  catchupMarkdown,
  type CertifiedCandidate,
  certifySource,
  checkRecordCount,
  type ProcessOutcome,
  publishedPartitions,
  runCatchup,
  selectCandidates,
  type Skipped,
} from './lib/provenance-catchup.js';
import { parsePendingTargets } from './lib/refresh-targets.js';
import { matchesS3Etag, parquetKey, provenanceKey } from './lib/s3-objects.js';
import { parseSiaPaFileName, SIA_PA_REGEX } from './lib/sia-pa-parser.js';
import { parseRecordCount, partitionKey } from './lib/verification.js';
import { parquetOutput } from './parquet-output.js';

const DATASET = 'sia-pa';
const FTP_DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const FETCH_ATTEMPTS = 3;

interface Cli {
  bucket: CatchupBucket;
  budgetBytes: number;
  buildDir: string;
  dryRun: boolean;
  ftpListing: null | string;
  pending: string;
  repoRoot: string;
  state: string;
  workDir: string;
}

function parseArgs(argv: string[]): Cli {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return fallback;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Valor ausente para ${flag}`);
    return value;
  };
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const bucketName = get('--bucket', '');
  const localDir = get('--local-bucket', '');
  if ((bucketName === '') === (localDir === '')) {
    throw new Error('informe exatamente um de --bucket <nome> ou --local-bucket <diretório>');
  }
  // Obrigatório, como o --previous-newest do skip-unchanged: esquecer o
  // pending faria a retroativa disputar partições com o archive do run.
  const pending = get('--pending', '');
  if (pending === '') throw new Error('--pending <pending.json do run> é obrigatório');
  const budgetGb = Number(get('--budget-gb', '20'));
  if (!Number.isFinite(budgetGb) || budgetGb < 0) {
    throw new Error('--budget-gb requer número ≥ 0 (GB de DBC baixados do FTP)');
  }
  const ftpListing = get('--ftp-listing', '');
  return {
    bucket: bucketName ? awsBucket(bucketName) : localBucket(resolve(repoRoot, localDir)),
    budgetBytes: budgetGb * 1e9,
    buildDir: resolve(repoRoot, get('--build-dir', 'build')),
    dryRun: argv.includes('--dry-run'),
    ftpListing: ftpListing ? resolve(repoRoot, ftpListing) : null,
    pending: resolve(repoRoot, pending),
    repoRoot,
    state: resolve(repoRoot, get('--state', `state/${DATASET}.json`)),
    workDir: resolve(repoRoot, get('--work-dir', 'build-catchup')),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function writeGh(env: string, text: string): void {
  const file = process.env[env];
  if (file) appendFileSync(file, text);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  // Antes de tudo: pacote ausente derruba o run sem gravar versão desconhecida.
  const packages = pipelinePackages(cli.repoRoot);
  const sha = gitSha(cli.repoRoot);
  const cacheRoot = join(datasusCacheDir(), FTP_DIR);
  const cachedSize = (name: string): null | number => {
    const path = join(cacheRoot, name);
    return existsSync(path) ? statSync(path).size : null;
  };
  const log = (line: string): boolean => process.stderr.write(`${line}\n`);
  log(
    `Proveniência retroativa ${cli.dryRun ? '(dry-run) ' : ''}em ${cli.bucket.name}; ` +
      `git ${sha.slice(0, 7)}; ${packages.datasusSdk}; ${packages.decoder}`,
  );

  // Seleção: Parquet publicado sem provenance ou com provenance legado.
  const objects = await cli.bucket.list(`${DATASET}/`);
  const mirror = await cli.bucket.mirrorProvenance(DATASET, cli.workDir);
  const partitions = publishedPartitions(objects, DATASET, (key) => {
    const path = join(mirror, key);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  });
  const pendingKeys = new Set(
    parsePendingTargets(readFileSync(cli.pending, 'utf8'), DATASET).map((t) => partitionKey(t)),
  );
  const selection = selectCandidates(partitions, pendingKeys);
  log(
    `  ${partitions.length} Parquet publicados; ${selection.candidates.length} candidatas; ` +
      `${selection.current.length} já no formato atual; ${selection.pending.length} pendentes no run`,
  );

  // Certificação contra a listagem do FTP (agrupamento do detect-new) e o state.
  const listed = cli.ftpListing
    ? parseListingFile(readFileSync(cli.ftpListing, 'utf8'))
    : await listFtpDir(FTP_DIR);
  const groups = new Map<string, ListingGroup>(
    groupListing(listed, {
      dir: FTP_DIR,
      fileRegex: SIA_PA_REGEX,
      parseName: parseSiaPaFileName,
    }).map((g) => [partitionKey(g), g]),
  );
  const state = JSON.parse(readFileSync(cli.state, 'utf8')) as {
    processed: Record<string, Record<string, KnownEntry>>;
  };
  const certified: CertifiedCandidate[] = [];
  const certificationSkipped: Skipped[] = [];
  for (const c of selection.candidates) {
    const comp = `${c.ano}-${String(c.mes).padStart(2, '0')}`;
    const known = state.processed[c.uf]?.[comp];
    const r = certifySource(
      c,
      groups.get(partitionKey({ month: c.mes, uf: c.uf, year: c.ano })),
      known,
      FTP_DIR,
    );
    if (r.ok) certified.push(r.certified);
    else certificationSkipped.push(r.skipped);
  }
  log(`  ${certified.length} certificadas; ${certificationSkipped.length} puladas na certificação`);

  let downloaded = 0;
  const sdkDownload: DownloadFn = (opts) => {
    let last = 0;
    return download({
      ...opts,
      onProgress: (e) => {
        if (e.fromCache) return;
        downloaded += e.transferred - last;
        last = e.transferred;
      },
    });
  };
  const fetchDbc = async (f: CertifiedCandidate['files'][number]): Promise<Uint8Array> => {
    if (cachedSize(f.name) === f.size) return readFileSync(join(cacheRoot, f.name));
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetchVerified(f, FTP_DIR, sdkDownload);
      } catch (err) {
        if (attempt >= FETCH_ATTEMPTS) throw err;
        log(`  ⚠ ${f.name}: ${(err as Error).message} — nova tentativa`);
        await sleep(5000 * attempt);
      }
    }
  };

  const fingerprintDb = new duckdb.Database(':memory:');
  const process_ = async (c: CertifiedCandidate): Promise<ProcessOutcome> => {
    // DBCs: um de cada vez na memória; hash e cabeçalho, sem decodificar.
    const described = [];
    const counts: Array<null | number> = [];
    for (const f of c.files) {
      const bytes = await fetchDbc(f);
      const read = {
        bytes: bytes.byteLength,
        mtime: statSync(join(cacheRoot, f.name)).mtime.toISOString(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      described.push(
        describeSource({ read: () => read, size: () => read.bytes }, f.ftpPath, f.name, f.size),
      );
      counts.push(parseRecordCount(bytes.subarray(0, 12)));
    }

    // Parquet publicado: do build local se for o mesmo objeto, senão do S3.
    const rel = parquetKey(DATASET, c).slice(DATASET.length + 1);
    const local = join(cli.buildDir, DATASET, rel);
    const isPublished = (path: string): boolean =>
      statSync(path).size === c.parquet.size && matchesS3Etag(c.parquet.etag, readFileSync(path));
    let parquetPath = local;
    let fromS3 = false;
    if (!existsSync(local) || !isPublished(local)) {
      parquetPath = join(cli.workDir, 'parquet', rel);
      fromS3 = true;
      await cli.bucket.download(parquetKey(DATASET, c), parquetPath);
      if (!isPublished(parquetPath)) {
        rmSync(parquetPath, { force: true });
        throw new Error('Parquet baixado não confere com o tamanho/ETag listados (mudou no S3?)');
      }
    }
    try {
      const output = await parquetOutput(fingerprintDb, parquetPath, rel);
      const mismatch = checkRecordCount(output.rows, counts);
      if (mismatch) return { ...mismatch, kind: 'pulado' };
      const body = buildReconstructedProvenance(
        {
          dataset: DATASET,
          generatedAt: new Date().toISOString(),
          output,
          partition: { ano: c.ano, mes: c.mes, uf: c.uf },
          pipeline: {
            archiveScript: `scripts/archive-${DATASET}.ts@${sha}`,
            datasusSdk: packages.datasusSdk,
            decoder: packages.decoder,
          },
          sources: toPartitionSources(described),
        },
        c,
        output.rows,
      );
      const key = provenanceKey(DATASET, c);
      const outFile = join(cli.workDir, key);
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, serializeProvenance(body));
      if (!cli.dryRun) await cli.bucket.upload(outFile, key, DATASET);
      log(
        `  ✓ ${c.label} (${c.reason}; ${c.files.length} DBC; Parquet ${fromS3 ? 'do S3' : 'do build'})`,
      );
      return { kind: 'escrito', uploaded: !cli.dryRun };
    } finally {
      if (fromS3) rmSync(parquetPath, { force: true });
    }
  };

  const report = await runCatchup(certified, cli.budgetBytes, {
    downloadBytes: (c) => bytesToDownload(c.files, cachedSize),
    process: process_,
    spentBytes: () => downloaded,
  });
  await new Promise<void>((res) => fingerprintDb.close(() => res()));

  const markdown = catchupMarkdown({
    budgetBytes: cli.budgetBytes,
    certificationSkipped,
    downloadedBytes: downloaded,
    dryRun: cli.dryRun,
    report,
    selection,
  });
  writeGh('GITHUB_STEP_SUMMARY', markdown);
  writeGh(
    'GITHUB_OUTPUT',
    `doneCount=${report.done.length}\nuploadedCount=${report.uploaded}\n` +
      `failedCount=${report.failed.length}\nremainingCount=${report.remaining.length}\n`,
  );
  log(markdown);
  if (report.failed.length > 0) {
    throw new Error(`${report.failed.length} partição(ões) falharam — ver o resumo acima`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
