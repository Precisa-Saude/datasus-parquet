#!/usr/bin/env tsx
/**
 * Sonda o FTP DATASUS e detecta novas competências de cada dataset
 * ativo (por enquanto, só SIA-PA). Compara contra `state/<dataset>.json`
 * e emite `state/pending.json` com o delta agregado.
 *
 * Genérico por design — adicionar um dataset novo é criar uma entrada
 * em `DATASETS` abaixo apontando pro diretório FTP + regex de nomes.
 *
 * Escrito pra rodar em GH Actions:
 *   - exit 0 sempre que a sondagem roda com sucesso
 *   - escreve `hasNew`, `pendingCount`, `latestCompetencia` em
 *     $GITHUB_OUTPUT quando definido
 *
 * Uso local:
 *   pnpm detect-new
 *   pnpm detect-new -- --dataset sia-pa
 *   pnpm detect-new -- --mark-processed   (pós-archive, atualiza state)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'basic-ftp';

import { partitionArtifactPaths } from './lib/refresh-targets.js';
import { parseSiaPaFileName, SIA_PA_REGEX } from './lib/sia-pa-parser.js';

const FTP_HOST = 'ftp.datasus.gov.br';

interface DatasetConfig {
  dir: string;
  fileRegex: RegExp;
  /**
   * Extrai (uf, year, month, variant) do nome. `variant` é `''` para
   * o canônico ou `'a'`, `'b'`, ... para arquivos split (UFs grandes
   * como SP, MG, RJ quando o DBC excede o limite do formato).
   */
  parseName: (name: string) => null | { month: number; uf: string; variant: string; year: number };
}

const DATASETS: Record<string, DatasetConfig> = {
  'sia-pa': {
    dir: '/dissemin/publicos/SIASUS/200801_/Dados',
    fileRegex: SIA_PA_REGEX,
    parseName: parseSiaPaFileName,
  },
};

interface Cli {
  /**
   * Raiz dos Parquet emitidos pelo `archive-sia-pa`. `--mark-processed`
   * só promove a processada a competência que tenha artefato real aqui.
   */
  buildDir: string;
  datasets: string[];
  markProcessed: boolean;
  outPending: string;
  stateDir: string;
}

interface StateEntry {
  sourceMtime: string;
  sourceSize: number;
}

interface State {
  lastRun: string;
  processed: Record<string, Record<string, StateEntry>>;
  schemaVersion: number;
}

interface Variant {
  ftpMtime: string;
  ftpPath: string;
  ftpSize: number;
  suffix: string;
}

interface PendingEntry {
  dataset: string;
  /** mtime mais recente entre as variantes (drives delta detection). */
  ftpMtime: string;
  /** Soma dos tamanhos de todas as variantes. */
  ftpSize: number;
  month: number;
  uf: string;
  /**
   * Variantes disponíveis no FTP para esse (UF, ano, mês). Lista com
   * um elemento para arquivos canônicos; múltiplos para split files
   * (SP, MG, RJ quando DBC excede limite).
   */
  variants: Variant[];
  year: number;
}

interface PendingFile {
  detectedAt: string;
  latestCompetencia: null | string;
  pending: PendingEntry[];
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
  const datasetsArg = get('--dataset', Object.keys(DATASETS).join(','));
  return {
    buildDir: resolve(repoRoot, get('--build-dir', 'build')),
    datasets: datasetsArg.split(',').map((s) => s.trim()),
    markProcessed: argv.includes('--mark-processed'),
    outPending: resolve(repoRoot, get('--out', 'state/pending.json')),
    stateDir: resolve(repoRoot, get('--state-dir', 'state')),
  };
}

function stateFilePath(stateDir: string, dataset: string): string {
  return resolve(stateDir, `${dataset}.json`);
}

