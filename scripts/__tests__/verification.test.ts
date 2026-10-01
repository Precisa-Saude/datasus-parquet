import { describe, expect, it } from 'vitest';

import {
  classify,
  parseRecordCount,
  partitionKey,
  rejectedMarkdown,
  type VerificationRow,
  verifiedKeys,
} from '../lib/verification.js';

describe('parseRecordCount', () => {
  it('lê o uint32 little-endian dos bytes 4–7', () => {
    const header = new Uint8Array(12);
    new DataView(header.buffer).setUint32(4, 1592573, true);
    expect(parseRecordCount(header)).toBe(1592573);
  });

  it('funciona com buffer deslocado (subarray)', () => {
    const big = new Uint8Array(20);
    new DataView(big.buffer).setUint32(4 + 4, 26508, true);
    expect(parseRecordCount(big.subarray(4, 16))).toBe(26508);
  });

  it('devolve null para buffer curto', () => {
    expect(parseRecordCount(new Uint8Array(7))).toBeNull();
  });
});

describe('classify', () => {
  it('ok quando bate', () => expect(classify(10, 10)).toBe('ok'));
  it('divergente quando difere', () => expect(classify(9, 10)).toBe('divergente'));
  it('sem-parquet tem precedência', () => expect(classify(null, null)).toBe('sem-parquet'));
  it('ftp-ilegivel quando o cabeçalho não veio', () =>
    expect(classify(10, null)).toBe('ftp-ilegivel'));
});

describe('partitionKey', () => {
  it('UF|AAAA-MM', () =>
    expect(partitionKey({ month: 7, uf: 'AC', year: 2026 })).toBe('AC|2026-07'));
});

describe('verifiedKeys', () => {
  it('extrai as chaves aprovadas', () => {
    const raw = JSON.stringify({
      generatedAt: 'x',
      rejected: [{ month: 6, uf: 'SP', year: 2026 }],
      verified: [
        { month: 7, uf: 'AC', year: 2026 },
        { month: 12, uf: 'RJ', year: 2025 },
      ],
    });
    expect([...verifiedKeys(raw)]).toEqual(['AC|2026-07', 'RJ|2025-12']);
  });

  it('falha alto com JSON inválido ou sem lista', () => {
    expect(() => verifiedKeys('{')).toThrow(/não é JSON/);
    expect(() => verifiedKeys('{"verified": 1}')).toThrow(/não é uma lista/);
    expect(() => verifiedKeys('null')).toThrow(/não é uma lista/);
  });
});

describe('rejectedMarkdown', () => {
  const row = (uf: string, rows: null | number, ftpRows: null | number): VerificationRow => ({
    ftpRows,
    month: 6,
    rows,
    status: classify(rows, ftpRows),
    uf,
    year: 2025,
  });

  it('mensagem curta sem rejeições', () => {
    expect(rejectedMarkdown([])).toBe('Nenhuma partição rejeitada.');
  });

  it('monta a tabela com números em pt-BR e travessão para ausentes', () => {
    const md = rejectedMarkdown([row('GO', 1585442, 1592573), row('MG', 10, null)]);
    expect(md).toContain('| GO | 2025-06 | 1.585.442 | 1.592.573 | divergente |');
    expect(md).toContain('| MG | 2025-06 | 10 | — | ftp-ilegivel |');
  });

  it('trunca no limite e diz quantas ficaram de fora', () => {
    const md = rejectedMarkdown([row('A', 1, 2), row('B', 1, 2), row('C', 1, 2)], 2);
    expect(md).toContain('| B |');
    expect(md).not.toContain('| C |');
    expect(md).toContain('… e mais 1.');
  });
});
