import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { failRecord, markFailed, writeRecordThenParquet } from '../lib/archive-partition.js';

/** Passos que só registram a ordem em que foram chamados. */
function passos(falha?: 'buildRecord' | 'writeParquet' | 'writeRecord'): {
  calls: string[];
  failures: unknown[];
  steps: Parameters<typeof writeRecordThenParquet>[0];
} {
  const calls: string[] = [];
  const failures: unknown[] = [];
  const maybeFail = (step: string): void => {
    calls.push(step);
    if (falha === step) throw new Error(`ENOENT: ${step}`);
  };
  return {
    calls,
    failures,
    steps: {
      buildRecord: () => {
        maybeFail('buildRecord');
        return '{"version":1}\n';
      },
      onRecordFailure: (err) => {
        calls.push('onRecordFailure');
        failures.push(err);
      },
      writeParquet: () => {
        maybeFail('writeParquet');
        return Promise.resolve();
      },
      writeRecord: (text) => {
        maybeFail('writeRecord');
        calls.push(`conteúdo=${text.trim()}`);
      },
    },
  };
}

describe('writeRecordThenParquet', () => {
  it('grava o part.sources.json antes do part.parquet', async () => {
    const { calls, steps } = passos();
    expect(await writeRecordThenParquet(steps)).toBe('escrito');
    expect(calls).toEqual(['buildRecord', 'writeRecord', 'conteúdo={"version":1}', 'writeParquet']);
  });

  it('falha ao montar o registro (stat do cache): trata a partição como falha e não escreve Parquet', async () => {
    const { calls, failures, steps } = passos('buildRecord');
    expect(await writeRecordThenParquet(steps)).toBe('falhou-registro');
    expect(calls).toEqual(['buildRecord', 'onRecordFailure']);
    expect(String(failures[0])).toMatch(/ENOENT: buildRecord/);
  });

  it('falha ao gravar o registro: trata a partição como falha e não escreve Parquet', async () => {
    const { calls, steps } = passos('writeRecord');
    expect(await writeRecordThenParquet(steps)).toBe('falhou-registro');
    expect(calls).toEqual(['buildRecord', 'writeRecord', 'onRecordFailure']);
  });

  it('falha ao escrever o Parquet sobe como antes (o registro já gravado é refeito no próximo run)', async () => {
    const { calls, steps } = passos('writeParquet');
    await expect(writeRecordThenParquet(steps)).rejects.toThrow(/ENOENT: writeParquet/);
    expect(calls).toEqual(['buildRecord', 'writeRecord', 'conteúdo={"version":1}', 'writeParquet']);
  });
});

describe('markFailed e failRecord', () => {
  it('markFailed grava o marker com rótulo, tipo e mensagem e loga a falha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-partition-'));
    const marker = join(dir, 'part.parquet.failed');
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    markFailed(
      marker,
      'MG 2025-8',
      'decode',
      'após 3 tentativas (decode)',
      new Error('DBC truncado'),
    );

    expect(readFileSync(marker, 'utf8')).toMatch(/^\S+ MG 2025-8\ndecode\nDBC truncado\n$/);
    expect(String(log.mock.calls[0]?.[0])).toContain(
      '✗ FALHA MG 2025-8 após 3 tentativas (decode): DBC truncado',
    );
    log.mockRestore();
  });

  it('markFailed aceita erro que não é Error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-partition-'));
    const marker = join(dir, 'part.parquet.failed');
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    markFailed(marker, 'SP 2026-8', 'transporte', 'após 5 tentativas (transporte)', 'ECONNRESET');

    expect(readFileSync(marker, 'utf8')).toMatch(/\ntransporte\nECONNRESET\n$/);
    log.mockRestore();
  });

  it('failRecord apaga NDJSON e registro parciais e grava marker do tipo registro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-partition-'));
    const paths = {
      label: 'MG 2025-8',
      marker: join(dir, 'part.parquet.failed'),
      ndjsonFile: join(dir, 'part.ndjson'),
      sourcesRecordFile: join(dir, 'part.sources.json'),
    };
    writeFileSync(paths.ndjsonFile, '{}\n');
    writeFileSync(paths.sourcesRecordFile, '{"version":1}\n');
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    failRecord(paths, new Error('ENOENT: stat PAMG2508c.dbc'));

    expect(existsSync(paths.ndjsonFile)).toBe(false);
    expect(existsSync(paths.sourcesRecordFile)).toBe(false);
    expect(readFileSync(paths.marker, 'utf8')).toMatch(
      /\nregistro\nENOENT: stat PAMG2508c\.dbc\n$/,
    );
    expect(String(log.mock.calls[0]?.[0])).toContain('ao gravar part.sources.json');
    log.mockRestore();
  });
});
