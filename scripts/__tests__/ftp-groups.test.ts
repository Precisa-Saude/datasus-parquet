import { describe, expect, it } from 'vitest';

import { groupListing, type ListedFile, parseListingFile } from '../lib/ftp-groups.js';
import { UNKNOWN_MTIME } from '../lib/ftp-mtime.js';
import { parseSiaPaFileName, SIA_PA_REGEX } from '../lib/sia-pa-parser.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const CFG = { dir: DIR, fileRegex: SIA_PA_REGEX, parseName: parseSiaPaFileName };

function file(name: string, size: number, mtime: string): ListedFile {
  return { mtime: new Date(mtime), name, size };
}

describe('groupListing', () => {
  it('agrupa canônico e variantes por (UF, ano, mês), na ordem das variantes, somando tamanhos e com o mtime mais recente', () => {
    const groups = groupListing(
      [
        file('PAMG2508b.dbc', 20, '2026-09-17T17:27:00Z'),
        file('PAMG2508a.dbc', 10, '2026-09-17T17:28:00Z'),
        file('PAAC0801.dbc', 5, '2025-01-01T00:00:00Z'),
        file('LEIAME.txt', 1, '2025-01-01T00:00:00Z'),
        file('PAAC0813.dbc', 1, '2025-01-01T00:00:00Z'),
      ],
      CFG,
    );
    expect(groups).toHaveLength(2);
    const mg = groups.find((g) => g.uf === 'MG')!;
    expect(mg).toMatchObject({
      month: 8,
      mtime: '2026-09-17T17:28:00.000Z',
      size: 30,
      uf: 'MG',
      year: 2025,
    });
    expect(mg.variants.map((v) => [v.name, v.suffix, v.ftpPath, v.ftpSize, v.ftpMtime])).toEqual([
      ['PAMG2508a.dbc', 'a', `${DIR}/PAMG2508a.dbc`, 10, '2026-09-17T17:28:00.000Z'],
      ['PAMG2508b.dbc', 'b', `${DIR}/PAMG2508b.dbc`, 20, '2026-09-17T17:27:00.000Z'],
    ]);
    const ac = groups.find((g) => g.uf === 'AC')!;
    expect(ac).toMatchObject({ month: 1, size: 5, year: 2008 });
    expect(ac.variants.map((v) => v.suffix)).toEqual(['']);
  });

  it('mtime desconhecido (epoch) não vence um conhecido', () => {
    const [g] = groupListing(
      [
        file('PASP2401a.dbc', 1, UNKNOWN_MTIME.toISOString()),
        file('PASP2401b.dbc', 1, '2024-03-01T00:00:00Z'),
      ],
      CFG,
    );
    expect(g!.mtime).toBe('2024-03-01T00:00:00.000Z');
  });
});

describe('parseListingFile', () => {
  it('lê a listagem salva (nome, tamanho, mtime ISO ou null)', () => {
    const listed = parseListingFile(
      JSON.stringify([
        { mtime: '2025-01-01T00:00:00Z', name: 'PAAC0801.dbc', size: 575335 },
        { mtime: null, name: 'PAAC0802.dbc', size: 10 },
      ]),
    );
    expect(listed).toEqual([
      { mtime: new Date('2025-01-01T00:00:00Z'), name: 'PAAC0801.dbc', size: 575335 },
      { mtime: UNKNOWN_MTIME, name: 'PAAC0802.dbc', size: 10 },
    ]);
  });

  it('recusa JSON inválido, raiz que não é lista e item malformado', () => {
    expect(() => parseListingFile('{')).toThrow(/listagem do FTP inválida: não é JSON/);
    expect(() => parseListingFile('{}')).toThrow(/não é uma lista/);
    expect(() => parseListingFile(JSON.stringify([{ name: 'X.dbc', size: -1 }]))).toThrow(
      /item 0 malformado/,
    );
    expect(() =>
      parseListingFile(JSON.stringify([{ mtime: 'ontem', name: 'X.dbc', size: 1 }])),
    ).toThrow(/item 0 malformado/);
    expect(() => parseListingFile(JSON.stringify([null]))).toThrow(/item 0 malformado/);
  });
});
