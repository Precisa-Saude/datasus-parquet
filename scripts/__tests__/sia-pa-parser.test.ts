import { describe, expect, it } from 'vitest';

import { parseSiaPaFileName, SIA_PA_REGEX } from '../lib/sia-pa-parser.js';

describe('parseSiaPaFileName', () => {
  it('parses canonical filenames (UF, ano 2-digit, mês)', () => {
    expect(parseSiaPaFileName('PAAC2401.dbc')).toEqual({
      month: 1,
      uf: 'AC',
      variant: '',
      year: 2024,
    });
  });

  it('parses split-file variants (UFs grandes)', () => {
    expect(parseSiaPaFileName('PASP2403a.dbc')).toEqual({
      month: 3,
      uf: 'SP',
      variant: 'a',
      year: 2024,
    });
    expect(parseSiaPaFileName('PAMG2312b.dbc')).toEqual({
      month: 12,
      uf: 'MG',
      variant: 'b',
      year: 2023,
    });
  });

  it('accepts lowercase and normalizes UF to uppercase', () => {
    expect(parseSiaPaFileName('pasp2403A.dbc')).toEqual({
      month: 3,
      uf: 'SP',
      variant: 'a',
      year: 2024,
    });
  });

  it('rejects months fora de 1–12', () => {
    expect(parseSiaPaFileName('PAAC2400.dbc')).toBeNull();
    expect(parseSiaPaFileName('PAAC2413.dbc')).toBeNull();
  });

  it('rejects arquivos que não batem com o formato', () => {
    expect(parseSiaPaFileName('SIHAC2401.dbc')).toBeNull();
    expect(parseSiaPaFileName('PAAC2401.dbf')).toBeNull();
    expect(parseSiaPaFileName('random.txt')).toBeNull();
    expect(parseSiaPaFileName('')).toBeNull();
  });

  it('SIA_PA_REGEX casa apenas UF de 2 letras', () => {
    expect(SIA_PA_REGEX.test('PAA2401.dbc')).toBe(false);
    expect(SIA_PA_REGEX.test('PAACC2401.dbc')).toBe(false);
  });
});
