/**
 * Ordem das escritas no fim de uma partição do `archive-sia-pa`.
 *
 * O `part.sources.json` é gravado ANTES do `part.parquet`. O archive pula
 * partição que já tem `part.parquet` não vazio e apaga o registro antes de
 * reprocessar; então uma queda entre as duas escritas deixa só o registro,
 * a partição é refeita no run seguinte e o registro é regravado. Na ordem
 * inversa, uma queda deixaria Parquet sem registro, que o archive pularia
 * para sempre.
 *
 * Montar ou gravar o registro (inclui o `stat` do DBC no cache) pode
 * falhar; isso é falha da partição, tratada pelo chamador como as de
 * decodificação (marker `.failed`, limpeza, segue para a próxima), e não
 * derruba o run.
 */

import { rmSync, writeFileSync } from 'node:fs';

import { SOURCES_RECORD_FILE } from './sources-record.js';

/** Grava o marker `.failed` da partição (inspeção, sem bloquear re-runs) e loga a falha. */
export function markFailed(
  marker: string,
  label: string,
  kind: string,
  context: string,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  writeFileSync(marker, `${new Date().toISOString()} ${label}\n${kind}\n${msg}\n`);
  process.stderr.write(`  ✗ FALHA ${label} ${context}: ${msg} (marker: ${marker})\n`);
}

export interface RecordFailurePaths {
  label: string;
  marker: string;
  ndjsonFile: string;
  sourcesRecordFile: string;
}

/** Falha ao montar ou gravar o registro: limpa NDJSON e registro e grava o marker. */
export function failRecord(paths: RecordFailurePaths, err: unknown): void {
  rmSync(paths.ndjsonFile, { force: true });
  rmSync(paths.sourcesRecordFile, { force: true });
  markFailed(paths.marker, paths.label, 'registro', `ao gravar ${SOURCES_RECORD_FILE}`, err);
}

export interface RecordThenParquetSteps {
  /** Monta o conteúdo do `part.sources.json`. Pode lançar. */
  buildRecord: () => string;
  /** Escreve o `part.parquet`. Erro aqui sobe, como antes. */
  writeParquet: () => Promise<void>;
  /** Grava o `part.sources.json`. Pode lançar. */
  writeRecord: (text: string) => void;
  /** Falha ao montar ou gravar o registro: marker `.failed` e limpeza. */
  onRecordFailure: (err: unknown) => void;
}

export async function writeRecordThenParquet(
  steps: RecordThenParquetSteps,
): Promise<'escrito' | 'falhou-registro'> {
  try {
    steps.writeRecord(steps.buildRecord());
  } catch (err) {
    steps.onRecordFailure(err);
    return 'falhou-registro';
  }
  await steps.writeParquet();
  return 'escrito';
}
