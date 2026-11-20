/**
 * Corpo do `part.provenance.json` e resolução dos DBCs-fonte de cada
 * partição.
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
 * Quais arquivos: os do registro que o archive grava ao lado do Parquet
 * (`part.sources.json`, ver `sources-record.ts`), conferidos contra o
 * cache. Sem registro a emissão falha, a menos que se peça explicitamente
 * a escolha pelo cache (`siaPaSourcesFromCache`), que não enxerga uma
 * variante final ausente do cache.
 *
 * DBC ausente ou ilegível derruba a emissão: nunca se grava `bytes: 0`.
 */

import {
  resolvePartitionFiles,
  siaPaBaseName,
  VARIANT_RANGE,
  VARIANT_SUFFIXES,
} from './dbc-source.js';
import {
  type RecordedSource,
  SOURCES_RECORD_FILE,
  SOURCES_RECORD_VERSION,
  type SourcesRecord,
} from './sources-record.js';

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

/** Partição de um dataset mensal por UF. */
export interface MonthPartition {
  ano: number;
  mes: number;
  uf: string;
}

function partitionLabel(p: MonthPartition): string {
  return `${p.uf} ${p.ano}-${String(p.mes).padStart(2, '0')}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Nomes que podem compor a partição: o canônico e as variantes (`VARIANT_SUFFIXES`). */
export function siaPaCandidateNames(uf: string, year: number, month: number): string[] {
  const base = siaPaBaseName(uf, year, month);
  return [`${base}.dbc`, ...VARIANT_SUFFIXES.map((suffix) => `${base}${suffix}.dbc`)];
}

/**
 * Descreve um DBC a partir do cache: tamanho igual ao listado, SHA-256
 * plausível (64 hex, nunca o de arquivo vazio) e mtime presente. Lança
 * `SourceProvenanceError` se algo não conferir. Também usado pela
 * proveniência retroativa (`provenance-catchup`).
 */
export function describeSource(
  cache: SourceCache,
  ftpPath: string,
  name: string,
  listed: number,
): SourceFile {
  let read: CachedFile;
  try {
    read = cache.read(name);
  } catch (err) {
    throw new SourceProvenanceError(`não foi possível ler ${name} no cache: ${errorMessage(err)}`);
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
    ftpPath,
    mtime: read.mtime,
    sha256: read.sha256,
  };
}

/** Um DBC → `source`; vários → `source: null` e `sources`, na ordem. */
export function toPartitionSources(described: SourceFile[]): PartitionSources {
  const [only] = described;
  if (described.length === 1 && only !== undefined) return { source: only };
  return { source: null, sources: described };
}

function invalidRecord(detail: string): SourceProvenanceError {
  return new SourceProvenanceError(`${SOURCES_RECORD_FILE} inválido: ${detail}`);
}

function isMonthPartition(x: unknown): x is MonthPartition {
  const p = x as null | Partial<MonthPartition>;
  return (
    typeof p === 'object' &&
    p !== null &&
    Number.isInteger(p.ano) &&
    Number.isInteger(p.mes) &&
    typeof p.uf === 'string'
  );
}

function isRecordedSource(x: unknown): x is RecordedSource {
  const s = x as null | Partial<RecordedSource>;
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.file === 'string' &&
    s.file !== '' &&
    typeof s.ftpPath === 'string' &&
    s.ftpPath.endsWith(`/${s.file}`) &&
    Number.isInteger(s.bytes) &&
    Number(s.bytes) > 0 &&
    typeof s.cacheMtime === 'string' &&
    s.cacheMtime !== '' &&
    (s.ftpMtime === null || typeof s.ftpMtime === 'string')
  );
}

/**
 * Lê o `part.sources.json` de uma partição. Lança `SourceProvenanceError`
 * se o conteúdo não tiver o formato que o archive grava ou se o registro
 * for de outra partição.
 */
export function parseSourcesRecord(text: string, partition: MonthPartition): SourcesRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalidRecord(`não é JSON (${errorMessage(err)})`);
  }
  const r = raw as null | Partial<Record<keyof SourcesRecord, unknown>>;
  if (r?.version !== SOURCES_RECORD_VERSION) {
    throw invalidRecord(`versão ${String(r?.version)}, esperada ${SOURCES_RECORD_VERSION}`);
  }
  if (!isMonthPartition(r.partition)) throw invalidRecord('`partition` ausente ou malformado');
  if (partitionLabel(r.partition) !== partitionLabel(partition)) {
    throw new SourceProvenanceError(
      `registro do archive é de ${partitionLabel(r.partition)}, não de ${partitionLabel(partition)}`,
    );
  }
  if (!Array.isArray(r.files) || r.files.length === 0) {
    throw invalidRecord('`files` vazio ou não é lista');
  }
  const files = r.files.map((item: unknown, i) => {
    if (!isRecordedSource(item)) throw invalidRecord(`item ${i} de \`files\` malformado`);
    return {
      bytes: item.bytes,
      cacheMtime: item.cacheMtime,
      file: item.file,
      ftpMtime: item.ftpMtime,
      ftpPath: item.ftpPath,
    };
  });
  return {
    files,
    partition: { ano: r.partition.ano, mes: r.partition.mes, uf: r.partition.uf },
    version: SOURCES_RECORD_VERSION,
  };
}

