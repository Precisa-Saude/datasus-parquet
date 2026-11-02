import { describe, expect, it } from 'vitest';

import { isUnknownMtime, parseDosMtime, UNKNOWN_MTIME } from '../lib/ftp-mtime.js';

describe('parseDosMtime', () => {
  it('lê o formato DOS da listagem do FTP DATASUS como UTC', () => {
    expect(parseDosMtime('10-30-26 09:51PM')?.toISOString()).toBe('2026-10-30T21:51:00.000Z');
    expect(parseDosMtime('06-30-11 10:06AM')?.toISOString()).toBe('2011-06-30T10:06:00.000Z');
  });

  it('trata meio-dia e meia-noite', () => {
    expect(parseDosMtime('01-05-26 12:00PM')?.toISOString()).toBe('2026-01-05T12:00:00.000Z');
    expect(parseDosMtime('01-05-26 12:30AM')?.toISOString()).toBe('2026-01-05T00:30:00.000Z');
  });

  it('aceita espaços extras e minúsculas', () => {
    expect(parseDosMtime('  10-30-26   09:51pm ')?.toISOString()).toBe('2026-10-30T21:51:00.000Z');
  });

  it('rejeita formato desconhecido e datas impossíveis', () => {
    expect(parseDosMtime('')).toBeNull();
    expect(parseDosMtime('Oct 30 21:51')).toBeNull();
    expect(parseDosMtime('2026-10-30T21:51:00Z')).toBeNull();
    expect(parseDosMtime('13-01-26 09:51PM')).toBeNull();
    expect(parseDosMtime('02-30-26 09:51PM')).toBeNull();
    expect(parseDosMtime('02-00-26 09:51PM')).toBeNull();
    expect(parseDosMtime('02-10-26 09:60PM')).toBeNull();
  });
});

describe('isUnknownMtime', () => {
  it('epoch e valores ilegíveis são desconhecidos', () => {
    expect(isUnknownMtime(UNKNOWN_MTIME)).toBe(true);
    expect(isUnknownMtime('1970-01-01T00:00:00.000Z')).toBe(true);
    expect(isUnknownMtime('não é data')).toBe(true);
  });

  it('data real é conhecida', () => {
    expect(isUnknownMtime('2026-10-30T21:51:00.000Z')).toBe(false);
    expect(isUnknownMtime(new Date('2026-10-30T21:51:00.000Z'))).toBe(false);
  });
});
