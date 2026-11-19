/**
 * Emissão do provenance de uma partição: decide entre escrever, falhar ou
 * deixar intacto o provenance que já está no diretório de saída.
 *
 * O `build/` do runner self-hosted sobrevive entre backfills
 * (docs/operations.md), então o `emit-provenance` encontra partições
 * arquivadas antes de o archive gravar `part.sources.json`. Sem registro e
 * sem `--allow-cache-fallback`, uma partição que já tem
 * `part.provenance.json` local fica como está — não é reescrita nem
 * apagada — e é informada como anterior ao registro, desde que o
 * `output.sha256` dele seja o SHA-256 do `part.parquet` atual. Se não for
 * (ou se o arquivo não puder ser lido), ele é de outro Parquet: é apagado e
 * a partição falha. Provenance mantido no formato inválido de antes de
 * 19/11/2026 (`source` de 0 byte ou sem SHA-256 válido) é marcado como
 * legado, para o aviso pedir a regeração. Sem registro e sem provenance, a
 * emissão falha como antes.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  EMPTY_SHA256,
  type PartitionSources,
  serializeProvenance,
  SourceProvenanceError,
} from './provenance.js';
import { SOURCES_RECORD_FILE } from './sources-record.js';

export interface PartitionEmission {
  allowCacheFallback: boolean;
  /** Corpo do provenance para os DBCs escolhidos (é aqui que se lê o Parquet). */
  buildBody: (sources: PartitionSources) => Promise<Record<string, unknown>>;
  /** `part.provenance.json` da partição no diretório de saída. */
  outPath: string;
  /** SHA-256 do `part.parquet` atual (só calculado para conferir provenance mantido). */
  parquetSha256: () => string;
  /** `part.sources.json` da partição, ao lado do Parquet. */
  recordPath: string;
  /** DBCs-fonte a partir do conteúdo do registro (`null` se não houver). */
  sourcesFor: (recordText: null | string) => { fromCache: boolean; sources: PartitionSources };
}

export type EmissionResult =
  | { fromCache: boolean; kind: 'escrito' }
  | { kind: 'anterior-ao-registro'; legacy: boolean }
  | { kind: 'falhou'; message: string };

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Confere um provenance local que seria mantido sem registro: tem de ser
 * JSON com `output.sha256` igual ao SHA-256 do Parquet atual. `legacy`
 * marca o formato inválido de antes de 19/11/2026: `source` presente mas
 * com 0 byte, sem SHA-256 válido ou com o SHA-256 de arquivo vazio
 * (`source: null`, o formato atual de partição dividida, não é legado).
 */
export function assessKeptProvenance(
  text: string,
  parquetSha: string,
): { legacy: boolean; ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `não é JSON (${errorMessage(err)})` };
  }
  const body = parsed as null | { output?: { sha256?: unknown }; source?: unknown };
  const outputSha = body?.output?.sha256;
  if (typeof outputSha !== 'string') return { ok: false, reason: 'sem output.sha256' };
  if (outputSha !== parquetSha) {
    return { ok: false, reason: `output.sha256 ${outputSha}, Parquet ${parquetSha}` };
  }
  const source = body?.source as null | undefined | { bytes?: unknown; sha256?: unknown };
  if (source === null) return { legacy: false, ok: true };
  const sha = source?.sha256;
  const legacy =
    source?.bytes === 0 || typeof sha !== 'string' || !SHA256.test(sha) || sha === EMPTY_SHA256;
  return { legacy, ok: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stale(outPath: string, reason: string): EmissionResult {
  // O provenance local não descreve o Parquet atual: não pode ficar para o upload.
  rmSync(outPath, { force: true });
  return { kind: 'falhou', message: reason };
}

export async function emitPartitionProvenance(e: PartitionEmission): Promise<EmissionResult> {
  const recordText = existsSync(e.recordPath) ? readFileSync(e.recordPath, 'utf8') : null;
  if (recordText === null && !e.allowCacheFallback && existsSync(e.outPath)) {
    let kept: ReturnType<typeof assessKeptProvenance>;
    try {
      kept = assessKeptProvenance(readFileSync(e.outPath, 'utf8'), e.parquetSha256());
    } catch (err) {
      kept = { ok: false, reason: `ilegível (${errorMessage(err)})` };
    }
    if (kept.ok) return { kind: 'anterior-ao-registro', legacy: kept.legacy };
    return stale(
      e.outPath,
      `provenance local sem ${SOURCES_RECORD_FILE} não descreve o Parquet atual: ` +
        `${kept.reason}. Foi apagado; rode o archive da partição de novo ou use ` +
        '--allow-cache-fallback (ver docs/provenance.md)',
    );
  }

  let chosen: ReturnType<PartitionEmission['sourcesFor']>;
  try {
    chosen = e.sourcesFor(recordText);
  } catch (err) {
    if (!(err instanceof SourceProvenanceError)) throw err;
    // A partição tem registro novo, ou o fallback foi pedido: o provenance
    // local, se houver, é de outra emissão.
    return stale(e.outPath, err.message);
  }

  const body = await e.buildBody(chosen.sources);
  mkdirSync(dirname(e.outPath), { recursive: true });
  writeFileSync(e.outPath, serializeProvenance(body));
  return { fromCache: chosen.fromCache, kind: 'escrito' };
}
