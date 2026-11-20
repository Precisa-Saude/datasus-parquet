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

import {
  assessKeptProvenance,
  emitPartitionProvenance,
  isLegacyProvenanceSource,
} from '../lib/emit-partition.js';
import {
  type CachedFile,
  EMPTY_SHA256,
  type PartitionSources,
  siaPaPartitionSources,
  type SourceCache,
} from '../lib/provenance.js';
import { serializeSourcesRecord, type SourcesRecord } from '../lib/sources-record.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const MG = { ano: 2025, mes: 8, uf: 'MG' };
const A: CachedFile = { bytes: 10, mtime: '2026-09-30T22:02:10.000Z', sha256: 'a'.repeat(64) };
const B: CachedFile = { bytes: 20, mtime: '2026-09-30T22:03:10.000Z', sha256: 'b'.repeat(64) };

/** SHA-256 do `part.parquet` local nos testes. */
const PARQUET_SHA = 'f'.repeat(64);

function provenanceJson(outputSha: string, source: unknown): string {
  return `${JSON.stringify({ dataset: 'sia-pa', output: { sha256: outputSha }, source }, null, 2)}\n`;
}

/** Provenance de antes do registro, de partição de DBC único, que confere com o Parquet. */
const PROVENANCE_ANTIGO = provenanceJson(PARQUET_SHA, {
  bytes: 2767043,
  file: 'PAAC2401.dbc',
  sha256: 'b'.repeat(64),
});

/** Formato inválido de antes de 19/11/2026 em partição dividida: canônico de 0 byte. */
const PROVENANCE_LEGADO = provenanceJson(PARQUET_SHA, {
  bytes: 0,
  file: 'PAMG2508.dbc',
  sha256: EMPTY_SHA256,
});

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
function setup(opts: { provenance?: string; record?: boolean }): {
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
  if (opts.provenance !== undefined) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, opts.provenance);
    // mtime antigo e fixo: dá para ver se o arquivo foi tocado.
    utimesSync(outPath, new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
  }
  return { outPath, recordPath };
}

function run(
  paths: { outPath: string; recordPath: string },
  opts: {
    allowCacheFallback?: boolean;
    cache?: Record<string, CachedFile>;
    parquetIlegivel?: boolean;
  } = {},
): {
  buildBody: ReturnType<typeof vi.fn>;
  parquetSha256: ReturnType<typeof vi.fn>;
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
  const parquetSha256 = vi.fn(() => {
    // Valor que não é Error, como um erro nativo repassado sem embrulho.
    // eslint-disable-next-line no-throw-literal
    if (opts.parquetIlegivel) throw 'EACCES: part.parquet';
    return PARQUET_SHA;
  });
  const result = emitPartitionProvenance({
    allowCacheFallback,
    buildBody,
    outPath: paths.outPath,
    parquetSha256,
    recordPath: paths.recordPath,
    sourcesFor,
  });
  return { buildBody, parquetSha256, result, sourcesFor };
}

