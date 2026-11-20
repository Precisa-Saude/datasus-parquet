/**
 * Objetos do bucket público vistos pela proveniência retroativa: listagem
 * (`aws s3api list-objects-v2`), chaves de partição, guarda do upload e
 * conferência do Parquet local contra o ETag do S3.
 *
 * Por que ETag e não SHA-256: o S3 não guarda o SHA-256 dos objetos
 * enviados pelo `aws s3 sync`/`cp` dos workflows. Com SSE-S3 (AES256, o caso
 * do bucket), o ETag de um upload simples é o MD5 do objeto; o de um upload
 * multipart é o MD5 da concatenação dos MD5 de cada parte, seguido de
 * `-<partes>`. O aws CLI divide em partes de 8 MiB (`multipart_chunksize`
 * padrão) a partir de 8 MiB. Recalcular o ETag do arquivo local com essa
 * regra e comparar, junto com o tamanho, confirma que é o mesmo objeto. Se
 * não conferir por qualquer motivo (outro tamanho de parte, SSE-KMS,
 * objeto diferente), o Parquet é baixado do S3: o falso negativo só custa
 * banda, nunca descreve um Parquet errado.
 */

import { createHash } from 'node:crypto';

export interface S3Object {
  /** ETag sem aspas. */
  etag: string;
  key: string;
  /** Last-Modified em ISO 8601 (UTC). */
  lastModified: string;
  size: number;
}

export interface PartitionRef {
  ano: number;
  mes: number;
  uf: string;
}

/** `multipart_chunksize` padrão do aws CLI, usado pelo `aws s3 sync` dos workflows. */
export const AWS_CLI_PART_SIZE = 8 * 1024 * 1024;

function isListedObject(
  x: unknown,
): x is { ETag: string; Key: string; LastModified: string; Size: number } {
  const o = x as null | Record<string, unknown>;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o['Key'] === 'string' &&
    typeof o['ETag'] === 'string' &&
    Number.isInteger(o['Size']) &&
    typeof o['LastModified'] === 'string' &&
    !Number.isNaN(Date.parse(o['LastModified']))
  );
}

/**
 * Objetos da saída JSON do `aws s3api list-objects-v2` (o CLI junta as
 * páginas em um só `Contents`). Prefixo sem objetos: saída vazia ou sem
 * `Contents`. Objeto malformado derruba a leitura: um Last-Modified
 * ilegível invalidaria a certificação da fonte.
 */
export function parseS3Listing(json: string): S3Object[] {
  if (json.trim() === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`listagem do S3 inválida: não é JSON (${(err as Error).message})`);
  }
  const contents = (raw as null | { Contents?: unknown })?.Contents;
  if (contents === undefined) return [];
  if (!Array.isArray(contents)) throw new Error('listagem do S3 inválida: `Contents` não é lista');
  return contents.map((o: unknown, i) => {
    if (!isListedObject(o)) throw new Error(`listagem do S3 inválida: objeto ${i} malformado`);
    return {
      etag: o.ETag.replace(/"/g, ''),
      key: o.Key,
      lastModified: new Date(o.LastModified).toISOString(),
      size: o.Size,
    };
  });
}

function partitionPath(p: PartitionRef): string {
  return `ano=${p.ano}/uf=${p.uf}/mes=${String(p.mes).padStart(2, '0')}`;
}

export function parquetKey(dataset: string, p: PartitionRef): string {
  return `${dataset}/${partitionPath(p)}/part.parquet`;
}

export function provenanceKey(dataset: string, p: PartitionRef): string {
  return `${dataset}/provenance/${partitionPath(p)}/part.provenance.json`;
}

const PARTITION_KEY =
  /^([^/]+)\/(provenance\/)?ano=(\d{4})\/uf=([A-Z]{2})\/mes=(\d{2})\/(part\.parquet|part\.provenance\.json)$/;

/** Parquet ou provenance de uma partição do dataset; `null` para qualquer outra chave. */
export function parsePartitionKey(
  key: string,
  dataset: string,
): null | (PartitionRef & { kind: 'parquet' | 'provenance' }) {
  const m = PARTITION_KEY.exec(key);
  if (!m || m[1] !== dataset) return null;
  const kind = m[2] === undefined ? 'parquet' : 'provenance';
  if ((kind === 'parquet') !== (m[6] === 'part.parquet')) return null;
  return { ano: Number(m[3]), kind, mes: Number(m[5]), uf: m[4]! };
}

/**
 * A proveniência retroativa só escreve `part.provenance.json` em
 * `<dataset>/provenance/`. Qualquer outra chave (Parquet, manifest, outro
 * dataset, caminho com `..`) é erro de programação: lança antes do upload.
 */
export function assertProvenanceUploadKey(key: string, dataset: string): void {
  const parsed = parsePartitionKey(key, dataset);
  if (parsed?.kind !== 'provenance' || key !== provenanceKey(dataset, parsed)) {
    throw new Error(`upload recusado: ${key} fora de ${dataset}/provenance/`);
  }
}

const md5 = (bytes: Uint8Array): Buffer => createHash('md5').update(bytes).digest();

/**
 * `true` quando `bytes` é o objeto com esse ETag: MD5 para upload simples;
 * MD5 dos MD5 das partes de `partSize` bytes mais `-N` para multipart.
 */
export function matchesS3Etag(
  etag: string,
  bytes: Uint8Array,
  partSize: number = AWS_CLI_PART_SIZE,
): boolean {
  const clean = etag.replace(/"/g, '');
  const m = /^([0-9a-f]{32})(?:-(\d+))?$/.exec(clean);
  if (!m) return false;
  if (m[2] === undefined) return md5(bytes).toString('hex') === m[1];
  const parts = Number(m[2]);
  if (Math.ceil(bytes.byteLength / partSize) !== parts) return false;
  const digests: Buffer[] = [];
  for (let i = 0; i < parts; i += 1) {
    digests.push(md5(bytes.subarray(i * partSize, (i + 1) * partSize)));
  }
  return md5(Buffer.concat(digests)).toString('hex') === m[1];
}
