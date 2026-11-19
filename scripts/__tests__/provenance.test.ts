import { describe, expect, it } from 'vitest';

import {
  buildProvenance,
  type CachedFile,
  EMPTY_SHA256,
  serializeProvenance,
  siaPaCandidateNames,
  siaPaPartitionSources,
  type SourceCache,
  SourceProvenanceError,
} from '../lib/provenance.js';

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
  it('lista o canônico e as variantes a–e, nessa ordem', () => {
    expect(siaPaCandidateNames('MG', 2025, 8)).toEqual([
      'PAMG2508.dbc',
      'PAMG2508a.dbc',
      'PAMG2508b.dbc',
      'PAMG2508c.dbc',
      'PAMG2508d.dbc',
      'PAMG2508e.dbc',
    ]);
  });
});

describe('siaPaPartitionSources', () => {
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

    expect(siaPaPartitionSources(cache, DIR, 'MG', 2025, 8)).toEqual({
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

    const result = siaPaPartitionSources(cache, DIR, 'RJ', 2024, 1);
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

    const result = siaPaPartitionSources(cache, DIR, 'AC', 2024, 1);
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

    const result = siaPaPartitionSources(cache, DIR, 'RR', 2025, 8);
    expect(Object.keys(result)).toEqual(['source']);
    expect(result.source?.file).toBe('PARR2508.dbc');
  });

  it('falha quando nenhum DBC da partição está em cache, em vez de escrever bytes: 0', () => {
    expect(() => siaPaPartitionSources(fakeCache({}), DIR, 'AC', 2024, 1)).toThrow(
      SourceProvenanceError,
    );
    expect(() => siaPaPartitionSources(fakeCache({}), DIR, 'AC', 2024, 1)).toThrow(
      /nenhum DBC-fonte em cache para AC 2024-01/,
    );
  });

  it('falha quando só há arquivos de 0 byte e nomeia os que foram ignorados', () => {
    const cache = fakeCache({ 'PAMG2508.dbc': vazio(), 'PAMG2508d.dbc': vazio() });
    expect(() => siaPaPartitionSources(cache, DIR, 'MG', 2025, 8)).toThrow(
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
    expect(() => siaPaPartitionSources(cache, DIR, 'AC', 2024, 1)).toThrow(
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
    expect(() => siaPaPartitionSources(cache, DIR, 'AC', 2024, 1)).toThrow(
      /não foi possível ler PAAC2401\.dbc no cache: disco desmontado/,
    );
  });

  it('falha quando o arquivo muda de tamanho entre a listagem e a leitura', () => {
    const cache: SourceCache = {
      read: () => ({ bytes: 7, mtime: '2026-01-01T00:00:00.000Z', sha256: sha('a') }),
      size: () => 10,
    };
    expect(() => siaPaPartitionSources(cache, DIR, 'AC', 2024, 1)).toThrow(
      /PAAC2401\.dbc mudou de tamanho no cache: 10 bytes listados, 7 lidos/,
    );
  });

  it('falha quando o hash lido é o de arquivo vazio ou não é um SHA-256', () => {
    const comHash = (sha256: string): SourceCache => ({
      read: () => ({ bytes: 10, mtime: '2026-01-01T00:00:00.000Z', sha256 }),
      size: () => 10,
    });
    expect(() => siaPaPartitionSources(comHash(EMPTY_SHA256), DIR, 'AC', 2024, 1)).toThrow(
      /SHA-256 inválido para PAAC2401\.dbc/,
    );
    expect(() => siaPaPartitionSources(comHash(''), DIR, 'AC', 2024, 1)).toThrow(
      SourceProvenanceError,
    );
  });

  it('falha quando o mtime lido está vazio', () => {
    const cache: SourceCache = {
      read: () => ({ bytes: 10, mtime: '', sha256: sha('a') }),
      size: () => 10,
    };
    expect(() => siaPaPartitionSources(cache, DIR, 'AC', 2024, 1)).toThrow(
      /mtime ausente para PAAC2401\.dbc/,
    );
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

describe('buildProvenance + serializeProvenance', () => {
  it('partição de arquivo único sai byte-a-byte igual à de antes da mudança', () => {
    const sources = siaPaPartitionSources(
      fakeCache({
        'PAAC2401.dbc': {
          bytes: 2767043,
          mtime: '2026-04-23T17:52:39.500Z',
          sha256: 'b1540eba00a1fa2c1dd1f6e2b26e502838f07f235428187f0cc55e181c36fbc7',
        },
      }),
      DIR,
      'AC',
      2024,
      1,
    );
    expect(serializeProvenance(buildProvenance({ ...baseInput, sources }))).toBe(
      PROVENANCE_ARQUIVO_UNICO_ANTES,
    );
  });

  it('partição dividida: `source` nulo seguido de `sources`, depois de `pipeline`', () => {
    const sources = siaPaPartitionSources(
      fakeCache({
        'PAMG2508.dbc': vazio(),
        'PAMG2508a.dbc': { bytes: 1, mtime: '2026-09-30T22:02:10.000Z', sha256: sha('a') },
        'PAMG2508b.dbc': { bytes: 2, mtime: '2026-09-30T22:03:10.000Z', sha256: sha('b') },
      }),
      DIR,
      'MG',
      2025,
      8,
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
