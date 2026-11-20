/**
 * Agrupamento da listagem do FTP por partição (UF, ano, mês).
 *
 * Extraído do `detect-new` para que a proveniência retroativa
 * (`provenance-catchup`) enxergue a partição exatamente como o `detect-new`
 * a vê ao comparar com o state: todas as variantes do mês juntas, em ordem,
 * com a soma dos tamanhos (o `sourceSize` do state) e o mtime mais recente.
 */

import { UNKNOWN_MTIME } from './ftp-mtime.js';

/** Arquivo da listagem do FTP (`type === 1` no `basic-ftp`). */
export interface ListedFile {
  mtime: Date;
  name: string;
  size: number;
}

export interface GroupedVariant {
  ftpMtime: string;
  ftpPath: string;
  ftpSize: number;
  mtime: Date;
  name: string;
  /** `''` para o canônico; `'a'`, `'b'`… para as variantes. */
  suffix: string;
}

export interface ListingGroup {
  month: number;
  /** mtime mais recente entre as variantes, em ISO. */
  mtime: string;
  /** Soma dos tamanhos das variantes — comparada com `sourceSize` do state. */
  size: number;
  uf: string;
  variants: GroupedVariant[];
  year: number;
}

export interface ListingConfig {
  dir: string;
  fileRegex: RegExp;
  parseName: (name: string) => null | { month: number; uf: string; variant: string; year: number };
}

export function groupListing(remote: readonly ListedFile[], cfg: ListingConfig): ListingGroup[] {
  const groups = new Map<
    string,
    { month: number; uf: string; variants: GroupedVariant[]; year: number }
  >();
  for (const entry of remote) {
    if (!cfg.fileRegex.test(entry.name)) continue;
    const parsed = cfg.parseName(entry.name);
    if (!parsed) continue;
    const key = `${parsed.uf}|${parsed.year}|${parsed.month}`;
    const bucket = groups.get(key) ?? {
      month: parsed.month,
      uf: parsed.uf,
      variants: [],
      year: parsed.year,
    };
    bucket.variants.push({
      ftpMtime: entry.mtime.toISOString(),
      ftpPath: `${cfg.dir}/${entry.name}`,
      ftpSize: entry.size,
      mtime: entry.mtime,
      name: entry.name,
      suffix: parsed.variant,
    });
    groups.set(key, bucket);
  }

  return [...groups.values()].map((group) => {
    group.variants.sort((a, b) => a.suffix.localeCompare(b.suffix));
    const latestMtime = group.variants.reduce(
      (latest, v) => (v.mtime.getTime() > latest.getTime() ? v.mtime : latest),
      new Date(0),
    );
    return {
      ...group,
      mtime: latestMtime.toISOString(),
      size: group.variants.reduce((sum, v) => sum + v.ftpSize, 0),
    };
  });
}

function isListedEntry(x: unknown): x is { mtime: null | string; name: string; size: number } {
  const e = x as null | Record<string, unknown>;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e['name'] === 'string' &&
    Number.isInteger(e['size']) &&
    (e['size'] as number) >= 0 &&
    (e['mtime'] === null ||
      (typeof e['mtime'] === 'string' && !Number.isNaN(Date.parse(e['mtime']))))
  );
}

/**
 * Listagem salva em arquivo (`[{ name, size, mtime }]`, `mtime` ISO ou
 * `null`), para rodar a proveniência retroativa sem acessar o FTP (testes,
 * dry-run local). `null` vira o marcador de mtime desconhecido.
 */
export function parseListingFile(text: string): ListedFile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`listagem do FTP inválida: não é JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(raw)) throw new Error('listagem do FTP inválida: não é uma lista');
  return raw.map((item: unknown, i) => {
    if (!isListedEntry(item)) throw new Error(`listagem do FTP inválida: item ${i} malformado`);
    return {
      mtime: item.mtime === null ? UNKNOWN_MTIME : new Date(item.mtime),
      name: item.name,
      size: item.size,
    };
  });
}
