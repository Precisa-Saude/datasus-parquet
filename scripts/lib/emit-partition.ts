/**
 * Emissão do provenance de uma partição: decide entre escrever, falhar ou
 * deixar intacto o provenance que já está no diretório de saída.
 *
 * O `build/` do runner self-hosted sobrevive entre backfills
 * (docs/operations.md), então o `emit-provenance` encontra partições
 * arquivadas antes de o archive gravar `part.sources.json`. Sem registro e
 * sem `--allow-cache-fallback`, uma partição que já tem
 * `part.provenance.json` local fica como está — não é reescrita nem
 * apagada — e é informada como anterior ao registro. Sem registro e sem
 * provenance, a emissão falha como antes.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { type PartitionSources, serializeProvenance, SourceProvenanceError } from './provenance.js';

export interface PartitionEmission {
  allowCacheFallback: boolean;
  /** Corpo do provenance para os DBCs escolhidos (é aqui que se lê o Parquet). */
  buildBody: (sources: PartitionSources) => Promise<Record<string, unknown>>;
  /** `part.provenance.json` da partição no diretório de saída. */
  outPath: string;
  /** `part.sources.json` da partição, ao lado do Parquet. */
  recordPath: string;
  /** DBCs-fonte a partir do conteúdo do registro (`null` se não houver). */
  sourcesFor: (recordText: null | string) => { fromCache: boolean; sources: PartitionSources };
}

export type EmissionResult =
  | { fromCache: boolean; kind: 'escrito' }
  | { kind: 'anterior-ao-registro' }
  | { kind: 'falhou'; message: string };

export async function emitPartitionProvenance(e: PartitionEmission): Promise<EmissionResult> {
  const recordText = existsSync(e.recordPath) ? readFileSync(e.recordPath, 'utf8') : null;
  if (recordText === null && !e.allowCacheFallback && existsSync(e.outPath)) {
    return { kind: 'anterior-ao-registro' };
  }

  let chosen: ReturnType<PartitionEmission['sourcesFor']>;
  try {
    chosen = e.sourcesFor(recordText);
  } catch (err) {
    if (!(err instanceof SourceProvenanceError)) throw err;
    // Aqui o provenance local não descreve o Parquet atual (a partição tem
    // registro novo, ou o fallback foi pedido): não pode ficar para o upload.
    rmSync(e.outPath, { force: true });
    return { kind: 'falhou', message: err.message };
  }

  const body = await e.buildBody(chosen.sources);
  mkdirSync(dirname(e.outPath), { recursive: true });
  writeFileSync(e.outPath, serializeProvenance(body));
  return { fromCache: chosen.fromCache, kind: 'escrito' };
}
