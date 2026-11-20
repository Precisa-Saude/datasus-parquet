import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertProvenanceUploadKey,
  matchesS3Etag,
  parquetKey,
  parsePartitionKey,
  parseS3Listing,
  provenanceKey,
} from '../lib/s3-objects.js';

const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');

describe('parseS3Listing', () => {
  it('lê o JSON do `aws s3api list-objects-v2`, normalizando ETag e Last-Modified', () => {
    const json = JSON.stringify({
      Contents: [
        {
          ETag: '"d6df6304847a756ba04fbb2b1cf2833b"',
          Key: 'sia-pa/ano=2008/uf=AC/mes=01/part.parquet',
          LastModified: '2026-04-25T12:32:18+00:00',
          Size: 169830,
        },
      ],
    });
    expect(parseS3Listing(json)).toEqual([
      {
        etag: 'd6df6304847a756ba04fbb2b1cf2833b',
        key: 'sia-pa/ano=2008/uf=AC/mes=01/part.parquet',
        lastModified: '2026-04-25T12:32:18.000Z',
        size: 169830,
      },
    ]);
  });

  it('prefixo vazio: saída vazia ou sem `Contents` é lista vazia', () => {
    expect(parseS3Listing('')).toEqual([]);
    expect(parseS3Listing('  \n')).toEqual([]);
    expect(parseS3Listing('{"RequestCharged": null}')).toEqual([]);
  });

  it('recusa JSON inválido e objeto malformado (Last-Modified ilegível derrubaria a certificação)', () => {
    expect(() => parseS3Listing('{')).toThrow(/listagem do S3 inválida: não é JSON/);
    expect(() => parseS3Listing('{"Contents": {}}')).toThrow(/`Contents` não é lista/);
    const bad = (o: Record<string, unknown>): string => JSON.stringify({ Contents: [o] });
    const ok = { ETag: '"x"', Key: 'k', LastModified: '2026-01-01T00:00:00Z', Size: 1 };
    expect(() => parseS3Listing(bad({ ...ok, LastModified: 'ontem' }))).toThrow(/objeto 0/);
    expect(() => parseS3Listing(bad({ ...ok, Size: '1' }))).toThrow(/objeto 0/);
    expect(() => parseS3Listing(bad({ ...ok, Key: 1 }))).toThrow(/objeto 0/);
    expect(() => parseS3Listing(bad({ ...ok, ETag: null }))).toThrow(/objeto 0/);
    expect(() => parseS3Listing(JSON.stringify({ Contents: [null] }))).toThrow(/objeto 0/);
  });
});

describe('chaves de partição', () => {
  const p = { ano: 2025, mes: 8, uf: 'MG' };

  it('monta as chaves do Parquet e do provenance', () => {
    expect(parquetKey('sia-pa', p)).toBe('sia-pa/ano=2025/uf=MG/mes=08/part.parquet');
    expect(provenanceKey('sia-pa', p)).toBe(
      'sia-pa/provenance/ano=2025/uf=MG/mes=08/part.provenance.json',
    );
  });

  it('reconhece Parquet e provenance do dataset e ignora o resto', () => {
    expect(parsePartitionKey(parquetKey('sia-pa', p), 'sia-pa')).toEqual({
      ...p,
      kind: 'parquet',
    });
    expect(parsePartitionKey(provenanceKey('sia-pa', p), 'sia-pa')).toEqual({
      ...p,
      kind: 'provenance',
    });
    expect(parsePartitionKey('sia-pa/ano=2025/uf=MG/mes=08/part.sources.json', 'sia-pa')).toBe(
      null,
    );
    expect(parsePartitionKey('manifest.json', 'sia-pa')).toBe(null);
    // Arquivo no diretório errado: Parquet em provenance/ e vice-versa.
    expect(
      parsePartitionKey('sia-pa/provenance/ano=2025/uf=MG/mes=08/part.parquet', 'sia-pa'),
    ).toBe(null);
    expect(parsePartitionKey('sia-pa/ano=2025/uf=MG/mes=08/part.provenance.json', 'sia-pa')).toBe(
      null,
    );
    expect(parsePartitionKey('sih-rd/ano=2025/uf=MG/mes=08/part.parquet', 'sia-pa')).toBe(null);
  });

  it('upload só aceita provenance de partição do dataset (nada de Parquet, manifest ou `..`)', () => {
    expect(() => assertProvenanceUploadKey(provenanceKey('sia-pa', p), 'sia-pa')).not.toThrow();
    for (const key of [
      parquetKey('sia-pa', p),
      'manifest.json',
      'sia-pa/provenance/../ano=2025/uf=MG/mes=08/part.provenance.json',
      'sih-rd/provenance/ano=2025/uf=MG/mes=08/part.provenance.json',
      `/${provenanceKey('sia-pa', p)}`,
    ]) {
      expect(() => assertProvenanceUploadKey(key, 'sia-pa'), key).toThrow(
        /fora de sia-pa\/provenance/,
      );
    }
  });
});

describe('matchesS3Etag', () => {
  const bytes = new TextEncoder().encode('0123456789');

  it('upload simples: ETag é o MD5 do objeto (com ou sem aspas)', () => {
    expect(matchesS3Etag(md5(bytes), bytes)).toBe(true);
    expect(matchesS3Etag(`"${md5(bytes)}"`, bytes)).toBe(true);
    expect(matchesS3Etag(md5(bytes), new TextEncoder().encode('0123456780'))).toBe(false);
  });

  it('multipart: MD5 dos MD5 das partes + `-N`, com o tamanho de parte do aws CLI', () => {
    const parts = [bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8)];
    const concat = Buffer.concat(parts.map((part) => createHash('md5').update(part).digest()));
    const etag = `${md5(concat)}-3`;
    expect(matchesS3Etag(etag, bytes, 4)).toBe(true);
    // Outro tamanho de parte, mesmo número de partes: hash diferente.
    expect(matchesS3Etag(etag, bytes, 5)).toBe(false);
    // Número de partes incompatível com o tamanho: nem calcula.
    expect(matchesS3Etag(`${md5(concat)}-2`, bytes, 4)).toBe(false);
    expect(matchesS3Etag(etag, new TextEncoder().encode('0123456780'), 4)).toBe(false);
  });

  it('ETag que não é MD5 (SSE-KMS, checksum) nunca confere: o Parquet é baixado do S3', () => {
    expect(matchesS3Etag('nao-e-md5', bytes)).toBe(false);
    expect(matchesS3Etag(`${md5(bytes)}-x`, bytes)).toBe(false);
  });
});
