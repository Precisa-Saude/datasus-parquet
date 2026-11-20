import { describe, expect, it } from 'vitest';

import { resolvePartitionFiles } from '../lib/dbc-source.js';
import {
  buildProvenance,
  type CachedFile,
  EMPTY_SHA256,
  parseSourcesRecord,
  serializeProvenance,
  siaPaCandidateNames,
  siaPaPartitionSources,
  siaPaSourcesFromCache,
  type SourceCache,
  SourceProvenanceError,
  sourcesFromRecord,
} from '../lib/provenance.js';
import {
  buildSourcesRecord,
  type RecordedSource,
  serializeSourcesRecord,
  type SourcesRecord,
} from '../lib/sources-record.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';

const sha = (c: string): string => c.repeat(64);

/** Cache em memória: nome → conteúdo descrito (sem ler disco). */
function fakeCache(files: Record<string, CachedFile>): SourceCache & { reads: string[] } {
  const reads: string[] = [];
  return {
    read: (name) => {
      reads.push(name);
      const f = files[name];
      if (!f) throw new Error(`ENOENT: ${name}`);
      return f;
    },
    reads,
    size: (name) => files[name]?.bytes ?? null,
  };
}

const vazio = (mtime = '2026-09-30T22:02:05.930Z'): CachedFile => ({
  bytes: 0,
  mtime,
  sha256: EMPTY_SHA256,
});

describe('siaPaCandidateNames', () => {
  it('lista o canônico e as variantes `a`–`z`, nessa ordem', () => {
    expect(siaPaCandidateNames('MG', 2025, 8)).toEqual([
      'PAMG2508.dbc',
      ...[...'abcdefghijklmnopqrstuvwxyz'].map((l) => `PAMG2508${l}.dbc`),
    ]);
  });
});

/** Seis variantes, `a`–`f`, de SP 2026-08 (o `f` é hipotético; ver dbc-source.test.ts). */
const SEIS = [...'abcdef'].map((l, i) => ({
  bytes: 1000 + i,
  file: `PASP2608${l}.dbc`,
  mtime: `2026-11-19T10:0${i}:00.000Z`,
  sha256: sha(l),
}));
const SP_2608 = { ano: 2026, mes: 8, uf: 'SP' };
const cacheSeis = (): ReturnType<typeof fakeCache> =>
  fakeCache(
    Object.fromEntries(
      SEIS.map(({ bytes, file, mtime, sha256 }) => [file, { bytes, mtime, sha256 }]),
    ),
  );

describe('partição dividida em seis DBCs (`a`–`f`)', () => {
  it('listagem → registro do archive → provenance com os seis, em ordem', () => {
    // Listagem fora de ordem, como pode vir do FTP.
    const listing = new Map(
      SEIS.map((s) => [s.file, s.bytes]).reverse() as Array<[string, number]>,
    );
    const files = resolvePartitionFiles(listing, 'SP', 2026, 8);
    const record = buildSourcesRecord({
      cacheMtime: (name) => SEIS.find((s) => s.file === name)?.mtime ?? '',
      files,
      ftpBase: DIR,
      ftpMtimes: new Map(),
      partition: SP_2608,
    });
    expect(record.files.map((f) => f.file)).toEqual(SEIS.map((s) => s.file));

    const { fromCache, sources } = siaPaPartitionSources(
      cacheSeis(),
      DIR,
      SP_2608,
      serializeSourcesRecord(record),
      { allowCacheFallback: false },
    );
    expect(fromCache).toBe(false);
    const body = buildProvenance({
      ...baseInput,
      output: { ...baseInput.output, file: 'ano=2026/uf=SP/mes=08/part.parquet' },
      partition: SP_2608,
      sources,
    });
    const parsed = JSON.parse(serializeProvenance(body)) as {
      source: null;
      sources: Array<{ bytes: number; file: string; ftpPath: string; sha256: string }>;
    };
    expect(parsed.source).toBeNull();
    expect(parsed.sources).toEqual(
      SEIS.map((s) => ({
        bytes: s.bytes,
        file: s.file,
        ftpPath: `${DIR}/${s.file}`,
        mtime: s.mtime,
        sha256: s.sha256,
      })),
    );
  });

  it('registro com `f` antes de `e` é recusado, como qualquer ordem errada', () => {
    const foraDeOrdem = registro(
      SP_2608,
      [...SEIS.slice(0, 4), SEIS[5]!, SEIS[4]!].map((s) => ({
        bytes: s.bytes,
        cacheMtime: s.mtime,
        file: s.file,
      })),
    );
    expect(() =>
      siaPaPartitionSources(cacheSeis(), DIR, SP_2608, JSON.stringify(foraDeOrdem), {
        allowCacheFallback: false,
      }),
    ).toThrow(/não corresponde à regra do archive para SP 2026-08/);
  });

  it('sem registro, com o fallback, escolhe os seis do cache, em ordem', () => {
    const result = siaPaSourcesFromCache(cacheSeis(), DIR, 'SP', 2026, 8);
    expect('sources' in result && result.sources.map((s) => s.file)).toEqual(
      SEIS.map((s) => s.file),
    );
  });

  it('sem registro, com o fallback, lacuna antes de `f` (a–d, f sem e) falha', () => {
    const semE = fakeCache(
      Object.fromEntries(
        SEIS.filter((s) => !s.file.endsWith('e.dbc')).map(({ bytes, file, mtime, sha256 }) => [
          file,
          { bytes, mtime, sha256 },
        ]),
      ),
    );
    expect(() => siaPaSourcesFromCache(semE, DIR, 'SP', 2026, 8)).toThrow(
      /variantes não contíguas a partir de `a` no cache para SP 2026-08: .*PASP2608f\.dbc \(falta PASP2608e\.dbc\)/,
    );
  });
});

