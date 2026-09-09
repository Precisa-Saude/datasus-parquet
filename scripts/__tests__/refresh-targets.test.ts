import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parsePendingTargets,
  partitionArtifactPaths,
  sortTargets,
} from '../lib/refresh-targets.js';

function pendingJson(entries: unknown[]): string {
  return JSON.stringify({ detectedAt: '2026-08-17T07:05:46.851Z', pending: entries });
}

describe('parsePendingTargets', () => {
  it('extrai as tuplas (UF, ano, mês) do dataset pedido', () => {
    const raw = pendingJson([
      { dataset: 'sia-pa', month: 6, uf: 'SP', year: 2026 },
      { dataset: 'sia-pa', month: 3, uf: 'AC', year: 2026 },
    ]);
    expect(parsePendingTargets(raw, 'sia-pa')).toEqual([
      { month: 3, uf: 'AC', year: 2026 },
      { month: 6, uf: 'SP', year: 2026 },
    ]);
  });

  it('ignora entradas de outros datasets', () => {
    const raw = pendingJson([
      { dataset: 'sia-pa', month: 1, uf: 'RS', year: 2026 },
      { dataset: 'sih-rd', month: 1, uf: 'RS', year: 2026 },
    ]);
    expect(parsePendingTargets(raw, 'sia-pa')).toEqual([{ month: 1, uf: 'RS', year: 2026 }]);
  });

  it('devolve lista vazia quando não há pendências', () => {
    expect(parsePendingTargets(pendingJson([]), 'sia-pa')).toEqual([]);
  });

  it('tolera pending.json sem a chave `pending`', () => {
    expect(parsePendingTargets('{"detectedAt":"x"}', 'sia-pa')).toEqual([]);
  });

  it('rejeita JSON malformado com mensagem explícita', () => {
    expect(() => parsePendingTargets('{ nao json', 'sia-pa')).toThrow(/não é JSON/);
  });

  it('rejeita raiz que não é objeto', () => {
    expect(() => parsePendingTargets('42', 'sia-pa')).toThrow(/raiz não é um objeto/);
  });

  it('rejeita `pending` que não é lista', () => {
    expect(() => parsePendingTargets('{"pending":{}}', 'sia-pa')).toThrow(/não é uma lista/);
  });

  it.each([
    ['sem uf', { dataset: 'sia-pa', month: 3, year: 2026 }],
    ['uf vazia', { dataset: 'sia-pa', month: 3, uf: '', year: 2026 }],
    ['ano não inteiro', { dataset: 'sia-pa', month: 3, uf: 'SP', year: '2026' }],
    ['mês fora de 1-12', { dataset: 'sia-pa', month: 13, uf: 'SP', year: 2026 }],
    ['mês zero', { dataset: 'sia-pa', month: 0, uf: 'SP', year: 2026 }],
    ['entrada nula', null],
  ])('rejeita entrada malformada: %s', (_label, entry) => {
    // Pular em silêncio produziria alvo `undefined` e partição inválida.
    expect(() => parsePendingTargets(pendingJson([entry]), 'sia-pa')).toThrow(/entrada 0/);
  });

  it('cobre as 108 partições de 2026-03..06 × 27 UFs sem perder nenhuma', () => {
    // Regressão do incidente 2026-08-17: o archive rodava com os
    // defaults AC/2024 e ignorava o delta inteiro.
    const ufs = Array.from({ length: 27 }, (_, i) => `U${String(i).padStart(2, '0')}`);
    const entries = ufs.flatMap((uf) =>
      [3, 4, 5, 6].map((month) => ({ dataset: 'sia-pa', month, uf, year: 2026 })),
    );
    const targets = parsePendingTargets(pendingJson(entries), 'sia-pa');
    expect(targets).toHaveLength(108);
    expect(new Set(targets.map((t) => t.uf)).size).toBe(27);
  });
});

describe('sortTargets', () => {
  it('ordena por ano, depois UF, depois mês', () => {
    expect(
      sortTargets([
        { month: 2, uf: 'SP', year: 2026 },
        { month: 1, uf: 'SP', year: 2026 },
        { month: 12, uf: 'AC', year: 2025 },
        { month: 1, uf: 'AC', year: 2026 },
      ]),
    ).toEqual([
      { month: 12, uf: 'AC', year: 2025 },
      { month: 1, uf: 'AC', year: 2026 },
      { month: 1, uf: 'SP', year: 2026 },
      { month: 2, uf: 'SP', year: 2026 },
    ]);
  });

  it('não muta a lista original', () => {
    const input = [
      { month: 5, uf: 'SP', year: 2026 },
      { month: 1, uf: 'AC', year: 2026 },
    ];
    sortTargets(input);
    expect(input[0]).toEqual({ month: 5, uf: 'SP', year: 2026 });
  });
});

describe('partitionArtifactPaths', () => {
  it('monta o layout Hive com mês zero-padded', () => {
    const paths = partitionArtifactPaths('/build', 'sia-pa', { month: 3, uf: 'SP', year: 2026 });
    expect(paths.parquet).toBe(resolve('/build/sia-pa/ano=2026/uf=SP/mes=03/part.parquet'));
    expect(paths.skippedMarker).toBe(
      resolve('/build/sia-pa/ano=2026/uf=SP/mes=03/part.parquet.skipped'),
    );
  });

  it('não zero-pada meses de dois dígitos', () => {
    const paths = partitionArtifactPaths('/build', 'sia-pa', { month: 12, uf: 'RS', year: 2025 });
    expect(paths.parquet).toContain('mes=12/');
  });
});
