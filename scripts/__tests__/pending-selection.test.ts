import { describe, expect, it } from 'vitest';

import {
  hasChanged,
  type KnownEntry,
  type RemoteGroup,
  selectPending,
} from '../lib/pending-selection.js';

const EPOCH = '1970-01-01T00:00:00.000Z';

function g(uf: string, year: number, month: number, size: number): RemoteGroup {
  return { month, mtime: EPOCH, size, uf, year };
}

function stateOf(entries: Array<[string, string, number]>) {
  const map = new Map(
    entries.map(([uf, comp, size]) => [
      `${uf}|${comp}`,
      { sourceMtime: EPOCH, sourceSize: size } satisfies KnownEntry,
    ]),
  );
  return (uf: string, comp: string) => map.get(`${uf}|${comp}`);
}

describe('selectPending', () => {
  const groups = [
    g('AC', 2024, 6, 10), // fora da janela, igual ao state
    g('AC', 2025, 7, 20), // início da janela de 13 terminando em 2026-07
    g('AC', 2026, 6, 30),
    g('AC', 2026, 7, 40), // competência nova
  ];

  it('com delta, reprocessa a janela inteira e marca o motivo', () => {
    const known = stateOf([
      ['AC', '2024-06', 10],
      ['AC', '2025-07', 20],
      ['AC', '2026-06', 30],
    ]);
    const r = selectPending(groups, known, 13);
    expect(r.latest).toBe('2026-07');
    expect(r.windowStart).toBe('2025-07');
    expect(r.selected.map((s) => [s.group.year, s.group.month, s.reason])).toEqual([
      [2025, 7, 'janela'],
      [2026, 6, 'janela'],
      [2026, 7, 'novo'],
    ]);
  });

  it('sem delta, não reprocessa nada (refresh entre publicações vira no-op)', () => {
    const known = stateOf([
      ['AC', '2024-06', 10],
      ['AC', '2025-07', 20],
      ['AC', '2026-06', 30],
      ['AC', '2026-07', 40],
    ]);
    const r = selectPending(groups, known, 13);
    expect(r.selected).toEqual([]);
    expect(r.windowStart).toBeNull();
  });

  it('mantém o delta fora da janela como rede de segurança', () => {
    const known = stateOf([
      ['AC', '2024-06', 9], // tamanho mudou fora da janela
      ['AC', '2025-07', 20],
      ['AC', '2026-06', 30],
      ['AC', '2026-07', 40],
    ]);
    const r = selectPending(groups, known, 13);
    expect(r.selected.map((s) => [s.group.year, s.group.month, s.reason])).toEqual([
      [2024, 6, 'alterado'],
      [2025, 7, 'janela'],
      [2026, 6, 'janela'],
      [2026, 7, 'janela'],
    ]);
  });

  it('detecta mudança de mtime mesmo com tamanho igual', () => {
    const known = (_uf: string, comp: string) =>
      comp === '2026-07' ? { sourceMtime: '2026-09-17T00:00:00.000Z', sourceSize: 40 } : undefined;
    const remote = { ...g('AC', 2026, 7, 40), mtime: '2026-10-30T21:51:00.000Z' };
    const r = selectPending([remote], known, 0);
    expect(r.selected[0]?.reason).toBe('alterado');
  });

  it('mesmo tamanho e mesmo mtime não é alteração', () => {
    const known = () => ({ sourceMtime: '2026-10-30T21:51:00.000Z', sourceSize: 40 });
    const remote = { ...g('AC', 2026, 7, 40), mtime: '2026-10-30T21:51:00.000Z' };
    expect(selectPending([remote], known, 0).selected).toEqual([]);
  });

  it('state sem mtime (epoch) compara só por tamanho — migração sem reprocessar tudo', () => {
    const known = stateOf([['AC', '2026-07', 40]]);
    const remote = { ...g('AC', 2026, 7, 40), mtime: '2026-10-30T21:51:00.000Z' };
    expect(selectPending([remote], known, 0).selected).toEqual([]);
    expect(hasChanged({ sourceMtime: EPOCH, sourceSize: 40 }, remote)).toBe(false);
    expect(hasChanged({ sourceMtime: EPOCH, sourceSize: 41 }, remote)).toBe(true);
  });

  it('FTP sem mtime legível também compara só por tamanho', () => {
    const known = () => ({ sourceMtime: '2026-10-30T21:51:00.000Z', sourceSize: 40 });
    expect(selectPending([g('AC', 2026, 7, 40)], known, 0).selected).toEqual([]);
  });

  it('janela 0 se comporta como o detect antigo (só delta)', () => {
    const known = stateOf([['AC', '2026-06', 30]]);
    const r = selectPending(groups, known, 0);
    expect(r.windowStart).toBeNull();
    expect(r.selected.every((s) => s.reason !== 'janela')).toBe(true);
    expect(r.selected).toHaveLength(3);
  });

  it('lista vazia não tem competência mais recente', () => {
    const r = selectPending([], () => undefined, 13);
    expect(r).toEqual({ latest: null, selected: [], windowStart: null });
  });
});
