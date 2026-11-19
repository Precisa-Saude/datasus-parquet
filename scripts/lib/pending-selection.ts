/**
 * Decide o que entra no `pending.json` (issue #46).
 *
 * Duas fontes:
 *   - delta contra o state: partição nova ou com tamanho/mtime diferente.
 *     O mtime só conta quando os dois lados o conhecem: entradas do state
 *     gravadas antes do parser de listagem DOS (`lib/ftp-mtime.ts`) têm
 *     epoch e são comparadas só por tamanho, exceto quando o mtime remoto
 *     é posterior ao marco de observação do state legado;
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

/** Maior competência (`AAAA-MM`) da lista, ou `null` se vazia. */
export function newestCompetencia(competencias: Iterable<string>): null | string {
  let newest: null | string = null;
  for (const c of competencias) if (newest === null || c > newest) newest = c;
  return newest;
}

/**
 * Competência da release do run: a mais recente entre as partições que o
 * run de fato publicou (`published`: verificadas contra o FTP e com
 * conteúdo diferente do já publicado), se for estritamente posterior a
 * `previousNewest`, a mais recente que o state conhecia antes do run
 * (`null` = state vazio). Caso contrário, `null`: sem release.
 *
 * Decide se o refresh cria a release (tag `dataset-<competência>`, DOI
 * Zenodo) e dispara o datasus-viz (PRE-607). Precisa olhar o que foi
 * publicado, não o que estava pendente: se todas as partições do mês novo
 * forem rejeitadas na verificação ou idênticas ao publicado e só um mês
 * antigo mudar, a release e o DOI permanente seriam de um mês cujos dados
 * não subiram. Um run que só republica meses antigos (reescrita do
 * DATASUS, entrada legada pega pelo `--legacy-since`) também não vira
 * release: a tag seria de um mês antigo, ocuparia a Latest e cunharia um
 * DOI, ou sobrescreveria a release que já tem essa tag.
 */
export function releaseCompetencia(
  published: Iterable<string>,
  previousNewest: null | string,
): null | string {
  const newest = newestCompetencia(published);
  if (newest === null) return null;
  return previousNewest === null || newest > previousNewest ? newest : null;
}

export function selectPending<G extends RemoteGroup>(
  groups: readonly G[],
  known: (uf: string, competencia: string) => KnownEntry | undefined,
  windowSize: number,
  legacySince: null | string = null,
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
    } else if (
      legacySince !== null &&
      isUnknownMtime(k.sourceMtime) &&
      !isUnknownMtime(g.mtime) &&
      new Date(g.mtime).getTime() >= new Date(legacySince).getTime()
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
