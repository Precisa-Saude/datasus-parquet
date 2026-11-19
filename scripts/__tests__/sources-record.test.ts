import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { datasusCacheDir } from '../lib/cache-dir.js';
import { resolvePartitionFiles } from '../lib/dbc-source.js';
import { parseSourcesRecord } from '../lib/provenance.js';
import {
  buildSourcesRecord,
  serializeSourcesRecord,
  SOURCES_RECORD_FILE,
} from '../lib/sources-record.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';

describe('buildSourcesRecord', () => {
  it('registra os DBCs decodificados na ordem do archive, com tamanho e mtime da listagem e mtime do cache', () => {
    // Listagem fora de ordem e com sobra de outra competência: o registro
    // segue `resolvePartitionFiles`, a mesma lista que o archive decodifica.
    const sizes = new Map([
      ['PAMG2508c.dbc', 15204829],
      ['PAMG2508a.dbc', 166934835],
      ['PAMG2508b.dbc', 213060888],
      ['PAMG2507.dbc', 99],
    ]);
    const ftpMtimes = new Map<string, null | string>([
      ['PAMG2508a.dbc', '2026-09-30T21:51:00.000Z'],
      ['PAMG2508b.dbc', '2026-09-30T21:52:00.000Z'],
      // `c` sem mtime legível na listagem: fica `null`, não inventado.
    ]);
    const files = resolvePartitionFiles(sizes, 'MG', 2025, 8);

    const record = buildSourcesRecord({
      cacheMtime: (name) => `cache:${name}`,
      files,
      ftpBase: DIR,
      ftpMtimes,
      partition: { ano: 2025, mes: 8, uf: 'MG' },
    });

    expect(record).toEqual({
      files: [
        {
          bytes: 166934835,
          cacheMtime: 'cache:PAMG2508a.dbc',
          file: 'PAMG2508a.dbc',
          ftpMtime: '2026-09-30T21:51:00.000Z',
          ftpPath: `${DIR}/PAMG2508a.dbc`,
        },
        {
          bytes: 213060888,
          cacheMtime: 'cache:PAMG2508b.dbc',
          file: 'PAMG2508b.dbc',
          ftpMtime: '2026-09-30T21:52:00.000Z',
          ftpPath: `${DIR}/PAMG2508b.dbc`,
        },
        {
          bytes: 15204829,
          cacheMtime: 'cache:PAMG2508c.dbc',
          file: 'PAMG2508c.dbc',
          ftpMtime: null,
          ftpPath: `${DIR}/PAMG2508c.dbc`,
        },
      ],
      partition: { ano: 2025, mes: 8, uf: 'MG' },
      version: 1,
    });
  });

  it('o JSON serializado volta igual pelo leitor do emit-provenance', () => {
    const record = buildSourcesRecord({
      cacheMtime: () => '2026-04-23T17:52:39.500Z',
      files: [{ name: 'PAAC2401.dbc', size: 2767043 }],
      ftpBase: DIR,
      ftpMtimes: new Map([['PAAC2401.dbc', '2025-02-15T14:22:00.000Z']]),
      partition: { ano: 2024, mes: 1, uf: 'AC' },
    });
    const text = serializeSourcesRecord(record);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseSourcesRecord(text, { ano: 2024, mes: 1, uf: 'AC' })).toEqual(record);
  });

  it('o arquivo fica ao lado do part.parquet com nome fixo', () => {
    expect(SOURCES_RECORD_FILE).toBe('part.sources.json');
  });
});

describe('datasusCacheDir', () => {
  it('usa XDG_CACHE_HOME quando definido, como o SDK', () => {
    expect(datasusCacheDir({ XDG_CACHE_HOME: '/tmp/xdg' }, '/home/r')).toBe(
      join('/tmp/xdg', 'datasus-brasil'),
    );
  });

  it('cai em ~/.cache sem XDG_CACHE_HOME', () => {
    expect(datasusCacheDir({}, '/home/r')).toBe(join('/home/r', '.cache', 'datasus-brasil'));
  });
});
