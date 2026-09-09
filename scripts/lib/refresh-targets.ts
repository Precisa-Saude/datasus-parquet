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
  pending?: PendingTargetEntry[];
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
  const parsed = JSON.parse(raw) as PendingFileShape;
  const targets: Target[] = [];
  for (const entry of parsed.pending ?? []) {
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