describe('emitPartitionProvenance', () => {
  it('sem registro e com provenance local cujo output.sha256 confere com o Parquet: deixa o arquivo intacto (bytes e mtime) e informa "anterior ao registro"', async () => {
    const paths = setup({ provenance: PROVENANCE_ANTIGO });
    const antes = statSync(paths.outPath).mtimeMs;

    const { buildBody, parquetSha256, result, sourcesFor } = run(paths);

    expect(await result).toEqual({ kind: 'anterior-ao-registro', legacy: false });
    expect(readFileSync(paths.outPath, 'utf8')).toBe(PROVENANCE_ANTIGO);
    expect(statSync(paths.outPath).mtimeMs).toBe(antes);
    expect(parquetSha256).toHaveBeenCalledOnce();
    // Não escolhe DBCs nem monta corpo novo.
    expect(sourcesFor).not.toHaveBeenCalled();
    expect(buildBody).not.toHaveBeenCalled();
  });

  it('sem registro e com provenance local que não confere com o Parquet: trata como obsoleto, falha e apaga', async () => {
    const paths = setup({ provenance: provenanceJson('e'.repeat(64), { bytes: 1 }) });
    const r = await run(paths).result;

    expect(r.kind).toBe('falhou');
    expect(r.kind === 'falhou' && r.message).toMatch(
      /provenance local sem part\.sources\.json não descreve o Parquet atual: output\.sha256 eeee.*, Parquet ffff/,
    );
    expect(existsSync(paths.outPath)).toBe(false);
  });

  it('sem registro e com provenance local ilegível: trata como obsoleto, falha e apaga', async () => {
    const paths = setup({ provenance: '{' });
    const r = await run(paths).result;

    expect(r.kind === 'falhou' && r.message).toMatch(/não é JSON/);
    expect(existsSync(paths.outPath)).toBe(false);
  });

  it('sem registro e com provenance local, mas Parquet ilegível: trata como obsoleto, falha e apaga', async () => {
    const paths = setup({ provenance: PROVENANCE_ANTIGO });
    const r = await run(paths, { parquetIlegivel: true }).result;

    expect(r.kind === 'falhou' && r.message).toMatch(/ilegível \(EACCES: part\.parquet\)/);
    expect(existsSync(paths.outPath)).toBe(false);
  });

  it('sem registro e com provenance local no formato inválido de antes de 19/11 que confere com o Parquet: mantém e marca como legado', async () => {
    const paths = setup({ provenance: PROVENANCE_LEGADO });
    const { result } = run(paths);

    expect(await result).toEqual({ kind: 'anterior-ao-registro', legacy: true });
    expect(readFileSync(paths.outPath, 'utf8')).toBe(PROVENANCE_LEGADO);
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
    const paths = setup({ provenance: PROVENANCE_ANTIGO, record: true });
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
    const paths = setup({ provenance: PROVENANCE_ANTIGO, record: true });
    const { result } = run(paths, { cache: { 'PAMG2508a.dbc': A } });

    const r = await result;
    expect(r.kind === 'falhou' && r.message).toMatch(
      /PAMG2508b\.dbc está no registro do archive mas não no cache/,
    );
    expect(existsSync(paths.outPath)).toBe(false);
  });

  it('sem registro, com --allow-cache-fallback: regera o provenance local pelo cache', async () => {
    const paths = setup({ provenance: PROVENANCE_ANTIGO });
    const { result } = run(paths, { allowCacheFallback: true });

    expect(await result).toEqual({ fromCache: true, kind: 'escrito' });
    expect(readFileSync(paths.outPath, 'utf8')).not.toBe(PROVENANCE_ANTIGO);
  });

  it('erro que não é de procedência sobe sem apagar nada', async () => {
    const paths = setup({ provenance: PROVENANCE_ANTIGO, record: true });
    const r = emitPartitionProvenance({
      allowCacheFallback: false,
      buildBody: () => Promise.resolve({}),
      outPath: paths.outPath,
      parquetSha256: () => PARQUET_SHA,
      recordPath: paths.recordPath,
      sourcesFor: () => {
        throw new TypeError('bug');
      },
    });
    await expect(r).rejects.toThrow(TypeError);
    expect(readFileSync(paths.outPath, 'utf8')).toBe(PROVENANCE_ANTIGO);
  });
});

describe('assessKeptProvenance', () => {
  it.each([
    ['não é JSON', '{', /não é JSON/],
    ['JSON que não é objeto', 'null', /sem output\.sha256/],
    ['sem output', JSON.stringify({ source: { bytes: 1 } }), /sem output\.sha256/],
    ['output.sha256 não é texto', JSON.stringify({ output: { sha256: 5 } }), /sem output\.sha256/],
  ])('rejeita provenance local %s', (_caso, text, motivo) => {
    const r = assessKeptProvenance(text, PARQUET_SHA);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(motivo);
  });

  const valido = { bytes: 10, file: 'PAAC2401.dbc', sha256: 'b'.repeat(64) };
  it.each([
    ['source válido', valido, false],
    ['source nulo com sources (formato atual de partição dividida)', null, false],
    ['source com 0 byte', { ...valido, bytes: 0 }, true],
    ['source com hash vazio', { ...valido, sha256: '' }, true],
    ['source com hash de arquivo vazio', { ...valido, sha256: EMPTY_SHA256 }, true],
    ['source com hash que não é SHA-256', { ...valido, sha256: 'xyz' }, true],
    ['source ausente', undefined, true],
  ])('classifica %s', (_caso, source, legacy) => {
    expect(assessKeptProvenance(provenanceJson(PARQUET_SHA, source), PARQUET_SHA)).toEqual({
      legacy,
      ok: true,
    });
  });
});

describe('isLegacyProvenanceSource', () => {
  it('é o mesmo critério do provenance mantido: `source` de 0 byte, sem SHA-256 válido ou de arquivo vazio', () => {
    const valido = { bytes: 10, file: 'PAAC2401.dbc', sha256: 'b'.repeat(64) };
    expect(isLegacyProvenanceSource(valido)).toBe(false);
    expect(isLegacyProvenanceSource(null)).toBe(false);
    expect(isLegacyProvenanceSource({ ...valido, bytes: 0 })).toBe(true);
    expect(isLegacyProvenanceSource({ ...valido, sha256: '' })).toBe(true);
    expect(isLegacyProvenanceSource({ ...valido, sha256: EMPTY_SHA256 })).toBe(true);
    expect(isLegacyProvenanceSource(undefined)).toBe(true);
  });
});
