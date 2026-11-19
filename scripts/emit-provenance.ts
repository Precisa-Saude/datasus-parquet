#!/usr/bin/env tsx
/**
 * Gera `<dataset>/provenance/ano=YYYY/uf=XX/mes=MM/part.provenance.json`
 * para cada Parquet em `build/<dataset>/`. Contém:
 *   - SHA256 do Parquet emitido
 *   - Impressão do conteúdo (linhas, independente da ordem e dos bytes
 *     do Parquet) — o `skip-unchanged` compara com ela para não
 *     republicar partição que o DATASUS re-exportou sem mudar
 *   - SHA256 e tamanho de cada DBC-fonte. Os arquivos são os que o archive
 *     registrou ter decodificado (`part.sources.json` ao lado do Parquet);
 *     o hash é lido do cache do SDK, que tem de ter cada um com o tamanho
 *     e o mtime registrados. Partição que o DATASUS publica dividida
 *     (`…a.dbc`, `…b.dbc`) lista todos em `sources`. Registro ausente,
 *     DBC ausente, divergente ou ilegível no cache derruba a emissão
 *   - Schema exato do Parquet (colunas + tipos, do footer)
 *   - Row count
 *   - gitSha do commit deste repo
 *   - Versões do decoder e do SDK
 *
 * Permite a qualquer pesquisador validar byte-a-byte contra o FTP
 * oficial. Ver docs/provenance.md.
 *
 * Uso:
 *   pnpm emit-provenance [-- --build-dir build --out build]
 *   pnpm emit-provenance -- --allow-cache-fallback   # Parquet sem registro
 *
 * `--allow-cache-fallback`: para partição sem `part.sources.json` (Parquet
 * gerado antes do registro, regeração de provenance já publicado), escolhe
 * os DBCs pelo cache, recusando lacuna entre variantes e variante única
 * sem o canônico. Não detecta variante final ausente do cache; confira o
 * resultado contra a listagem do FTP. Nenhum workflow usa essa flag.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import duckdb from 'duckdb';

import { datasusCacheDir } from './lib/cache-dir.js';
import { emitPartitionProvenance } from './lib/emit-partition.js';
import { gitSha } from './lib/git-sha.js';
import {
  buildProvenance,
  type MonthPartition,
  type PartitionSources,
  siaPaPartitionSources,
  type SourceCache,
} from './lib/provenance.js';
import { SOURCES_RECORD_FILE } from './lib/sources-record.js';
import { fingerprintParquet } from './parquet-fingerprint.js';

const DATASET_CONFIG: Record<
  string,
  {
    buildSubdir: string;
    ftpBase: string;
    /** DBCs-fonte da partição: do registro do archive ou, se permitido, do cache. */
    sourcesFor: (
      cache: SourceCache,
      ftpBase: string,
      partition: MonthPartition,
      recordText: null | string,
      options: { allowCacheFallback: boolean },
    ) => { fromCache: boolean; sources: PartitionSources };
  }
> = {
  'sia-pa': {
    buildSubdir: 'sia-pa',
    ftpBase: '/dissemin/publicos/SIASUS/200801_/Dados',
    sourcesFor: siaPaPartitionSources,
  },
};

