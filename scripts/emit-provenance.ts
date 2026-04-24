#!/usr/bin/env tsx
/**
 * Gera `<dataset>/provenance/ano=YYYY/uf=XX/mes=MM/part.provenance.json`
 * para cada Parquet em `build/<dataset>/`. Contém:
 *   - SHA256 do Parquet emitido
 *   - SHA256 do DBC-fonte (lido do cache `@precisa-saude/datasus`)
 *   - Schema exato do Parquet (colunas + tipos, do footer)
 *   - Row count
 *   - gitSha do commit deste repo
 *   - Versões do decoder e do SDK
 *
 * Permite a qualquer pesquisador validar byte-a-byte contra o FTP
 * oficial. Ver docs/provenance.md.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import duckdb from 'duckdb';

const DATASET_CONFIG: Record<
  string,
  {
    buildSubdir: string;
    ftpBase: string;
    sourceFileFor: (uf: string, year: number, month: number) => string;
  }
> = {
  'sia-pa': {
    buildSubdir: 'sia-pa',
    ftpBase: '/dissemin/publicos/SIASUS/200801_/Dados',
    sourceFileFor: (uf, year, month) =>
      `PA${uf}${String(year).slice(2)}${String(month).padStart(2, '0')}.dbc`,
  },
};

interface Cli {
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
    buildDir: resolve(repoRoot, get('--build-dir', 'build')),
    datasets: datasetsArg.split(',').map((s) => s.trim()),
    outDir: resolve(repoRoot, get('--out', 'build')),
  };
}

function defaultCacheDir(): string {
  return process.env['XDG_CACHE_HOME']
    ? join(process.env['XDG_CACHE_HOME'], 'datasus-brasil')
    : join(homedir(), '.cache', 'datasus-brasil');
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitSha(repoRoot: string): string {
  try {
    const headRef = readFileSync(join(repoRoot, '.git', 'HEAD'), 'utf8').trim();
    if (headRef.startsWith('ref: ')) {
      return readFileSync(join(repoRoot, '.git', headRef.slice(5)), 'utf8').trim();
    }
    return headRef;
  } catch {
    return 'unknown';
  }
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
  const cacheDir = defaultCacheDir();
  const sha = gitSha(repoRoot);
  const decoder = readPackageVersion(repoRoot, '@precisa-saude/datasus-dbc');
  const sdk = readPackageVersion(repoRoot, '@precisa-saude/datasus');

  for (const datasetId of cli.datasets) {
    const cfg = DATASET_CONFIG[datasetId];
    if (!cfg) {
      process.stderr.write(`⚠ dataset desconhecido: ${datasetId} (pulando)\n`);
      continue;
    }
    const inRoot = resolve(cli.buildDir, cfg.buildSubdir);
    const outRoot = resolve(cli.outDir, cfg.buildSubdir, 'provenance');
    const parts = discoverMonthPartitions(inRoot);
    process.stderr.write(
      `${datasetId}: ${parts.length} partições; git ${sha.slice(0, 7)}; decoder ${decoder.version}\n`,
    );

    for (const p of parts) {
      const mesStr = String(p.mes).padStart(2, '0');
      const parquetFile = join(inRoot, `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}/part.parquet`);
      const sourceFile = cfg.sourceFileFor(p.uf, p.ano, p.mes);
      const cachedSource = join(cacheDir, cfg.ftpBase, sourceFile);

      const { rows, schema } = await parquetSchema(parquetFile);
      const parquetSha = sha256OfFile(parquetFile);
      const source = existsSync(cachedSource)
        ? {
            bytes: statSync(cachedSource).size,
            file: sourceFile,
            ftpPath: `${cfg.ftpBase}/${sourceFile}`,
            mtime: statSync(cachedSource).mtime.toISOString(),
            sha256: sha256OfFile(cachedSource),
          }
        : {
            bytes: 0,
            file: sourceFile,
            ftpPath: `${cfg.ftpBase}/${sourceFile}`,
            mtime: '',
            sha256: '',
          };

      const body = {
        dataset: datasetId,
        generatedAt: new Date().toISOString(),
        output: {
          columns: schema.length,
          file: `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}/part.parquet`,
          rows,
          schema,
          sha256: parquetSha,
        },
        partition: { ano: p.ano, mes: p.mes, uf: p.uf },
        pipeline: {
          archiveScript: `scripts/archive-${datasetId}.ts@${sha}`,
          datasusSdk: `${sdk.name}@${sdk.version}`,
          decoder: `${decoder.name}@${decoder.version}`,
          notes: 'Conversão 1:1 DBC→Parquet, sem filtro, sem enriquecimento.',
        },
        source,
      };

      const outPath = join(outRoot, `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}/part.provenance.json`);
      mkdirSync(join(outRoot, `ano=${p.ano}/uf=${p.uf}/mes=${mesStr}`), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(body, null, 2)}\n`);
    }

    process.stderr.write(`✓ provenance: ${parts.length} arquivos em ${outRoot}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
