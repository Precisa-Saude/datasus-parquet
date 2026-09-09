/**
 * Peças puras que ligam o `detect-new` ao `archive-sia-pa`.
 *
 * Existem por causa do incidente de 2026-08-17: o workflow de refresh
 * chamava `archive-sia-pa` sem argumentos, caindo nos defaults
 * `--ufs AC --years 2024`, enquanto o `detect-new` reportava 324
 * competências pendentes. O archive gravava 12 partições de AC/2024 e o
 * `--mark-processed` seguinte marcava as 324 como processadas — o
 * estado passou a alegar cobertura até 2026-06 com o bucket parado em
 * 2026-02, e todo refresh posterior virou no-op.
 *
 * Ficam em `lib/` (e não nos scripts) porque os scripts executam
 * `main()` no import e não são testáveis diretamente.
 */
import { resolve } from 'node:path';

export interface Target {
  month: number;
  uf: string;
  year: number;
}

/** Subconjunto do `pending.json` que interessa para montar os alvos. */
export interface PendingTargetEntry {
  dataset: string;
  month: number;
  uf: string;
  year: number;
}

interface PendingFileShape {
  pending?: unknown;
}

function isValidEntry(value: unknown): value is PendingTargetEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['dataset'] === 'string' &&
    typeof e['uf'] === 'string' &&
    e['uf'] !== '' &&
    Number.isInteger(e['year']) &&
    Number.isInteger(e['month']) &&
    (e['month'] as number) >= 1 &&
    (e['month'] as number) <= 12
  );
}

export function sortTargets(targets: Target[]): Target[] {
  return [...targets].sort(
    (a, b) => a.year - b.year || a.uf.localeCompare(b.uf) || a.month - b.month,
  );
}

/**
 * Extrai as tuplas (UF, ano, mês) pendentes de um dataset a partir do
 * conteúdo bruto do `pending.json`.
 */
export function parsePendingTargets(raw: string, dataset: string): Target[] {
  let parsed: PendingFileShape;
  try {
    parsed = JSON.parse(raw) as PendingFileShape;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pending.json inválido: não é JSON (${msg})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('pending.json inválido: raiz não é um objeto');
  }
  const entries = parsed.pending ?? [];
  if (!Array.isArray(entries)) {
    throw new Error('pending.json inválido: `pending` não é uma lista');
  }
  const targets: Target[] = [];
  for (const [i, entry] of entries.entries()) {
    // Falha alto em vez de pular: uma entrada malformada viraria alvo
    // `undefined` e o archive gravaria partição inválida sem reclamar —
    // exatamente a classe de silêncio que este PR está corrigindo.
    if (!isValidEntry(entry)) {
      throw new Error(
        `pending.json inválido: entrada ${i} não tem {dataset, uf, year, month} válidos`,
      );
    }
    if (entry.dataset !== dataset) continue;
    targets.push({ month: entry.month, uf: entry.uf, year: entry.year });
  }
  return sortTargets(targets);
}

/**
 * Caminhos que provam que uma partição foi de fato arquivada: o Parquet
 * emitido, ou o marker que o watchdog cria quando o DBC de origem está
 * corrompido de forma irrecuperável.
 */
export function partitionArtifactPaths(
  buildDir: string,
  dataset: string,
  target: Target,
): { parquet: string; skippedMarker: string } {
  const mes = String(target.month).padStart(2, '0');
  const partitionDir = resolve(
    buildDir,
    dataset,
    `ano=${target.year}`,
    `uf=${target.uf}`,
    `mes=${mes}`,
  );
  return {
    parquet: resolve(partitionDir, 'part.parquet'),
    skippedMarker: resolve(partitionDir, 'part.parquet.skipped'),
  };
}
