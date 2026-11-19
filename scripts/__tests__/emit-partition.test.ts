import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { emitPartitionProvenance } from '../lib/emit-partition.js';
import {
  type CachedFile,
  type PartitionSources,
  siaPaPartitionSources,
  type SourceCache,
} from '../lib/provenance.js';
import { serializeSourcesRecord, type SourcesRecord } from '../lib/sources-record.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const MG = { ano: 2025, mes: 8, uf: 'MG' };
const A: CachedFile = { bytes: 10, mtime: '2026-09-30T22:02:10.000Z', sha256: 'a'.repeat(64) };
const B: CachedFile = { bytes: 20, mtime: '2026-09-30T22:03:10.000Z', sha256: 'b'.repeat(64) };

/** Provenance publicado antes do registro existir (formato antigo, partição dividida). */
const PROVENANCE_ANTIGO = `${JSON.stringify(
  { dataset: 'sia-pa', source: { bytes: 0, file: 'PAMG2508.dbc', sha256: '' } },
  null,
  2,
)}\n`;

function cacheOf(files: Record<string, CachedFile>): SourceCache {
  return { read: (n) => files[n]!, size: (n) => files[n]?.bytes ?? null };
}

const RECORD: SourcesRecord = {
  files: [
    {
      bytes: 10,
      cacheMtime: A.mtime,
      file: 'PAMG2508a.dbc',
      ftpMtime: null,
      ftpPath: `${DIR}/PAMG2508a.dbc`,
    },
    {
      bytes: 20,
      cacheMtime: B.mtime,
      file: 'PAMG2508b.dbc',
      ftpMtime: null,
      ftpPath: `${DIR}/PAMG2508b.dbc`,
    },
  ],
  partition: MG,
  version: 1,
};

/** Diretórios de uma partição: entrada (Parquet + registro) e saída (provenance). */
function setup(opts: { provenance?: boolean; record?: boolean }): {
  outPath: string;
  recordPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'emit-partition-'));
  const inDir = join(root, 'sia-pa/ano=2025/uf=MG/mes=08');
  const outDir = join(root, 'sia-pa/provenance/ano=2025/uf=MG/mes=08');
  mkdirSync(inDir, { recursive: true });
  const recordPath = join(inDir, 'part.sources.json');
  const outPath = join(outDir, 'part.provenance.json');
  if (opts.record) writeFileSync(recordPath, serializeSourcesRecord(RECORD));
  if (opts.provenance) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, PROVENANCE_ANTIGO);
    // mtime antigo e fixo: dá para ver se o arquivo foi tocado.
    utimesSync(outPath, new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
  }
  return { outPath, recordPath };
}

function run(
  paths: { outPath: string; recordPath: string },
  opts: { allowCacheFallback?: boolean; cache?: Record<string, CachedFile> } = {},
): {
  buildBody: ReturnType<typeof vi.fn>;
  result: ReturnType<typeof emitPartitionProvenance>;
  sourcesFor: ReturnType<typeof vi.fn>;
} {
  const allowCacheFallback = opts.allowCacheFallback ?? false;
  const cache = cacheOf(opts.cache ?? { 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': B });
  const sourcesFor = vi.fn((recordText: null | string) =>
    siaPaPartitionSources(cache, DIR, MG, recordText, { allowCacheFallback }),
  );
  const buildBody = vi.fn((sources: PartitionSources) =>
    Promise.resolve({ dataset: 'sia-pa', ...sources }),
  );
  const result = emitPartitionProvenance({
    allowCacheFallback,
    buildBody,
    outPath: paths.outPath,
    recordPath: paths.recordPath,
    sourcesFor,
  });
  return { buildBody, result, sourcesFor };
}

describe('emitPartitionProvenance', () => {
  it('sem registro e com provenance local: deixa o arquivo intacto (bytes e mtime) e informa "anterior ao registro"', async () => {
    const paths = setup({ provenance: true });
    const antes = statSync(paths.outPath).mtimeMs;

    const { buildBody, result, sourcesFor } = run(paths);

    expect(await result).toEqual({ kind: 'anterior-ao-registro' });
    expect(readFileSync(paths.outPath, 'utf8')).toBe(PROVENANCE_ANTIGO);
    expect(statSync(paths.outPath).mtimeMs).toBe(antes);
    // Nem escolhe DBCs nem lê o Parquet.
    expect(sourcesFor).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
  });

  it('sem registro e sem provenance local: falha e não cria arquivo', async () => {
    const paths = setup({});
    const { buildBody, result } = run(paths);

    const r = await result;
    expect(r.kind).toBe('falhou');
    expect(r.kind === 'falhou' && r.message).toMatch(
      /sem part\.sources\.json \(registro do archive\) para MG 2025-08/,
    );
    expect(existsSync(paths.outPath)).toBe(false);
    expect(buildBody).not.toHaveBeenCalled();
  });

  it('com registro: reescreve o provenance local a partir do registro', async () => {
    const paths = setup({ provenance: true, record: true });
    const { result } = run(paths);

    expect(await result).toEqual({ fromCache: false, kind: 'escrito' });
    const novo = JSON.parse(readFileSync(paths.outPath, 'utf8')) as {
      source: null;
      sources: Array<{ file: string }>;
    };
    expect(novo.source).toBeNull();
    expect(novo.sources.map((s) => s.file)).toEqual(['PAMG2508a.dbc', 'PAMG2508b.dbc']);
  });

  it('com registro e sem provenance local: cria o diretório e escreve', async () => {
    const paths = setup({ record: true });
    expect(await run(paths).result).toEqual({ fromCache: false, kind: 'escrito' });
    expect(existsSync(paths.outPath)).toBe(true);
  });

  it('com registro que não confere com o cache: falha e apaga o provenance local, que não descreve o Parquet novo', async () => {
    const paths = setup({ provenance: true, record: true });
    const { result } = run(paths, { cache: { 'PAMG2508a.dbc': A } });

    const r = await result;
    expect(r.kind === 'falhou' && r.message).toMatch(
      /PAMG2508b\.dbc está no registro do archive mas não no cache/,
    );
    expect(existsSync(paths.outPath)).toBe(false);
  });

  it('sem registro, com --allow-cache-fallback: regera o provenance local pelo cache', async () => {
    const paths = setup({ provenance: true });
    const { result } = run(paths, { allowCacheFallback: true });

    expect(await result).toEqual({ fromCache: true, kind: 'escrito' });
    expect(readFileSync(paths.outPath, 'utf8')).not.toBe(PROVENANCE_ANTIGO);
  });

  it('erro que não é de procedência sobe sem apagar nada', async () => {
    const paths = setup({ provenance: true, record: true });
    const r = emitPartitionProvenance({
      allowCacheFallback: false,
      buildBody: () => Promise.resolve({}),
      outPath: paths.outPath,
      recordPath: paths.recordPath,
      sourcesFor: () => {
        throw new TypeError('bug');
      },
    });
    await expect(r).rejects.toThrow(TypeError);
    expect(readFileSync(paths.outPath, 'utf8')).toBe(PROVENANCE_ANTIGO);
  });
});
