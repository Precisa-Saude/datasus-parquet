#!/usr/bin/env tsx
/**
 * Gera `build/manifest.json` com catálogo completo dos datasets:
 * cobertura (UFs × anos × meses), tamanho total, schema summary,
 * última atualização. Consumido pelo site de documentação e por
 * tooling externo que queira auto-descobrir a cobertura.
 *
 * Modos:
 *  - default: varre o diretório `build/` local (uso em backfill, que
 *    materializa o dataset inteiro localmente antes de subir).
 *  - --s3-listing <arquivo>: constrói a partir de uma listagem do bucket
 *    (`aws s3 ls --recursive`). Uso em refresh, onde `build/` só contém
 *    o delta — sem essa flag o manifest publicado regrediria pra só o
 *    delta, apagando o catálogo histórico. Ver `refresh.yml`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Cli {
  buildDir: string;
  outFile: string;
  s3Listing: string | undefined;
}

interface Partition {
  ano: number;
  bytes: number;
  mes: number;
  uf: string;
}

interface DatasetSummary {
  bytes: number;
  competencias: string[];
  partitions: number;
  ufs: string[];
  years: number[];
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
  const optional = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Valor ausente para ${flag}`);
    return value;
  };
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const s3Listing = optional('--s3-listing');
  return {
    buildDir: resolve(repoRoot, get('--build-dir', 'build')),
    outFile: resolve(repoRoot, get('--out', 'build/manifest.json')),
    s3Listing: s3Listing ? resolve(repoRoot, s3Listing) : undefined,
  };
}

function discoverDatasets(buildDir: string): string[] {
  if (!existsSync(buildDir)) return [];
  return readdirSync(buildDir)
    .filter((d) => !d.startsWith('_') && statSync(join(buildDir, d)).isDirectory())
    .sort();
}

function partitionsFromS3Listing(listingPath: string): Map<string, Partition[]> {
  const text = readFileSync(listingPath, 'utf8');
  const byDataset = new Map<string, Partition[]>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // formato `aws s3 ls --recursive`: "YYYY-MM-DD HH:MM:SS  <size>  <key>"
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const size = Number(cols[2]);
    const key = cols.slice(3).join(' ');
    if (!Number.isFinite(size)) continue;
    const m = key.match(/^([^/]+)\/ano=(\d{4})\/uf=([A-Z]{2})\/mes=(\d{2})\/part\.parquet$/);
    if (!m) continue;
    const dataset = m[1]!;
    const list = byDataset.get(dataset) ?? [];
    list.push({ ano: Number(m[2]), bytes: size, mes: Number(m[4]), uf: m[3]! });
    byDataset.set(dataset, list);
  }
  return byDataset;
}

function discoverPartitions(root: string): Partition[] {
  if (!existsSync(root)) return [];
  const out: Partition[] = [];
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
        out.push({
          ano: Number(am[1]),
          bytes: statSync(file).size,
          mes: Number(mm[1]),
          uf: um[1]!,
        });
      }
    }
  }
  return out;
}

function summarize(parts: Partition[]): DatasetSummary {
  const years = new Set<number>();
  const ufs = new Set<string>();
  const competencias = new Set<string>();
  let bytes = 0;
  for (const p of parts) {
    years.add(p.ano);
    ufs.add(p.uf);
    competencias.add(`${p.ano}-${String(p.mes).padStart(2, '0')}`);
    bytes += p.bytes;
  }
  return {
    bytes,
    competencias: [...competencias].sort(),
    partitions: parts.length,
    ufs: [...ufs].sort(),
    years: [...years].sort((a, b) => a - b),
  };
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const manifest: { datasets: Record<string, DatasetSummary>; generatedAt: string } = {
    datasets: {},
    generatedAt: new Date().toISOString(),
  };
  if (cli.s3Listing !== undefined) {
    const byDataset = partitionsFromS3Listing(cli.s3Listing);
    for (const [d, parts] of [...byDataset.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (parts.length === 0) continue;
      manifest.datasets[d] = summarize(parts);
    }
  } else {
    const datasets = discoverDatasets(cli.buildDir);
    for (const d of datasets) {
      if (d === 'manifest.json') continue;
      const parts = discoverPartitions(join(cli.buildDir, d));
      if (parts.length === 0) continue;
      manifest.datasets[d] = summarize(parts);
    }
  }
  mkdirSync(resolve(cli.outFile, '..'), { recursive: true });
  writeFileSync(cli.outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const totalParts = Object.values(manifest.datasets).reduce((a, d) => a + d.partitions, 0);
  process.stderr.write(
    `✓ manifest.json: ${Object.keys(manifest.datasets).length} datasets, ${totalParts} partições em ${cli.outFile}\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}
