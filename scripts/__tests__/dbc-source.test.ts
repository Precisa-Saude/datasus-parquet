import { describe, expect, it, vi } from 'vitest';

import {
  checkSize,
  type DownloadFn,
  fetchVerified,
  resolvePartitionFiles,
  siaPaBaseName,
  SizeMismatchError,
} from '../lib/dbc-source.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';

describe('siaPaBaseName', () => {
  it('monta PA{UF}{AA}{MM} com zero à esquerda', () => {
    expect(siaPaBaseName('AC', 2026, 7)).toBe('PAAC2607');
    expect(siaPaBaseName('SP', 2009, 12)).toBe('PASP0912');
  });
});

describe('resolvePartitionFiles', () => {
  it('prefere o arquivo canônico quando existe', () => {
    const listing = new Map([
      ['PARR2508.dbc', 986053],
      ['PARR2508a.dbc', 1],
    ]);
    expect(resolvePartitionFiles(listing, 'RR', 2025, 8)).toEqual([
      { name: 'PARR2508.dbc', size: 986053 },
    ]);
  });

  it('usa as variantes presentes, em ordem, quando não há canônico', () => {
    const listing = new Map([
      ['PAMG2606c.dbc', 32602968],
      ['PAMG2606a.dbc', 167508542],
      ['PAMG2606b.dbc', 205609860],
    ]);
    expect(resolvePartitionFiles(listing, 'MG', 2026, 6)).toEqual([
      { name: 'PAMG2606a.dbc', size: 167508542 },
      { name: 'PAMG2606b.dbc', size: 205609860 },
      { name: 'PAMG2606c.dbc', size: 32602968 },
    ]);
  });

  it('não confunde meses vizinhos nem outras UFs', () => {
    const listing = new Map([
      ['PARJ2109a.dbc', 1],
      ['PARJ2111a.dbc', 1],
      ['PASP2110a.dbc', 1],
    ]);
    expect(resolvePartitionFiles(listing, 'RJ', 2021, 10)).toEqual([]);
  });

  it('devolve lista vazia quando o mês não foi publicado', () => {
    expect(resolvePartitionFiles(new Map(), 'AC', 2026, 8)).toEqual([]);
  });
});

describe('checkSize', () => {
  it('aceita tamanho exato', () => {
    expect(() => checkSize({ name: 'X.dbc', size: 3 }, new Uint8Array(3))).not.toThrow();
  });

  it('rejeita arquivo truncado com SizeMismatchError', () => {
    expect(() => checkSize({ name: 'PARS2512.dbc', size: 10 }, new Uint8Array(7))).toThrow(
      SizeMismatchError,
    );
  });

  it('expõe esperado e obtido no erro', () => {
    try {
      checkSize({ name: 'PARS2512.dbc', size: 10 }, new Uint8Array(7));
    } catch (err) {
      expect(err).toBeInstanceOf(SizeMismatchError);
      const e = err as SizeMismatchError;
      expect([e.file, e.expected, e.actual]).toEqual(['PARS2512.dbc', 10, 7]);
      expect(e.message).toContain('tamanho divergente');
    }
  });
});

describe('fetchVerified', () => {
  const file = { name: 'PAPA2601.dbc', size: 5 };

  it('devolve o cache quando o tamanho bate, sem forçar download', async () => {
    const download = vi.fn<DownloadFn>().mockResolvedValue(new Uint8Array(5));
    const bytes = await fetchVerified(file, DIR, download);
    expect(bytes.byteLength).toBe(5);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith({ path: `${DIR}/PAPA2601.dbc` });
  });

  it('força download novo quando o cache diverge', async () => {
    const download = vi
      .fn<DownloadFn>()
      .mockResolvedValueOnce(new Uint8Array(2))
      .mockResolvedValueOnce(new Uint8Array(5));
    const bytes = await fetchVerified(file, DIR, download);
    expect(bytes.byteLength).toBe(5);
    expect(download).toHaveBeenLastCalledWith({
      forceRefresh: true,
      path: `${DIR}/PAPA2601.dbc`,
    });
  });

  it('lança SizeMismatchError se o download novo também diverge', async () => {
    const download = vi.fn<DownloadFn>().mockResolvedValue(new Uint8Array(4));
    await expect(fetchVerified(file, DIR, download)).rejects.toBeInstanceOf(SizeMismatchError);
    expect(download).toHaveBeenCalledTimes(2);
  });
});
