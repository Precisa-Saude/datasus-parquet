import { describe, expect, it } from 'vitest';

import {
  FINGERPRINT_VERSION,
  fingerprintSql,
  formatFingerprint,
  isUnchanged,
  publishedFingerprint,
  unchangedMarkdown,
} from '../lib/content-fingerprint.js';

describe('fingerprintSql', () => {
  it('lê o parquet informado e escapa aspas simples', () => {
    const sql = fingerprintSql("/tmp/o'brien/part.parquet");
    expect(sql).toContain("read_parquet('/tmp/o''brien/part.parquet')");
    expect(sql).toContain('md5_number_lower');
    expect(sql).toContain('bit_xor(md5_number_upper');
  });
});

describe('formatFingerprint', () => {
  it('monta v1:<linhas>:<soma>:<xor> em maiúsculas', () => {
    expect(
      formatFingerprint({ n: '173845', s: '15454e690ece470aa0aee', x: '8e22f8f5ec55e60e' }),
    ).toBe('v1:173845:15454E690ECE470AA0AEE:8E22F8F5EC55E60E');
    expect(FINGERPRINT_VERSION).toBe('v1');
  });

  it('aceita a contagem como bigint ou número', () => {
    expect(formatFingerprint({ n: 5n, s: 'A', x: 'B' })).toBe('v1:5:A:B');
    expect(formatFingerprint({ n: 5, s: 'A', x: 'B' })).toBe('v1:5:A:B');
  });

  it('partição vazia tem soma e xor vazios', () => {
    expect(formatFingerprint({ n: '0', s: null as unknown as string, x: '' })).toBe('v1:0::');
  });

  it('rejeita contagem inválida', () => {
    expect(() => formatFingerprint({ n: 'x', s: '', x: '' })).toThrow(/contagem inválida/);
  });
});

describe('publishedFingerprint', () => {
  const fp = 'v1:10:AA:BB';

  it('lê output.fingerprint de um provenance', () => {
    expect(publishedFingerprint(JSON.stringify({ output: { fingerprint: fp } }))).toBe(fp);
  });

  it('provenance antigo (sem impressão), ausente ou ilegível → null', () => {
    expect(publishedFingerprint(JSON.stringify({ output: { sha256: 'x' } }))).toBeNull();
    expect(publishedFingerprint(JSON.stringify({}))).toBeNull();
    expect(publishedFingerprint(null)).toBeNull();
    expect(publishedFingerprint(undefined)).toBeNull();
    expect(publishedFingerprint('')).toBeNull();
    expect(publishedFingerprint('{não é json')).toBeNull();
    expect(publishedFingerprint('null')).toBeNull();
  });

  it('ignora impressão de outra versão', () => {
    expect(
      publishedFingerprint(JSON.stringify({ output: { fingerprint: 'v0:1:A:B' } })),
    ).toBeNull();
    expect(publishedFingerprint(JSON.stringify({ output: { fingerprint: 42 } }))).toBeNull();
  });
});

describe('isUnchanged', () => {
  it('só é igual com impressão publicada idêntica', () => {
    expect(isUnchanged('v1:1:A:B', 'v1:1:A:B')).toBe(true);
    expect(isUnchanged('v1:1:A:B', 'v1:2:A:B')).toBe(false);
    expect(isUnchanged('v1:1:A:B', null)).toBe(false);
  });
});

describe('unchangedMarkdown', () => {
  it('sem linhas, diz que nada foi pulado', () => {
    expect(unchangedMarkdown([])).toBe('Nenhuma partição com conteúdo idêntico ao publicado.');
  });

  it('tabela com linhas formatadas e limite', () => {
    const rows = [
      {
        fingerprint: 'v1:173845:A:B',
        month: 9,
        publishedAt: '2026-10-01T11:29:25.519Z',
        uf: 'AC',
        year: 2025,
      },
      { fingerprint: 'v1:5:A:B', month: 10, publishedAt: null, uf: 'AC', year: 2025 },
    ];
    const md = unchangedMarkdown(rows, 1);
    expect(md).toContain('| AC | 2025-09 | 173.845 | 2026-10-01T11:29:25.519Z |');
    expect(md).not.toContain('2025-10');
    expect(md).toContain('… e mais 1.');
    expect(unchangedMarkdown(rows)).toContain('| AC | 2025-10 | 5 | — |');
  });
});