interface Cli {
  allowCacheFallback: boolean;
  buildDir: string;
  datasets: string[];
  outDir: string;
}

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
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const datasetsArg = get('--dataset', Object.keys(DATASET_CONFIG).join(','));
  return {
    allowCacheFallback: argv.includes('--allow-cache-fallback'),
    buildDir: resolve(repoRoot, get('--build-dir', 'build')),
    datasets: datasetsArg.split(',').map((s) => s.trim()),
    outDir: resolve(repoRoot, get('--out', 'build')),
  };
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Cache de DBCs do SDK, num diretório do FTP espelhado em disco. */
function diskSourceCache(dir: string): SourceCache {
  return {
    read: (name) => {
      // Tamanho e hash do mesmo buffer: não podem divergir entre si.
      const path = join(dir, name);
      const bytes = readFileSync(path);
      return {
        bytes: bytes.byteLength,
        mtime: statSync(path).mtime.toISOString(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    size: (name) => {
      const path = join(dir, name);
      return existsSync(path) ? statSync(path).size : null;
    },
  };
}

interface PackageInfo {
  name: string;
  version: string;
}

function readPackageVersion(repoRoot: string, dep: string): PackageInfo {
  const p = resolve(repoRoot, 'node_modules', dep, 'package.json');
  if (existsSync(p)) {
    const pkg = JSON.parse(readFileSync(p, 'utf8')) as PackageInfo;
    return { name: pkg.name, version: pkg.version };
  }
  return { name: dep, version: 'unknown' };
}

async function parquetSchema(
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

interface MonthKey {
  ano: number;
  mes: number;
  uf: string;
}

function discoverMonthPartitions(root: string): MonthKey[] {
  if (!existsSync(root)) return [];
  const out: MonthKey[] = [];
  for (const anoDir of readdirSync(root)) {
    const am = anoDir.match(/^ano=(\d{4})$/);
    if (!am) continue;
    for (const ufDir of readdirSync(join(root, anoDir))) {
      const um = ufDir.match(/^uf=([A-Z]{2})$/);
      if (!um) continue;
      const monthsRoot = join(root, anoDir, ufDir);
      for (const mesDir of readdirSync(monthsRoot)) {
        const mm = mesDir.match(/^mes=(\d{2})$/);
        if (!mm) continue;
        const file = join(monthsRoot, mesDir, 'part.parquet');
        if (!existsSync(file)) continue;
        out.push({ ano: Number(am[1]), mes: Number(mm[1]), uf: um[1]! });
      }
    }
  }
  return out.sort((a, b) => {
    if (a.ano !== b.ano) return a.ano - b.ano;
    if (a.uf !== b.uf) return a.uf.localeCompare(b.uf);
    return a.mes - b.mes;
  });
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const cacheDir = datasusCacheDir();
  const sha = gitSha(repoRoot);
  const decoder = readPackageVersion(repoRoot, '@precisa-saude/datasus-dbc');
  const sdk = readPackageVersion(repoRoot, '@precisa-saude/datasus');
  const fingerprintDb = new duckdb.Database(':memory:');
  const failures: string[] = [];

  for (const datasetId of cli.datasets) {
    const cfg = DATASET_CONFIG[datasetId];
    if (!cfg) {
      process.stderr.write(`⚠ dataset desconhecido: ${datasetId} (pulando)\n`);
      continue;
    }
    const inRoot = resolve(cli.buildDir, cfg.buildSubdir);
    const outRoot = resolve(cli.outDir, cfg.buildSubdir, 'provenance');
    const parts = discoverMonthPartitions(inRoot);
    const sourceCache = diskSourceCache(join(cacheDir, cfg.ftpBase));
    let written = 0;
    const fromCache: string[] = [];
    const beforeRecord: string[] = [];
    const legacy: string[] = [];
    process.stderr.write(
      `${datasetId}: ${parts.length} partições; git ${sha.slice(0, 7)}; decoder ${decoder.version}\n`,
    );

    for (const p of parts) {
      const mesStr = String(p.mes).padStart(2, '0');
      const partitionDir = join(inRoot, `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}`);
      const parquetFile = join(partitionDir, 'part.parquet');
      const recordFile = join(partitionDir, SOURCES_RECORD_FILE);
      const outPath = join(
        outRoot,
        `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}`,
        'part.provenance.json',
      );

      const label = `${p.uf} ${p.ano}-${mesStr}`;
      // O Parquet só é lido depois de os DBCs-fonte serem conferidos. Sem
      // registro e sem fallback, provenance local já existente fica intacto
      // (partição anterior ao registro no `build/` persistente do backfill);
      // nos demais erros a partição não ganha provenance, nem fica o de um
      // run anterior, e a falha é reportada no fim (ver abaixo).
      const result = await emitPartitionProvenance({
        allowCacheFallback: cli.allowCacheFallback,
        buildBody: async (sources) => {
          const { rows, schema } = await parquetSchema(parquetFile);
          return buildProvenance({
            dataset: datasetId,
            generatedAt: new Date().toISOString(),
            output: {
              file: `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}/part.parquet`,
              fingerprint: await fingerprintParquet(fingerprintDb, parquetFile),
              rows,
              schema,
              sha256: sha256OfFile(parquetFile),
            },
            partition: { ano: p.ano, mes: p.mes, uf: p.uf },
            pipeline: {
              archiveScript: `scripts/archive-${datasetId}.ts@${sha}`,
              datasusSdk: `${sdk.name}@${sdk.version}`,
              decoder: `${decoder.name}@${decoder.version}`,
            },
            sources,
          });
        },
        outPath,
        parquetSha256: () => sha256OfFile(parquetFile),
        recordPath: recordFile,
        sourcesFor: (recordText) =>
          cfg.sourcesFor(sourceCache, cfg.ftpBase, p, recordText, {
            allowCacheFallback: cli.allowCacheFallback,
          }),
      });
      if (result.kind === 'falhou') {
        failures.push(`${datasetId} ${label}: ${result.message}`);
      } else if (result.kind === 'anterior-ao-registro') {
        (result.legacy ? legacy : beforeRecord).push(label);
      } else {
        written += 1;
        if (result.fromCache) fromCache.push(label);
      }
    }

    process.stderr.write(`✓ provenance: ${written}/${parts.length} arquivos em ${outRoot}\n`);
    if (beforeRecord.length > 0) {
      process.stderr.write(
        `⚠ ${beforeRecord.length} partição(ões) anterior(es) ao registro: sem ` +
          `${SOURCES_RECORD_FILE}, provenance local mantido (output.sha256 confere com o ` +
          `Parquet): ${beforeRecord.join(', ')}\n`,
      );
    }
    if (legacy.length > 0) {
      process.stderr.write(
        `⚠ ${legacy.length} partição(ões) mantida(s) com provenance no formato inválido de ` +
          `antes de 19/11/2026 (source com 0 byte ou sem SHA-256 válido). Regere com ` +
          `--allow-cache-fallback ou um novo archive: ${legacy.join(', ')}\n`,
      );
    }
    if (fromCache.length > 0) {
      process.stderr.write(
        `⚠ ${fromCache.length} partição(ões) sem ${SOURCES_RECORD_FILE}, com DBCs escolhidos ` +
          `pelo cache (--allow-cache-fallback). Variante final ausente do cache não é ` +
          `detectada; confira contra a listagem do FTP: ${fromCache.join(', ')}\n`,
      );
    }
  }
  await new Promise<void>((res) => fingerprintDb.close(() => res()));

  // Falha alta, depois de tentar todas as partições para listar todas as
  // faltas de uma vez: provenance que não descreve os DBCs decodificados não
  // pode ser publicado.
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} partição(ões) sem DBC-fonte verificável (registro do archive + ` +
        `cache) — nenhum provenance foi escrito para elas:\n  ${failures.join('\n  ')}`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