function loadState(path: string): State {
  if (!existsSync(path)) return { lastRun: '', processed: {}, schemaVersion: 1 };
  return JSON.parse(readFileSync(path, 'utf8')) as State;
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function listRemote(
  dir: string,
): Promise<Array<{ mtime: Date; name: string; size: number }>> {
  const client = new Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host: FTP_HOST, port: 21, secure: false });
    const entries = await client.list(dir);
    return entries
      .filter((e) => e.type === 1)
      .map((e) => ({ mtime: e.modifiedAt ?? new Date(0), name: e.name, size: e.size }));
  } finally {
    client.close();
  }
}

function computeDelta(
  datasetId: string,
  cfg: DatasetConfig,
  remote: Array<{ mtime: Date; name: string; size: number }>,
  state: State,
): PendingEntry[] {
  // Agrupa variantes por (uf, year, month) antes de comparar com state.
  const groups = new Map<
    string,
    { month: number; uf: string; variants: Array<Variant & { mtime: Date }>; year: number }
  >();
  for (const entry of remote) {
    if (!cfg.fileRegex.test(entry.name)) continue;
    const parsed = cfg.parseName(entry.name);
    if (!parsed) continue;
    const key = `${parsed.uf}|${parsed.year}|${parsed.month}`;
    const bucket = groups.get(key) ?? {
      month: parsed.month,
      uf: parsed.uf,
      variants: [],
      year: parsed.year,
    };
    bucket.variants.push({
      ftpMtime: entry.mtime.toISOString(),
      ftpPath: `${cfg.dir}/${entry.name}`,
      ftpSize: entry.size,
      mtime: entry.mtime,
      suffix: parsed.variant,
    });
    groups.set(key, bucket);
  }

  const out: PendingEntry[] = [];
  for (const group of groups.values()) {
    group.variants.sort((a, b) => a.suffix.localeCompare(b.suffix));
    const aggregateSize = group.variants.reduce((sum, v) => sum + v.ftpSize, 0);
    const latestMtime = group.variants.reduce(
      (latest, v) => (v.mtime.getTime() > latest.getTime() ? v.mtime : latest),
      new Date(0),
    );
    const competencia = `${group.year}-${String(group.month).padStart(2, '0')}`;
    const known = state.processed[group.uf]?.[competencia];
    const changed =
      !known ||
      known.sourceSize !== aggregateSize ||
      new Date(known.sourceMtime).getTime() !== latestMtime.getTime();
    if (!changed) continue;
    out.push({
      dataset: datasetId,
      ftpMtime: latestMtime.toISOString(),
      ftpSize: aggregateSize,
      month: group.month,
      uf: group.uf,
      variants: group.variants.map(({ ftpMtime, ftpPath, ftpSize, suffix }) => ({
        ftpMtime,
        ftpPath,
        ftpSize,
        suffix,
      })),
      year: group.year,
    });
  }
  return out.sort((a, b) => {
    if (a.uf !== b.uf) return a.uf.localeCompare(b.uf);
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
}

function setGhOutput(key: string, value: string): void {
  const file = process.env['GITHUB_OUTPUT'];
  if (!file) return;
  appendFileSync(file, `${key}=${value}\n`);
}

/**
 * Uma competência só conta como processada se o `archive-sia-pa`
 * realmente emitiu o Parquet — ou se o watchdog marcou a partição como
 * insalvável (`part.parquet.skipped`, DBC corrompido na origem).
 *
 * Sem essa checagem o merge era cego: o refresh de 2026-08-17 arquivou
 * 12 partições de AC/2024 e mesmo assim marcou as 324 competências
 * pendentes como processadas. O estado passou a alegar cobertura até
 * 2026-06 enquanto o bucket parava em 2026-02, e todo refresh seguinte
 * virou no-op porque não sobrava nada pendente.
 */
function wasArchived(cli: Cli, datasetId: string, entry: PendingEntry): boolean {
  const paths = partitionArtifactPaths(cli.buildDir, datasetId, {
    month: entry.month,
    uf: entry.uf,
    year: entry.year,
  });
  return existsSync(paths.parquet) || existsSync(paths.skippedMarker);
}

function markProcessed(cli: Cli): void {
  if (!existsSync(cli.outPending)) {
    throw new Error(`--mark-processed requer ${cli.outPending} existente.`);
  }
  const pending = JSON.parse(readFileSync(cli.outPending, 'utf8')) as PendingFile;
  const byDataset = new Map<string, PendingEntry[]>();
  for (const entry of pending.pending) {
    const bucket = byDataset.get(entry.dataset) ?? [];
    bucket.push(entry);
    byDataset.set(entry.dataset, bucket);
  }
  for (const [datasetId, entries] of byDataset) {
    const path = stateFilePath(cli.stateDir, datasetId);
    const state = loadState(path);
    let merged = 0;
    const naoArquivadas: string[] = [];
    for (const entry of entries) {
      const competencia = `${entry.year}-${String(entry.month).padStart(2, '0')}`;
      if (!wasArchived(cli, datasetId, entry)) {
        naoArquivadas.push(`${entry.uf} ${competencia}`);
        continue;
      }
      const bucket = state.processed[entry.uf] ?? {};
      bucket[competencia] = { sourceMtime: entry.ftpMtime, sourceSize: entry.ftpSize };
      state.processed[entry.uf] = bucket;
      merged += 1;
    }
    state.lastRun = new Date().toISOString();
    saveState(path, state);
    process.stderr.write(
      `✓ ${datasetId}: ${merged}/${entries.length} entradas merged em ${path}\n`,
    );
    if (naoArquivadas.length > 0) {
      // Continuam pendentes de propósito: o próximo refresh tenta de novo.
      process.stderr.write(
        `⚠ ${datasetId}: ${naoArquivadas.length} competências pendentes sem Parquet em ` +
          `${cli.buildDir} — seguem pendentes (ex.: ${naoArquivadas.slice(0, 5).join(', ')})\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.markProcessed) {
    markProcessed(cli);
    return;
  }

  const allPending: PendingEntry[] = [];
  for (const datasetId of cli.datasets) {
    const cfg = DATASETS[datasetId];
    if (!cfg) {
      process.stderr.write(`⚠ dataset desconhecido: ${datasetId} (pulando)\n`);
      continue;
    }
    const statePath = stateFilePath(cli.stateDir, datasetId);
    const state = loadState(statePath);
    process.stderr.write(
      `Sondando ${FTP_HOST}${cfg.dir} (${datasetId})… state conhece ${Object.keys(state.processed).length} UFs\n`,
    );
    const remote = await listRemote(cfg.dir);
    process.stderr.write(`  ${remote.length} arquivos no FTP\n`);
    const delta = computeDelta(datasetId, cfg, remote, state);
    process.stderr.write(`  ${delta.length} competências pendentes\n`);
    allPending.push(...delta);
  }

  const latestCompetencia =
    allPending.length === 0
      ? null
      : allPending.reduce(
          (latest, p) => {
            const c = `${p.year}-${String(p.month).padStart(2, '0')}`;
            return !latest || c > latest ? c : latest;
          },
          null as null | string,
        );

  const out: PendingFile = {
    detectedAt: new Date().toISOString(),
    latestCompetencia,
    pending: allPending,
  };

  mkdirSync(dirname(cli.outPending), { recursive: true });
  writeFileSync(cli.outPending, `${JSON.stringify(out, null, 2)}\n`);

  setGhOutput('hasNew', allPending.length > 0 ? 'true' : 'false');
  setGhOutput('pendingCount', String(allPending.length));
  if (latestCompetencia) setGhOutput('latestCompetencia', latestCompetencia);

  process.stderr.write(
    `Total: ${allPending.length} pendentes${latestCompetencia ? ` (mais recente: ${latestCompetencia})` : ''}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Erro: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