/**
 * DBCs-fonte a partir do registro do archive: exatamente os arquivos que
 * ele decodificou, na ordem dele. Cada um tem de estar no cache com o
 * tamanho e o mtime registrados; o SHA-256 é calculado do cache. Variantes
 * no cache que não estão no registro são ignoradas.
 */
export function sourcesFromRecord(cache: SourceCache, record: SourcesRecord): PartitionSources {
  const described = record.files.map((f) => {
    const size = cache.size(f.file);
    if (size === null) {
      throw new SourceProvenanceError(`${f.file} está no registro do archive mas não no cache`);
    }
    if (size === 0) {
      throw new SourceProvenanceError(
        `${f.file} tem 0 byte no cache (${f.bytes} no registro do archive)`,
      );
    }
    if (size !== f.bytes) {
      throw new SourceProvenanceError(
        `${f.file} tem ${size} bytes no cache, ${f.bytes} no registro do archive`,
      );
    }
    const described = describeSource(cache, f.ftpPath, f.file, f.bytes);
    if (described.mtime !== f.cacheMtime) {
      throw new SourceProvenanceError(
        `mtime de ${f.file} no cache (${described.mtime}) difere do registrado pelo archive ` +
          `(${f.cacheMtime}): o arquivo foi baixado de novo depois do archive`,
      );
    }
    return described;
  });
  return toPartitionSources(described);
}

/**
 * Escolha pelo cache, para partição sem registro do archive (Parquet
 * gerado antes do registro existir). Só com `--allow-cache-fallback`.
 *
 * Monta uma "listagem" com os candidatos presentes no cache e aplica a
 * mesma regra do archive (`resolvePartitionFiles`): o canônico se existir,
 * senão as variantes em ordem. Arquivos de 0 byte ficam de fora — são
 * sobras das sondagens 550 de antes da listagem, e DBC real nunca é vazio.
 *
 * Duas checagens de sanidade, porque o cache pode não ter tudo o que o
 * archive decodificou: as variantes têm de ser contíguas a partir de `a`
 * (`a`, `c` sem `b` falha) e uma variante sozinha, sem o canônico, falha
 * (o DATASUS só divide quando há mais de um arquivo). Uma variante final
 * ausente (`c` fora do cache, com `a` e `b` presentes) passa despercebida:
 * daqui não há como saber que ela existia.
 *
 * Lança `SourceProvenanceError` se não houver DBC não vazio, se a escolha
 * falhar numa das checagens, se um arquivo não puder ser lido ou se o
 * resultado da leitura não for plausível.
 */
