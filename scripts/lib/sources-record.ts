/**
 * Registro, feito pelo archive, dos DBCs que compõem cada partição:
 * `part.sources.json`, ao lado do `part.parquet`.
 *
 * O `emit-provenance` roda depois do archive e precisa saber de quais
 * arquivos o Parquet foi feito. O cache local não responde isso: uma
 * variante removida ou nunca baixada (por exemplo `…c.dbc` com `a` e `b`
 * presentes) faria o provenance listar menos arquivos do que os
 * decodificados, sem erro. O archive é o único que sabe, porque resolve
 * os arquivos pela listagem do FTP e decodifica exatamente essa lista;
 * por isso ele grava o registro, e o `emit-provenance` o exige.
 *
 * O registro é local: não vai para o S3 (exclusão no `aws s3 sync` dos
 * workflows `refresh.yml` e `backfill.yml`).
 */

import { type RemoteFile } from './dbc-source.js';

export const SOURCES_RECORD_FILE = 'part.sources.json';

export const SOURCES_RECORD_VERSION = 1;

export interface RecordedSource {
  /** Tamanho na listagem do FTP; o archive confere o download contra ele. */
  bytes: number;
  /**
   * mtime do arquivo no cache logo depois do archive (ISO 8601). O cache do
   * SDK guarda a hora do download, não a do FTP; se mudar, o arquivo foi
   * baixado de novo depois do archive.
   */
  cacheMtime: string;
  file: string;
  /** mtime na listagem do FTP (ISO 8601), ou `null` quando ilegível. */
  ftpMtime: null | string;
  ftpPath: string;
}

export interface SourcesRecord {
  /** Na ordem em que o archive decodificou. */
  files: RecordedSource[];
  partition: { ano: number; mes: number; uf: string };
  version: typeof SOURCES_RECORD_VERSION;
}

export interface SourcesRecordInput {
  /** mtime atual do arquivo no cache, em ISO 8601. */
  cacheMtime: (name: string) => string;
  /** Arquivos decodificados, na ordem de `resolvePartitionFiles`. */
  files: readonly RemoteFile[];
  ftpBase: string;
  /** Nome → mtime da listagem do FTP; ausente ou `null` quando ilegível. */
  ftpMtimes: ReadonlyMap<string, null | string>;
  partition: { ano: number; mes: number; uf: string };
}

export function buildSourcesRecord(input: SourcesRecordInput): SourcesRecord {
  return {
    files: input.files.map((f) => ({
      bytes: f.size,
      cacheMtime: input.cacheMtime(f.name),
      file: f.name,
      ftpMtime: input.ftpMtimes.get(f.name) ?? null,
      ftpPath: `${input.ftpBase}/${f.name}`,
    })),
    partition: { ano: input.partition.ano, mes: input.partition.mes, uf: input.partition.uf },
    version: SOURCES_RECORD_VERSION,
  };
}

export function serializeSourcesRecord(record: SourcesRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
