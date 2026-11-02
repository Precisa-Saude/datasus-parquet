/**
 * Decide o que entra no `pending.json` (issue #46).
 *
 * Duas fontes:
 *   - delta contra o state: partição nova ou com tamanho/mtime diferente.
 *     O mtime só conta quando os dois lados o conhecem: entradas do state
 *     gravadas antes do parser de listagem DOS (`lib/ftp-mtime.ts`) têm
 *     epoch e são comparadas só por tamanho — senão o primeiro run depois
 *     da correção reprocessaria o dataset inteiro;
 *   - janela revisável (opcional, `--window N`): quando há qualquer delta,
 *     a competência mais recente e as anteriores dentro da janela entram
 *     inteiras, mesmo as que o state considera em dia. Era a rede de
 *     segurança enquanto o mtime não era lido; com tamanho + mtime o delta
 *     já cobre exatamente o que o DATASUS reescreveu.
 *
 * Sem delta nenhum, nada é reprocessado: o refresh semanal vira no-op entre
 * publicações.
 */
import { isUnknownMtime } from './ftp-mtime.js';
import { competencia, inWindow, windowStart } from './revision-window.js';

export interface RemoteGroup {
  month: number;
  /** mtime mais recente entre as variantes, em ISO. */
  mtime: string;
  /** Soma dos tamanhos das variantes. */
  size: number;
  uf: string;
  year: number;
}

export interface KnownEntry {
  sourceMtime: string;
  sourceSize: number;
}

export type PendingReason = 'alterado' | 'janela' | 'novo';

export interface Selection<G extends RemoteGroup> {
  group: G;
  reason: PendingReason;
}

export interface SelectionResult<G extends RemoteGroup> {
  latest: null | string;
  selected: Selection<G>[];
  windowStart: null | string;
}

/**
 * `true` quando o FTP difere do state. Tamanho sempre conta; mtime só
 * quando conhecido nos dois lados.
 */
export function hasChanged(known: KnownEntry, remote: RemoteGroup): boolean {
  if (known.sourceSize !== remote.size) return true;
  if (isUnknownMtime(known.sourceMtime) || isUnknownMtime(remote.mtime)) return false;
  return new Date(known.sourceMtime).getTime() !== new Date(remote.mtime).getTime();
}

export function selectPending<G extends RemoteGroup>(
  groups: readonly G[],
  known: (uf: string, competencia: string) => KnownEntry | undefined,
  windowSize: number,
): SelectionResult<G> {
  const delta = new Map<G, PendingReason>();
  let latest: null | string = null;
  for (const g of groups) {
    const comp = competencia(g.year, g.month);
    if (latest === null || comp > latest) latest = comp;
    const k = known(g.uf, comp);
    if (!k) {
      delta.set(g, 'novo');
    } else if (hasChanged(k, g)) {
      delta.set(g, 'alterado');
    }
  }

  const start = latest !== null && delta.size > 0 ? windowStart(latest, windowSize) : null;
  const selected: Selection<G>[] = [];
  for (const g of groups) {
    const reason = delta.get(g);
    if (reason) selected.push({ group: g, reason });
    else if (inWindow(g.year, g.month, start)) selected.push({ group: g, reason: 'janela' });
  }
  return { latest, selected, windowStart: start };
}