export function siaPaSourcesFromCache(
  cache: SourceCache,
  ftpBase: string,
  uf: string,
  year: number,
  month: number,
): PartitionSources {
  const label = partitionLabel({ ano: year, mes: month, uf });
  const listing = new Map<string, number>();
  const empty: string[] = [];
  for (const name of siaPaCandidateNames(uf, year, month)) {
    const size = cache.size(name);
    if (size === null) continue;
    if (size > 0) listing.set(name, size);
    else empty.push(name);
  }

  const files = resolvePartitionFiles(listing, uf, year, month);
  const [first] = files;
  if (first === undefined) {
    const ignored = empty.length > 0 ? `; arquivos de 0 byte ignorados: ${empty.join(', ')}` : '';
    throw new SourceProvenanceError(
      `nenhum DBC-fonte em cache para ${label} (canônico + ${VARIANT_RANGE})${ignored}`,
    );
  }

  const base = siaPaBaseName(uf, year, month);
  const canonical = `${base}.dbc`;
  if (first.name !== canonical) {
    const names = files.map((f) => f.name);
    const expected = VARIANT_SUFFIXES.slice(0, names.length).map((s) => `${base}${s}.dbc`);
    const missing = expected.find((name, i) => names[i] !== name);
    if (missing !== undefined) {
      throw new SourceProvenanceError(
        `variantes não contíguas a partir de \`a\` no cache para ${label}: ` +
          `${names.join(', ')} (falta ${missing})`,
      );
    }
    if (names.length === 1) {
      throw new SourceProvenanceError(
        `só ${first.name} no cache para ${label}, sem o canônico ${canonical}: ` +
          'variante única indica que as outras não estão no cache',
      );
    }
  }

  return toPartitionSources(
    files.map((f) => describeSource(cache, `${ftpBase}/${f.name}`, f.name, f.size)),
  );
}

/**
 * DBCs-fonte de uma partição SIA-PA, com bytes e SHA-256 de cada um.
 *
 * Com `recordText` (conteúdo do `part.sources.json`), usa o registro do
 * archive — mesmo com `allowCacheFallback` — e confere que ele segue a
 * regra do archive para a partição (`resolvePartitionFiles`, no diretório
 * `ftpBase`). Sem registro, falha, a menos que `allowCacheFallback` peça a
 * escolha pelo cache; `fromCache` diz qual dos dois caminhos foi usado.
 */
export function siaPaPartitionSources(
  cache: SourceCache,
  ftpBase: string,
  partition: MonthPartition,
  recordText: null | string,
  options: { allowCacheFallback: boolean },
): { fromCache: boolean; sources: PartitionSources } {
  const label = partitionLabel(partition);
  const { ano, mes, uf } = partition;
  if (recordText !== null) {
    const record = parseSourcesRecord(recordText, partition);
    const listing = new Map(record.files.map((f) => [f.file, f.bytes]));
    const expected = resolvePartitionFiles(listing, uf, ano, mes).map(
      (f) => `${ftpBase}/${f.name}`,
    );
    const recorded = record.files.map((f) => f.ftpPath);
    if (expected.join('\n') !== recorded.join('\n')) {
      const names = record.files.map((f) => f.file).join(', ');
      throw new SourceProvenanceError(
        `registro do archive não corresponde à regra do archive para ${label}: ${names}`,
      );
    }
    return { fromCache: false, sources: sourcesFromRecord(cache, record) };
  }
  if (!options.allowCacheFallback) {
    throw new SourceProvenanceError(
      `sem ${SOURCES_RECORD_FILE} (registro do archive) para ${label}: rode o archive da ` +
        'partição de novo ou, para regerar provenance de partição já publicada, use ' +
        '--allow-cache-fallback (ver docs/provenance.md)',
    );
  }
  return { fromCache: true, sources: siaPaSourcesFromCache(cache, ftpBase, uf, ano, mes) };
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
