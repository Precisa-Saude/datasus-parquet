/**
 * Corpo do `part.provenance.json` e resolução dos DBCs-fonte de cada
 * partição a partir do cache local.
 *
 * Alguns meses de UFs grandes não têm o DBC canônico `PA{UF}{AA}{MM}.dbc`:
 * o DATASUS publica `…a.dbc`, `…b.dbc` etc. (ver `resolvePartitionFiles`).
 * Até 19/11/2026 o provenance registrava só o nome canônico; nas partições
 * divididas o cache tinha um canônico de 0 byte (sobra das sondagens 550
 * antigas) e o provenance publicado saía com `bytes: 0` e o SHA-256 de
 * arquivo vazio — impossível de conferir contra o FTP.
 *
 * Formato (ver docs/provenance.md):
 *   - um DBC  → `source: {…}`, sem `sources` (idêntico ao de antes);
 *   - vários  → `source: null` e `sources: [{…}, …]`, na ordem em que o
 *     archive decodifica.
 *
 * DBC ausente ou ilegível derruba a emissão: nunca se grava `bytes: 0`.
 */

import { resolvePartitionFiles, siaPaBaseName, VARIANT_SUFFIXES } from './dbc-source.js';

/** SHA-256 de um arquivo de 0 byte — nunca é o hash de um DBC real. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const PIPELINE_NOTES = 'Conversão 1:1 DBC→Parquet, sem filtro, sem enriquecimento.';

/** O que se lê de um DBC no cache. */
export interface CachedFile {
  bytes: number;
  /** mtime do arquivo no cache, em ISO 8601. */
  mtime: string;
  sha256: string;
}

/** Acesso ao cache de DBCs, injetável para teste. */
export interface SourceCache {
  /** Lê o arquivo e calcula o SHA-256. Pode lançar (arquivo sumiu, permissão). */
  read(name: string): CachedFile;
  /** Tamanho em bytes no cache, ou `null` se o arquivo não existe. */
  size(name: string): null | number;
}

export interface SourceFile {
  bytes: number;
  file: string;
  ftpPath: string;
  mtime: string;
  sha256: string;
}

/**
 * `source` sozinho quando a partição vem de um DBC; `source: null` mais
 * `sources` quando vem de vários.
 */
export type PartitionSources = { source: null; sources: SourceFile[] } | { source: SourceFile };

export class SourceProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceProvenanceError';
  }
}

/** Nomes que podem compor a partição: o canônico e as variantes `a`–`e`. */
export function siaPaCandidateNames(uf: string, year: number, month: number): string[] {
  const base = siaPaBaseName(uf, year, month);
  return [`${base}.dbc`, ...VARIANT_SUFFIXES.map((suffix) => `${base}${suffix}.dbc`)];
}

function describeSource(
  cache: SourceCache,
  ftpBase: string,
  name: string,
  listed: number,
): SourceFile {
  let read: CachedFile;
  try {
    read = cache.read(name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SourceProvenanceError(`não foi possível ler ${name} no cache: ${msg}`);
  }
  if (read.bytes !== listed) {
    throw new SourceProvenanceError(
      `${name} mudou de tamanho no cache: ${listed} bytes listados, ${read.bytes} lidos`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(read.sha256) || read.sha256 === EMPTY_SHA256) {
    throw new SourceProvenanceError(`SHA-256 inválido para ${name}: '${read.sha256}'`);
  }
  if (read.mtime === '') {
    throw new SourceProvenanceError(`mtime ausente para ${name}`);
  }
  return {
    bytes: read.bytes,
    file: name,
    ftpPath: `${ftpBase}/${name}`,
    mtime: read.mtime,
    sha256: read.sha256,
  };
}

/**
 * DBCs-fonte de uma partição SIA-PA, com bytes e SHA-256 de cada um.
 *
 * Monta uma "listagem" com os candidatos presentes no cache e aplica a
 * mesma regra do archive (`resolvePartitionFiles`): o canônico se existir,
 * senão as variantes em ordem. Arquivos de 0 byte ficam de fora — são
 * sobras das sondagens 550 de antes da listagem, e DBC real nunca é vazio.
 * O archive confere o tamanho de cada DBC contra a listagem do FTP antes
 * de decodificar (`fetchVerified`), então o cache contém os bytes que ele
 * decodificou.
 *
 * Lança `SourceProvenanceError` se não houver DBC não vazio, se um deles
 * não puder ser lido ou se o resultado da leitura não for plausível.
 */
export function siaPaPartitionSources(
  cache: SourceCache,
  ftpBase: string,
  uf: string,
  year: number,
  month: number,
): PartitionSources {
  const listing = new Map<string, number>();
  const empty: string[] = [];
  for (const name of siaPaCandidateNames(uf, year, month)) {
    const size = cache.size(name);
    if (size === null) continue;
    if (size > 0) listing.set(name, size);
    else empty.push(name);
  }

  const files = resolvePartitionFiles(listing, uf, year, month);
  if (files.length === 0) {
    const mm = String(month).padStart(2, '0');
    const ignored = empty.length > 0 ? `; arquivos de 0 byte ignorados: ${empty.join(', ')}` : '';
    throw new SourceProvenanceError(
      `nenhum DBC-fonte em cache para ${uf} ${year}-${mm} (canônico + a-e)${ignored}`,
    );
  }

  const described = files.map((f) => describeSource(cache, ftpBase, f.name, f.size));
  const [only] = described;
  if (described.length === 1 && only !== undefined) return { source: only };
  return { source: null, sources: described };
}

export interface ProvenanceInput {
  dataset: string;
  generatedAt: string;
  output: {
    file: string;
    fingerprint: string;
    rows: number;
    schema: Array<{ name: string; type: string }>;
    sha256: string;
  };
  partition: { ano: number; mes: number; uf: string };
  pipeline: { archiveScript: string; datasusSdk: string; decoder: string };
  sources: PartitionSources;
}

/**
 * Corpo do provenance. A ordem das chaves é a do arquivo publicado e não
 * muda para partição de DBC único (o JSON sai byte-a-byte igual ao de
 * antes de `sources` existir).
 */
export function buildProvenance(input: ProvenanceInput): Record<string, unknown> {
  return {
    dataset: input.dataset,
    generatedAt: input.generatedAt,
    output: {
      columns: input.output.schema.length,
      file: input.output.file,
      fingerprint: input.output.fingerprint,
      rows: input.output.rows,
      schema: input.output.schema,
      sha256: input.output.sha256,
    },
    partition: { ano: input.partition.ano, mes: input.partition.mes, uf: input.partition.uf },
    pipeline: {
      archiveScript: input.pipeline.archiveScript,
      datasusSdk: input.pipeline.datasusSdk,
      decoder: input.pipeline.decoder,
      notes: PIPELINE_NOTES,
    },
    ...input.sources,
  };
}

export function serializeProvenance(body: Record<string, unknown>): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}
