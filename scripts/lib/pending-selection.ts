/**
 * Decide o que entra no `pending.json` (issue #46).
 *
 * Duas fontes:
 *   - delta contra o state: partição nova ou com tamanho/mtime diferente;
 *   - janela revisável: quando há qualquer delta (sinal de que o DATASUS
 *     publicou), a competência mais recente e as anteriores dentro da
 *     janela entram inteiras, mesmo as que o state considera em dia — a
 *     publicação reescreve todas elas, e o state já errou antes.
 *
 * Sem delta nenhum, nada é reprocessado: o refresh semanal vira no-op entre
 * publicações, e o custo fica em uma janela por mês.
 */
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
    } else if (
      k.sourceSize !== g.size ||
      new Date(k.sourceMtime).getTime() !== new Date(g.mtime).getTime()
    ) {
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