describe('siaPaSourcesFromCache', () => {
  it('partição dividida em três DBCs registra os três, em ordem, com bytes e SHA-256 de cada', () => {
    // Estado real do cache em MG 2025-08: canônico e `d` com 0 byte (sobras
    // das sondagens 550), `a`–`c` com os arquivos decodificados.
    const cache = fakeCache({
      'PAMG2508.dbc': vazio(),
      'PAMG2508a.dbc': { bytes: 166934835, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
      'PAMG2508b.dbc': { bytes: 213060888, mtime: '2026-09-30T22:03:10.000Z', sha256: sha('b') },
      'PAMG2508c.dbc': { bytes: 15204829, mtime: '2026-09-30T22:04:10.000Z', sha256: sha('c') },
      'PAMG2508d.dbc': vazio(),
    });

    expect(siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toEqual({
      source: null,
      sources: [
        {
          bytes: 166934835,
          file: 'PAMG2508a.dbc',
          ftpPath: `${DIR}/PAMG2508a.dbc`,
          mtime: '2026-09-30T22:02:10.000Z',
          sha256: sha('a'),
        },
        {
          bytes: 213060888,
          file: 'PAMG2508b.dbc',
          ftpPath: `${DIR}/PAMG2508b.dbc`,
          mtime: '2026-09-30T22:03:10.000Z',
          sha256: sha('b'),
        },
        {
          bytes: 15204829,
          file: 'PAMG2508c.dbc',
          ftpPath: `${DIR}/PAMG2508c.dbc`,
          mtime: '2026-09-30T22:04:10.000Z',
          sha256: sha('c'),
        },
      ],
    });
    expect(cache.reads).toEqual(['PAMG2508a.dbc', 'PAMG2508b.dbc', 'PAMG2508c.dbc']);
  });

  it('partição dividida em dois DBCs não registra nenhum arquivo de 0 byte nem hash de arquivo vazio', () => {
    const cache = fakeCache({
      'PARJ2401.dbc': vazio(),
      'PARJ2401a.dbc': { bytes: 10, mtime: '2026-05-01T00:00:00.000Z', sha256: sha('1') },
      'PARJ2401b.dbc': { bytes: 20, mtime: '2026-05-01T00:00:01.000Z', sha256: sha('2') },
      'PARJ2401c.dbc': vazio(),
    });

    const result = siaPaSourcesFromCache(cache, DIR, 'RJ', 2024, 1);
    const text = JSON.stringify(result);
    expect(text).not.toContain(EMPTY_SHA256);
    expect(text).not.toContain('"bytes":0');
    expect(result.source).toBeNull();
    expect('sources' in result && result.sources.map((s) => s.file)).toEqual([
      'PARJ2401a.dbc',
      'PARJ2401b.dbc',
    ]);
  });

  it('partição de arquivo único mantém só `source`, sem `sources`', () => {
    const cache = fakeCache({
      'PAAC2401.dbc': {
        bytes: 2767043,
        mtime: '2026-04-23T17:52:39.500Z',
        sha256: 'b1540eba00a1fa2c1dd1f6e2b26e502838f07f235428187f0cc55e181c36fbc7',
      },
    });

    const result = siaPaSourcesFromCache(cache, DIR, 'AC', 2024, 1);
    expect(result).toEqual({
      source: {
        bytes: 2767043,
        file: 'PAAC2401.dbc',
        ftpPath: `${DIR}/PAAC2401.dbc`,
        mtime: '2026-04-23T17:52:39.500Z',
        sha256: 'b1540eba00a1fa2c1dd1f6e2b26e502838f07f235428187f0cc55e181c36fbc7',
      },
    });
    expect(Object.keys(result)).toEqual(['source']);
  });

  it('prefere o canônico quando há canônico e variantes no cache, como o archive', () => {
    const cache = fakeCache({
      'PARR2508.dbc': { bytes: 986053, mtime: '2026-10-01T00:00:00.000Z', sha256: sha('f') },
      'PARR2508a.dbc': { bytes: 5, mtime: '2026-10-01T00:00:00.000Z', sha256: sha('e') },
    });

    const result = siaPaSourcesFromCache(cache, DIR, 'RR', 2025, 8);
    expect(Object.keys(result)).toEqual(['source']);
    expect(result.source?.file).toBe('PARR2508.dbc');
  });

  it('falha quando nenhum DBC da partição está em cache, em vez de escrever bytes: 0', () => {
    expect(() => siaPaSourcesFromCache(fakeCache({}), DIR, 'AC', 2024, 1)).toThrow(
      SourceProvenanceError,
    );
    expect(() => siaPaSourcesFromCache(fakeCache({}), DIR, 'AC', 2024, 1)).toThrow(
      /nenhum DBC-fonte em cache para AC 2024-01/,
    );
  });

  it('falha quando só há arquivos de 0 byte e nomeia os que foram ignorados', () => {
    const cache = fakeCache({ 'PAMG2508.dbc': vazio(), 'PAMG2508d.dbc': vazio() });
    expect(() => siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toThrow(
      /0 byte ignorados: PAMG2508\.dbc, PAMG2508d\.dbc/,
    );
  });

  it('falha quando o arquivo some ou não pode ser lido para calcular o hash', () => {
    const cache: SourceCache = {
      read: () => {
        throw new Error('EACCES: permission denied');
      },
      size: () => 10,
    };
    expect(() => siaPaSourcesFromCache(cache, DIR, 'AC', 2024, 1)).toThrow(
      /não foi possível ler PAAC2401\.dbc.*EACCES/,
    );
  });

  it('falha também quando a leitura lança algo que não é Error', () => {
    const cache: SourceCache = {
      read: () => {
        // Simula biblioteca que lança string em vez de Error.
        const naoErro: unknown = 'disco desmontado';
        throw naoErro;
      },
      size: () => 10,
    };
    expect(() => siaPaSourcesFromCache(cache, DIR, 'AC', 2024, 1)).toThrow(
      /não foi possível ler PAAC2401\.dbc no cache: disco desmontado/,
    );
  });

  it('falha quando o arquivo muda de tamanho entre a listagem e a leitura', () => {
    const cache: SourceCache = {
      read: () => ({ bytes: 7, mtime: '2026-01-01T00:00:00.000Z', sha256: sha('a') }),
      size: () => 10,
    };
    expect(() => siaPaSourcesFromCache(cache, DIR, 'AC', 2024, 1)).toThrow(
      /PAAC2401\.dbc mudou de tamanho no cache: 10 bytes listados, 7 lidos/,
    );
  });

  it('falha quando o hash lido é o de arquivo vazio ou não é um SHA-256', () => {
    const comHash = (sha256: string): SourceCache => ({
      read: () => ({ bytes: 10, mtime: '2026-01-01T00:00:00.000Z', sha256 }),
      size: () => 10,
    });
    expect(() => siaPaSourcesFromCache(comHash(EMPTY_SHA256), DIR, 'AC', 2024, 1)).toThrow(
      /SHA-256 inválido para PAAC2401\.dbc/,
    );
    expect(() => siaPaSourcesFromCache(comHash(''), DIR, 'AC', 2024, 1)).toThrow(
      SourceProvenanceError,
    );
  });

  it('falha quando o mtime lido está vazio', () => {
    const cache: SourceCache = {
      read: () => ({ bytes: 10, mtime: '', sha256: sha('a') }),
      size: () => 10,
    };
    expect(() => siaPaSourcesFromCache(cache, DIR, 'AC', 2024, 1)).toThrow(
      /mtime ausente para PAAC2401\.dbc/,
    );
  });

  it('aceita variantes contíguas a partir de `a` (a, b)', () => {
    const cache = fakeCache({
      'PAMG2508a.dbc': { bytes: 1, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
      'PAMG2508b.dbc': { bytes: 2, mtime: '2026-09-30T22:03:10.000Z', sha256: sha('b') },
    });
    const result = siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8);
    expect('sources' in result && result.sources.map((s) => s.file)).toEqual([
      'PAMG2508a.dbc',
      'PAMG2508b.dbc',
    ]);
  });

  it('falha com lacuna entre as variantes no cache (a, c sem b)', () => {
    const cache = fakeCache({
      'PAMG2508a.dbc': { bytes: 1, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
      'PAMG2508c.dbc': { bytes: 3, mtime: '2026-09-30T22:04:10.000Z', sha256: sha('c') },
    });
    expect(() => siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toThrow(SourceProvenanceError);
    expect(() => siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toThrow(
      /variantes não contíguas a partir de `a` no cache para MG 2025-08: PAMG2508a\.dbc, PAMG2508c\.dbc \(falta PAMG2508b\.dbc\)/,
    );
    expect(cache.reads).toEqual([]);
  });

  it('falha quando as variantes não começam em `a` (b, c sem a)', () => {
    const cache = fakeCache({
      'PAMG2508b.dbc': { bytes: 2, mtime: '2026-09-30T22:03:10.000Z', sha256: sha('b') },
      'PAMG2508c.dbc': { bytes: 3, mtime: '2026-09-30T22:04:10.000Z', sha256: sha('c') },
    });
    expect(() => siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toThrow(
      /não contíguas.*\(falta PAMG2508a\.dbc\)/,
    );
  });

  it('variante de 0 byte no meio conta como lacuna (a, b vazio, c)', () => {
    const cache = fakeCache({
      'PAMG2508a.dbc': { bytes: 1, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
      'PAMG2508b.dbc': vazio(),
      'PAMG2508c.dbc': { bytes: 3, mtime: '2026-09-30T22:04:10.000Z', sha256: sha('c') },
    });
    expect(() => siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toThrow(/falta PAMG2508b\.dbc/);
  });

  it('falha com variante única sem o canônico (só `a` no cache)', () => {
    const cache = fakeCache({
      'PAMG2508.dbc': vazio(),
      'PAMG2508a.dbc': { bytes: 1, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
    });
    expect(() => siaPaSourcesFromCache(cache, DIR, 'MG', 2025, 8)).toThrow(
      /só PAMG2508a\.dbc no cache para MG 2025-08, sem o canônico PAMG2508\.dbc/,
    );
    expect(cache.reads).toEqual([]);
  });
});

/** Registro do archive (`part.sources.json`) como o archive o escreveria. */
function registro(
  partition: { ano: number; mes: number; uf: string },
  files: Array<Pick<RecordedSource, 'bytes' | 'cacheMtime' | 'file'>>,
): SourcesRecord {
  return {
    files: files.map((f) => ({
      ...f,
      ftpMtime: '2026-09-30T21:51:00.000Z',
      ftpPath: `${DIR}/${f.file}`,
    })),
    partition,
    version: 1,
  };
}

const MG = { ano: 2025, mes: 8, uf: 'MG' };
const A = { bytes: 166934835, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') };
const B = { bytes: 213060888, mtime: '2026-09-30T22:03:10.000Z', sha256: sha('b') };
const C = { bytes: 15204829, mtime: '2026-09-30T22:04:10.000Z', sha256: sha('c') };
const REGISTRO_MG_ABC = registro(MG, [
  { bytes: A.bytes, cacheMtime: A.mtime, file: 'PAMG2508a.dbc' },
  { bytes: B.bytes, cacheMtime: B.mtime, file: 'PAMG2508b.dbc' },
  { bytes: C.bytes, cacheMtime: C.mtime, file: 'PAMG2508c.dbc' },
]);

describe('sourcesFromRecord', () => {
  it('lista em `sources` exatamente os arquivos do registro, na ordem dele, com o hash lido do cache', () => {
    const cache = fakeCache({
      'PAMG2508.dbc': vazio(),
      'PAMG2508a.dbc': A,
      'PAMG2508b.dbc': B,
      'PAMG2508c.dbc': C,
    });
    expect(sourcesFromRecord(cache, REGISTRO_MG_ABC)).toEqual({
      source: null,
      sources: [
        {
          bytes: A.bytes,
          file: 'PAMG2508a.dbc',
          ftpPath: `${DIR}/PAMG2508a.dbc`,
          mtime: A.mtime,
          sha256: sha('a'),
        },
        {
          bytes: B.bytes,
          file: 'PAMG2508b.dbc',
          ftpPath: `${DIR}/PAMG2508b.dbc`,
          mtime: B.mtime,
          sha256: sha('b'),
        },
        {
          bytes: C.bytes,
          file: 'PAMG2508c.dbc',
          ftpPath: `${DIR}/PAMG2508c.dbc`,
          mtime: C.mtime,
          sha256: sha('c'),
        },
      ],
    });
    expect(cache.reads).toEqual(['PAMG2508a.dbc', 'PAMG2508b.dbc', 'PAMG2508c.dbc']);
  });

  it('falha nomeando o arquivo do registro que não está no cache (a, b em cache, c registrado e ausente)', () => {
    // Cenário da revisão do #65: só `a` e `b` no cache. Escolhendo pelo cache,
    // o provenance sairia com dois arquivos para um Parquet feito de três.
    const cache = fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': B });
    expect(() => sourcesFromRecord(cache, REGISTRO_MG_ABC)).toThrow(SourceProvenanceError);
    expect(() => sourcesFromRecord(cache, REGISTRO_MG_ABC)).toThrow(
      /PAMG2508c\.dbc está no registro do archive mas não no cache/,
    );
  });

  it('falha quando o tamanho no cache difere do registrado pelo archive', () => {
    const cache = fakeCache({
      'PAMG2508a.dbc': A,
      'PAMG2508b.dbc': { ...B, bytes: B.bytes - 1 },
      'PAMG2508c.dbc': C,
    });
    expect(() => sourcesFromRecord(cache, REGISTRO_MG_ABC)).toThrow(
      /PAMG2508b\.dbc tem 213060887 bytes no cache, 213060888 no registro do archive/,
    );
  });

  it('falha quando o arquivo registrado está com 0 byte no cache', () => {
    const cache = fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': vazio(), 'PAMG2508c.dbc': C });
    expect(() => sourcesFromRecord(cache, REGISTRO_MG_ABC)).toThrow(
      /PAMG2508b\.dbc tem 0 byte no cache/,
    );
  });

  it('falha quando o arquivo foi baixado de novo depois do archive (mtime do cache mudou)', () => {
    const cache = fakeCache({
      'PAMG2508a.dbc': A,
      'PAMG2508b.dbc': { ...B, mtime: '2026-10-07T03:00:00.000Z' },
      'PAMG2508c.dbc': C,
    });
    expect(() => sourcesFromRecord(cache, REGISTRO_MG_ABC)).toThrow(
      /mtime de PAMG2508b\.dbc no cache \(2026-10-07T03:00:00\.000Z\) difere do registrado pelo archive \(2026-09-30T22:03:10\.000Z\)/,
    );
  });

  it('ignora variante a mais no cache que não está no registro', () => {
    const registroAB = registro(MG, [
      { bytes: A.bytes, cacheMtime: A.mtime, file: 'PAMG2508a.dbc' },
      { bytes: B.bytes, cacheMtime: B.mtime, file: 'PAMG2508b.dbc' },
    ]);
    const cache = fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': B, 'PAMG2508c.dbc': C });
    const result = sourcesFromRecord(cache, registroAB);
    expect('sources' in result && result.sources.map((s) => s.file)).toEqual([
      'PAMG2508a.dbc',
      'PAMG2508b.dbc',
    ]);
    expect(cache.reads).toEqual(['PAMG2508a.dbc', 'PAMG2508b.dbc']);
  });

  it('registro de um arquivo só dá só `source`', () => {
    const cache = fakeCache({ 'PAMG2508a.dbc': A });
    const result = sourcesFromRecord(
      cache,
      registro(MG, [{ bytes: A.bytes, cacheMtime: A.mtime, file: 'PAMG2508a.dbc' }]),
    );
    expect(Object.keys(result)).toEqual(['source']);
  });
});

describe('parseSourcesRecord', () => {
  const texto = (r: unknown): string => JSON.stringify(r);

  it('lê o registro que o archive escreveu para a mesma partição', () => {
    expect(parseSourcesRecord(texto(REGISTRO_MG_ABC), MG)).toEqual(REGISTRO_MG_ABC);
  });

  it('falha com JSON inválido', () => {
    expect(() => parseSourcesRecord('{', MG)).toThrow(/part\.sources\.json inválido: não é JSON/);
  });

  it('falha com versão desconhecida ou corpo que não é objeto', () => {
    expect(() => parseSourcesRecord(texto({ ...REGISTRO_MG_ABC, version: 2 }), MG)).toThrow(
      /part\.sources\.json inválido: versão/,
    );
    expect(() => parseSourcesRecord('null', MG)).toThrow(/part\.sources\.json inválido: versão/);
  });

  it('falha quando o registro é de outra partição', () => {
    expect(() =>
      parseSourcesRecord(texto(REGISTRO_MG_ABC), { ano: 2025, mes: 9, uf: 'MG' }),
    ).toThrow(/registro do archive é de MG 2025-08, não de MG 2025-09/);
    expect(() => parseSourcesRecord(texto({ ...REGISTRO_MG_ABC, partition: null }), MG)).toThrow(
      /part\.sources\.json inválido: `partition`/,
    );
  });

  it('falha quando `files` está vazio ou não é lista', () => {
    expect(() => parseSourcesRecord(texto({ ...REGISTRO_MG_ABC, files: [] }), MG)).toThrow(
      /part\.sources\.json inválido: `files` vazio/,
    );
    expect(() => parseSourcesRecord(texto({ ...REGISTRO_MG_ABC, files: {} }), MG)).toThrow(
      /part\.sources\.json inválido: `files` vazio/,
    );
  });

  const [primeiro] = REGISTRO_MG_ABC.files;
  it.each([
    ['item nulo', null],
    ['file ausente', { ...primeiro, file: undefined }],
    ['ftpPath que não termina no nome', { ...primeiro, ftpPath: `${DIR}/outro.dbc` }],
    ['bytes zero', { ...primeiro, bytes: 0 }],
    ['bytes não inteiro', { ...primeiro, bytes: 1.5 }],
    ['cacheMtime vazio', { ...primeiro, cacheMtime: '' }],
    ['ftpMtime numérico', { ...primeiro, ftpMtime: 5 }],
  ])('falha com item de `files` inválido: %s', (_caso, item) => {
    expect(() => parseSourcesRecord(texto({ ...REGISTRO_MG_ABC, files: [item] }), MG)).toThrow(
      /part\.sources\.json inválido: item 0 de `files`/,
    );
  });

  it('aceita ftpMtime nulo (listagem sem mtime legível)', () => {
    const r = { ...REGISTRO_MG_ABC, files: [{ ...primeiro, ftpMtime: null }] };
    expect(parseSourcesRecord(texto(r), MG).files[0]?.ftpMtime).toBeNull();
  });
});

describe('siaPaPartitionSources', () => {
  const cacheABC = (): ReturnType<typeof fakeCache> =>
    fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': B, 'PAMG2508c.dbc': C });

  it('com registro, usa o registro e não o cache', () => {
    const cache = fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': B });
    // Com o fallback ligado ainda vale o registro: ele só se aplica a quem não tem.
    expect(() =>
      siaPaPartitionSources(cache, DIR, MG, JSON.stringify(REGISTRO_MG_ABC), {
        allowCacheFallback: true,
      }),
    ).toThrow(/PAMG2508c\.dbc está no registro do archive mas não no cache/);

    const ok = siaPaPartitionSources(cacheABC(), DIR, MG, JSON.stringify(REGISTRO_MG_ABC), {
      allowCacheFallback: false,
    });
    expect(ok.fromCache).toBe(false);
    expect('sources' in ok.sources && ok.sources.sources).toHaveLength(3);
  });

  it('falha quando o registro não segue a regra do archive para a partição', () => {
    // `c` antes de `a`: não é a ordem em que o archive decodifica.
    const foraDeOrdem = { ...REGISTRO_MG_ABC, files: [...REGISTRO_MG_ABC.files].reverse() };
    expect(() =>
      siaPaPartitionSources(cacheABC(), DIR, MG, JSON.stringify(foraDeOrdem), {
        allowCacheFallback: false,
      }),
    ).toThrow(
      /registro do archive não corresponde à regra do archive para MG 2025-08: PAMG2508c\.dbc, PAMG2508b\.dbc, PAMG2508a\.dbc/,
    );
    // Arquivo de outra partição.
    const outro = registro(MG, [{ bytes: 1, cacheMtime: A.mtime, file: 'PAMG2509a.dbc' }]);
    expect(() =>
      siaPaPartitionSources(cacheABC(), DIR, MG, JSON.stringify(outro), {
        allowCacheFallback: false,
      }),
    ).toThrow(/não corresponde à regra do archive/);
    // Mesmos nomes, outro diretório do FTP: o `ftpPath` publicado estaria errado.
    const outroDir = {
      ...REGISTRO_MG_ABC,
      files: REGISTRO_MG_ABC.files.map((f) => ({ ...f, ftpPath: `/outro/${f.file}` })),
    };
    expect(() =>
      siaPaPartitionSources(cacheABC(), DIR, MG, JSON.stringify(outroDir), {
        allowCacheFallback: false,
      }),
    ).toThrow(/não corresponde à regra do archive/);
  });

  it('sem registro e sem o fallback, falha nomeando a partição', () => {
    expect(() =>
      siaPaPartitionSources(cacheABC(), DIR, MG, null, { allowCacheFallback: false }),
    ).toThrow(SourceProvenanceError);
    expect(() =>
      siaPaPartitionSources(cacheABC(), DIR, MG, null, { allowCacheFallback: false }),
    ).toThrow(
      /sem part\.sources\.json \(registro do archive\) para MG 2025-08.*--allow-cache-fallback/,
    );
  });

  it('sem registro e com o fallback, escolhe pelo cache e marca a origem', () => {
    const result = siaPaPartitionSources(
      fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508b.dbc': B }),
      DIR,
      MG,
      null,
      { allowCacheFallback: true },
    );
    expect(result.fromCache).toBe(true);
    expect('sources' in result.sources && result.sources.sources.map((s) => s.file)).toEqual([
      'PAMG2508a.dbc',
      'PAMG2508b.dbc',
    ]);
    expect(() =>
      siaPaPartitionSources(fakeCache({ 'PAMG2508a.dbc': A, 'PAMG2508c.dbc': C }), DIR, MG, null, {
        allowCacheFallback: true,
      }),
    ).toThrow(/não contíguas/);
    expect(() =>
      siaPaPartitionSources(fakeCache({ 'PAMG2508a.dbc': A }), DIR, MG, null, {
        allowCacheFallback: true,
      }),
    ).toThrow(/sem o canônico/);
  });
});

/**
 * Saída real do `emit-provenance` antes desta mudança (origin/main
 * 767808b), para AC 2024-01 com o `PAAC2401.dbc` do cache local. A
 * partição de arquivo único tem de continuar saindo byte-a-byte igual.
 */
const PROVENANCE_ARQUIVO_UNICO_ANTES = `{
  "dataset": "sia-pa",
  "generatedAt": "2026-11-19T20:24:41.059Z",
  "output": {
    "columns": 5,
    "file": "ano=2024/uf=AC/mes=01/part.parquet",
    "fingerprint": "v1:5:1DC05102C17B0D44F:EDAC004461FD6683",
    "rows": 5,
    "schema": [
      {
        "name": "PA_N",
        "type": "BIGINT"
      },
      {
        "name": "PA_CODUNI",
        "type": "VARCHAR"
      },
      {
        "name": "ano",
        "type": "BIGINT"
      },
      {
        "name": "mes",
        "type": "VARCHAR"
      },
      {
        "name": "uf",
        "type": "VARCHAR"
      }
    ],
    "sha256": "1b3f5175efdb61048dc461ab7914ec40fb3cf878d0f72453ecf394127e56021b"
  },
  "partition": {
    "ano": 2024,
    "mes": 1,
    "uf": "AC"
  },
  "pipeline": {
    "archiveScript": "scripts/archive-sia-pa.ts@767808b94ad7ea87ae2551e84c3c19aa79d82bd0",
    "datasusSdk": "@precisa-saude/datasus@unknown",
    "decoder": "@precisa-saude/datasus-dbc@2.0.4",
    "notes": "Conversão 1:1 DBC→Parquet, sem filtro, sem enriquecimento."
  },
  "source": {
    "bytes": 2767043,
    "file": "PAAC2401.dbc",
    "ftpPath": "/dissemin/publicos/SIASUS/200801_/Dados/PAAC2401.dbc",
    "mtime": "2026-04-23T17:52:39.500Z",
    "sha256": "b1540eba00a1fa2c1dd1f6e2b26e502838f07f235428187f0cc55e181c36fbc7"
  }
}
`;

const baseInput = {
  dataset: 'sia-pa',
  generatedAt: '2026-11-19T20:24:41.059Z',
  output: {
    file: 'ano=2024/uf=AC/mes=01/part.parquet',
    fingerprint: 'v1:5:1DC05102C17B0D44F:EDAC004461FD6683',
    rows: 5,
    schema: [
      { name: 'PA_N', type: 'BIGINT' },
      { name: 'PA_CODUNI', type: 'VARCHAR' },
      { name: 'ano', type: 'BIGINT' },
      { name: 'mes', type: 'VARCHAR' },
      { name: 'uf', type: 'VARCHAR' },
    ],
    sha256: '1b3f5175efdb61048dc461ab7914ec40fb3cf878d0f72453ecf394127e56021b',
  },
  partition: { ano: 2024, mes: 1, uf: 'AC' },
  pipeline: {
    archiveScript: 'scripts/archive-sia-pa.ts@767808b94ad7ea87ae2551e84c3c19aa79d82bd0',
    datasusSdk: '@precisa-saude/datasus@unknown',
    decoder: '@precisa-saude/datasus-dbc@2.0.4',
  },
};

const PAAC2401: CachedFile = {
  bytes: 2767043,
  mtime: '2026-04-23T17:52:39.500Z',
  sha256: 'b1540eba00a1fa2c1dd1f6e2b26e502838f07f235428187f0cc55e181c36fbc7',
};

describe('buildProvenance + serializeProvenance', () => {
  it('partição de arquivo único com registro do archive sai byte-a-byte igual à de antes da mudança', () => {
    const record = registro(baseInput.partition, [
      { bytes: PAAC2401.bytes, cacheMtime: PAAC2401.mtime, file: 'PAAC2401.dbc' },
    ]);
    const { fromCache, sources } = siaPaPartitionSources(
      fakeCache({ 'PAAC2401.dbc': PAAC2401 }),
      DIR,
      baseInput.partition,
      JSON.stringify(record),
      { allowCacheFallback: false },
    );
    expect(fromCache).toBe(false);
    expect(serializeProvenance(buildProvenance({ ...baseInput, sources }))).toBe(
      PROVENANCE_ARQUIVO_UNICO_ANTES,
    );
  });

  it('partição de arquivo único sem registro, com o fallback (só o canônico no cache), também sai igual', () => {
    const { fromCache, sources } = siaPaPartitionSources(
      fakeCache({ 'PAAC2401.dbc': PAAC2401 }),
      DIR,
      baseInput.partition,
      null,
      { allowCacheFallback: true },
    );
    expect(fromCache).toBe(true);
    expect(serializeProvenance(buildProvenance({ ...baseInput, sources }))).toBe(
      PROVENANCE_ARQUIVO_UNICO_ANTES,
    );
  });

  it('partição dividida: `source` nulo seguido de `sources`, depois de `pipeline`', () => {
    const sources = sourcesFromRecord(
      fakeCache({
        'PAMG2508.dbc': vazio(),
        'PAMG2508a.dbc': { bytes: 1, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
        'PAMG2508b.dbc': { bytes: 2, mtime: '2026-09-30T22:03:10.000Z', sha256: sha('b') },
      }),
      registro(MG, [
        { bytes: 1, cacheMtime: '2026-09-30T22:02:10.000Z', file: 'PAMG2508a.dbc' },
        { bytes: 2, cacheMtime: '2026-09-30T22:03:10.000Z', file: 'PAMG2508b.dbc' },
      ]),
    );
    const body = buildProvenance({
      ...baseInput,
      output: { ...baseInput.output, file: 'ano=2025/uf=MG/mes=08/part.parquet' },
      partition: { ano: 2025, mes: 8, uf: 'MG' },
      sources,
    });
    expect(Object.keys(body)).toEqual([
      'dataset',
      'generatedAt',
      'output',
      'partition',
      'pipeline',
      'source',
      'sources',
    ]);
    const parsed = JSON.parse(serializeProvenance(body)) as {
      source: null;
      sources: Array<{ bytes: number; file: string; sha256: string }>;
    };
    expect(parsed.source).toBeNull();
    expect(parsed.sources.map((s) => [s.file, s.bytes, s.sha256])).toEqual([
      ['PAMG2508a.dbc', 1, sha('a')],
      ['PAMG2508b.dbc', 2, sha('b')],
    ]);
  });
});
