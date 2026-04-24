#!/usr/bin/env tsx
/**
 * Gera `build/manifest.json` com catálogo completo dos datasets:
 * cobertura (UFs × anos × meses), tamanho total, schema summary,
 * última atualização. Consumido pelo site de documentação e por
 * tooling externo que queira auto-descobrir a cobertura.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Cli {
  buildDir: string;
  outFile: string;
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
    if (value === undefined || value.startsWith('--')) throw new Error(`Valor ausente para ${flag}`);
    return value;
  };
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return {
    buildDir: resolve(repoRoot, get('--build-dir', 'build')),
    outFile: resolve(repoRoot, get('--out', 'build/manifest.json')),
  };
}

function discoverDatasets(buildDir: string): string[] {
  if (!existsSync(buildDir)) return [];
  return readdirSync(buildDir)
    .filter((d) => !d.startsWith('_') && statSync(join(buildDir, d)).isDirectory())
    .sort();
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
        out.push({ ano: Number(am[1]), bytes: statSync(file).size, mes: Number(mm[1]), uf: um[1]! });
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
  const datasets = discoverDatasets(cli.buildDir);
  const manifest: { datasets: Record<string, DatasetSummary>; generatedAt: string } = {
    datasets: {},
    generatedAt: new Date().toISOString(),
  };
  for (const d of datasets) {
    if (d === 'manifest.json') continue;
    const parts = discoverPartitions(join(cli.buildDir, d));
    if (parts.length === 0) continue;
    manifest.datasets[d] = summarize(parts);
  }
  mkdirSync(resolve(cli.outFile, '..'), { recursive: true });
  writeFileSync(cli.outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(
    `✓ manifest.json: ${Object.keys(manifest.datasets).length} datasets em ${cli.outFile}\n`,
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
