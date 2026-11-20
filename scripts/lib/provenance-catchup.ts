/**
 * Proveniência retroativa: `part.provenance.json` para partições SIA-PA já
 * publicadas que não têm provenance, ou que têm o do formato inválido de
 * antes de 19/11/2026, sem decodificar DBC e sem tocar no Parquet.
 *
 * Por partição, em ordem (do mais antigo ao mais novo):
 *   1. seleção — Parquet publicado sem provenance, ou com provenance legado
 *      (`isLegacyProvenanceSource`, o mesmo critério do `emit-provenance`).
 *      Provenance no formato atual é pulado (idempotente), e partição que o
 *      mesmo run do refresh está arquivando (`pending.json`) fica de fora;
 *   2. certificação da fonte — todo DBC da partição no FTP (agrupamento do
 *      `detect-new`) tem mtime pelo menos 24 h anterior ao Last-Modified do
 *      Parquet no S3 (o fuso do FTP é desconhecido), e a soma dos tamanhos é
 *      o `sourceSize` do state. Senão a partição é pulada com o motivo;
 *   3. orçamento — para antes da primeira partição cujo download de DBC
 *      estouraria o orçamento do run;
 *   4. (no script) hash dos DBCs e descrição do Parquet publicado, conferindo
 *      as linhas do Parquet com a soma dos `recordCount` dos cabeçalhos;
 *   5. corpo do provenance no formato atual, com o marcador `reconstructed`.
 *
 * Ver docs/provenance.md e docs/operations.md.
 */

import { type RemoteFile, resolvePartitionFiles } from './dbc-source.js';
import { isLegacyProvenanceSource } from './emit-partition.js';
import { type ListingGroup } from './ftp-groups.js';
import { isUnknownMtime } from './ftp-mtime.js';
import { type KnownEntry } from './pending-selection.js';
import { buildProvenance, type ProvenanceInput } from './provenance.js';
import { competencia } from './revision-window.js';
import { parsePartitionKey, provenanceKey, type S3Object } from './s3-objects.js';
import { partitionKey } from './verification.js';

/** Idade mínima do DBC no FTP em relação ao Parquet publicado (fuso do FTP desconhecido). */
export const MIN_SOURCE_AGE_HOURS = 24;

export const RECONSTRUCTION_NOTES =
  'Provenance reconstruído depois da publicação, sem decodificar os DBCs nem reescrever o ' +
  'Parquet. Os DBCs são os que o FTP publica no momento da reconstrução, certificados como ' +
  `anteriores ao Parquet: mtime no FTP pelo menos ${MIN_SOURCE_AGE_HOURS} h antes do ` +
  'Last-Modified do Parquet no S3, soma dos tamanhos igual à do state e soma dos recordCount ' +
  'dos cabeçalhos igual às linhas do Parquet. `pipeline` descreve o código da reconstrução, ' +
  'não o do archive que gerou o Parquet. Ver docs/provenance.md.';

export type PublishedState = 'atual' | 'ilegivel' | 'legado';

export type SkipReason =
  | 'ausente no FTP'
  | 'fonte reescrita depois do archive'
  | 'linhas diferentes do cabeçalho dos DBCs'
  | 'mtime do FTP ilegível'
  | 'sem entrada no state'
  | 'tamanho diferente do state';

/** Provenance legado substituído: o que ainda descreve quem gerou o Parquet. */
export interface PreviousProvenance {
  generatedAt: null | string;
  outputSha256: null | string;
  pipeline: null | Record<string, unknown>;
}

export interface PublishedPartition {
  ano: number;
  mes: number;
  parquet: S3Object;
  /** `listed`: a chave existe no S3; `text`: conteúdo lido (`null` se não foi possível). */
  provenance: { listed: boolean; text: null | string };
  uf: string;
}

export interface Candidate {
  ano: number;
  label: string;
  mes: number;
  parquet: S3Object;
  previous: null | PreviousProvenance;
  reason: 'ausente' | 'legado';
  uf: string;
}

export interface Selection {
  candidates: Candidate[];
  /** Já no formato atual: não há o que fazer. */
  current: string[];
  /** No `pending.json` do run: o refresh está (re)arquivando. */
  pending: string[];
  /** Provenance publicado que não é JSON legível: não é tocado. */
  unreadable: string[];
}

export interface Skipped {
  detail: string;
  label: string;
  reason: SkipReason;
}

export interface CertifiedCandidate extends Candidate {
  /** DBCs do archive (`resolvePartitionFiles`), na ordem de concatenação. */
  files: Array<RemoteFile & { ftpPath: string }>;
  ftpNewestMtime: string;
  stateSourceSize: number;
}

function labelOf(p: { ano: number; mes: number; uf: string }): string {
  return `${p.uf} ${competencia(p.ano, p.mes)}`;
}

function parseObject(text: string): null | Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function classifyBody(body: null | Record<string, unknown>): PublishedState {
  if (body === null) return 'ilegivel';
  return isLegacyProvenanceSource(body['source']) ? 'legado' : 'atual';
}

/** Situação de um `part.provenance.json` publicado. */
export function classifyPublished(text: string): PublishedState {
  return classifyBody(parseObject(text));
}

function previousProvenance(body: Record<string, unknown>): PreviousProvenance {
  const str = (v: unknown): null | string => (typeof v === 'string' ? v : null);
  const output = body['output'] as null | undefined | { sha256?: unknown };
  const pipeline = body['pipeline'];
  return {
    generatedAt: str(body['generatedAt']),
    outputSha256: str(output?.sha256),
    pipeline:
      typeof pipeline === 'object' && pipeline !== null
        ? (pipeline as Record<string, unknown>)
        : null,
  };
}

/** Partições com Parquet no S3; o provenance é lido só quando a chave existe. */
export function publishedPartitions(
  objects: readonly S3Object[],
  dataset: string,
  readProvenance: (key: string) => null | string,
): PublishedPartition[] {
  const keys = new Set(objects.map((o) => o.key));
  const out: PublishedPartition[] = [];
  for (const o of objects) {
    const parsed = parsePartitionKey(o.key, dataset);
    if (parsed?.kind !== 'parquet') continue;
    const p = { ano: parsed.ano, mes: parsed.mes, uf: parsed.uf };
    const key = provenanceKey(dataset, p);
    const listed = keys.has(key);
    out.push({
      ...p,
      parquet: o,
      provenance: { listed, text: listed ? readProvenance(key) : null },
    });
  }
  return out;
}

/** Candidatas do mais antigo ao mais novo (ano, mês, UF). */
export function selectCandidates(
  partitions: readonly PublishedPartition[],
  pendingKeys: ReadonlySet<string>,
): Selection {
  const sorted = [...partitions].sort(
    (a, b) => a.ano - b.ano || a.mes - b.mes || a.uf.localeCompare(b.uf),
  );
  const s: Selection = { candidates: [], current: [], pending: [], unreadable: [] };
  for (const p of sorted) {
    const label = labelOf(p);
    if (pendingKeys.has(partitionKey({ month: p.mes, uf: p.uf, year: p.ano }))) {
      s.pending.push(label);
      continue;
    }
    const base = { ano: p.ano, label, mes: p.mes, parquet: p.parquet, uf: p.uf };
    if (!p.provenance.listed) {
      s.candidates.push({ ...base, previous: null, reason: 'ausente' });
      continue;
    }
    const body = p.provenance.text === null ? null : parseObject(p.provenance.text);
    const state = classifyBody(body);
    if (state === 'atual') s.current.push(label);
    else if (state === 'ilegivel') s.unreadable.push(label);
    else s.candidates.push({ ...base, previous: previousProvenance(body!), reason: 'legado' });
  }
  return s;
}

type Certification = { certified: CertifiedCandidate; ok: true } | { ok: false; skipped: Skipped };

/**
 * Certifica que os DBCs que o FTP publica hoje são anteriores ao Parquet
 * publicado e do tamanho que o state registrou. A soma é a do grupo do
 * `detect-new` (o mesmo número do state); os arquivos descritos são os que o
 * archive escolheria (`resolvePartitionFiles`).
 */
export function certifySource(
  c: Candidate,
  group: ListingGroup | undefined,
  known: KnownEntry | undefined,
  ftpBase: string,
): Certification {
  const skip = (reason: SkipReason, detail: string): Certification => ({
    ok: false,
    skipped: { detail, label: c.label, reason },
  });
  if (group === undefined) return skip('ausente no FTP', 'nenhum DBC da partição na listagem');
  if (known === undefined) return skip('sem entrada no state', 'partição ausente do state');
  const limit = Date.parse(c.parquet.lastModified) - MIN_SOURCE_AGE_HOURS * 3600 * 1000;
  for (const v of group.variants) {
    if (isUnknownMtime(v.ftpMtime)) {
      return skip('mtime do FTP ilegível', `${v.name} sem mtime legível na listagem`);
    }
    if (v.mtime.getTime() > limit) {
      return skip(
        'fonte reescrita depois do archive',
        `${v.name} com mtime ${v.ftpMtime} no FTP; Parquet publicado em ` +
          `${c.parquet.lastModified} (exige ${MIN_SOURCE_AGE_HOURS} h antes)`,
      );
    }
  }
  if (group.size !== known.sourceSize) {
    return skip(
      'tamanho diferente do state',
      `${group.size} bytes no FTP, ${known.sourceSize} no state`,
    );
  }
  const listing = new Map(group.variants.map((v) => [v.name, v.ftpSize]));
  const files = resolvePartitionFiles(listing, c.uf, c.ano, c.mes);
  if (files.length === 0) {
    return skip('ausente no FTP', 'nenhum arquivo com o nome que o archive usa');
  }
  return {
    certified: {
      ...c,
      files: files.map((f) => ({ ...f, ftpPath: `${ftpBase}/${f.name}` })),
      ftpNewestMtime: group.mtime,
      stateSourceSize: known.sourceSize,
    },
    ok: true,
  };
}

/** Bytes a baixar: os arquivos que não estão no cache com o tamanho da listagem. */
export function bytesToDownload(
  files: readonly RemoteFile[],
  cachedSize: (name: string) => null | number,
): number {
  return files.reduce((sum, f) => (cachedSize(f.name) === f.size ? sum : sum + f.size), 0);
}

/** Linhas do Parquet contra a soma dos `recordCount` dos cabeçalhos dos DBCs. */
export function checkRecordCount(
  rows: number,
  counts: ReadonlyArray<null | number>,
): null | { detail: string; reason: SkipReason } {
  const reason = 'linhas diferentes do cabeçalho dos DBCs';
  if (counts.some((n) => n === null)) {
    return { detail: 'cabeçalho ilegível em DBC da partição', reason };
  }
  const total = counts.reduce<number>((sum, n) => sum + n!, 0);
  if (total === rows) return null;
  return { detail: `${rows} linhas no Parquet, ${total} nos cabeçalhos dos DBCs`, reason };
}

export type ProcessOutcome =
  | { detail: string; kind: 'pulado'; reason: SkipReason }
  | { kind: 'escrito'; uploaded: boolean };

export interface CatchupDeps {
  /** Bytes de DBC que a partição baixaria. */
  downloadBytes: (c: CertifiedCandidate) => number;
  /** Hash, descrição do Parquet, escrita e upload. Pode lançar. */
  process: (c: CertifiedCandidate) => Promise<ProcessOutcome>;
  /** Bytes de DBC efetivamente baixados até agora no run. */
  spentBytes: () => number;
}

export interface CatchupReport {
  /** Primeira partição que não coube no orçamento. */
  blockedBy: null | { label: string; needed: number };
  done: string[];
  failed: Array<{ label: string; message: string }>;
  remaining: string[];
  skipped: Skipped[];
  uploaded: number;
}

/**
 * Processa as certificadas em ordem. Para antes da primeira cujo download
 * passaria do orçamento (nunca o ultrapassa de propósito) e lista as
 * restantes. Falha numa partição é registrada e o run segue.
 */
export async function runCatchup(
  certified: readonly CertifiedCandidate[],
  budgetBytes: number,
  deps: CatchupDeps,
): Promise<CatchupReport> {
  const r: CatchupReport = {
    blockedBy: null,
    done: [],
    failed: [],
    remaining: [],
    skipped: [],
    uploaded: 0,
  };
  for (const [i, c] of certified.entries()) {
    const needed = deps.downloadBytes(c);
    if (deps.spentBytes() + needed > budgetBytes) {
      r.blockedBy = { label: c.label, needed };
      r.remaining = certified.slice(i).map((x) => x.label);
      break;
    }
    try {
      const outcome = await deps.process(c);
      if (outcome.kind === 'pulado') {
        r.skipped.push({ detail: outcome.detail, label: c.label, reason: outcome.reason });
      } else {
        r.done.push(c.label);
        if (outcome.uploaded) r.uploaded += 1;
      }
    } catch (err) {
      r.failed.push({ label: c.label, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return r;
}

/**
 * Corpo do provenance reconstruído: exatamente o do `emit-provenance`
 * (`buildProvenance`, mesma ordem de chaves, `source` ou `source: null` +
 * `sources`), mais o marcador `reconstructed` no fim.
 */
export function buildReconstructedProvenance(
  input: ProvenanceInput,
  c: CertifiedCandidate,
  dbcRecordCount: number,
): Record<string, unknown> {
  return {
    ...buildProvenance(input),
    reconstructed: {
      certification: {
        dbcRecordCount,
        ftpNewestMtime: c.ftpNewestMtime,
        minAgeHours: MIN_SOURCE_AGE_HOURS,
        parquetLastModified: c.parquet.lastModified,
        stateSourceSize: c.stateSourceSize,
      },
      notes: RECONSTRUCTION_NOTES,
      previous: c.previous,
      reason: c.reason,
    },
  };
}

const gb = (bytes: number): string =>
  `${(bytes / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 2, minimumFractionDigits: 1 })} GB`;

function table(header: string, rows: string[], limit = 50): string[] {
  if (rows.length === 0) return [];
  const extra = rows.length > limit ? ['', `… e mais ${rows.length - limit}.`] : [];
  return ['', header, ...rows.slice(0, limit), ...extra];
}

export interface CatchupSummary {
  budgetBytes: number;
  certificationSkipped: readonly Skipped[];
  downloadedBytes: number;
  dryRun: boolean;
  report: CatchupReport;
  selection: Selection;
}

/** Resumo para o `$GITHUB_STEP_SUMMARY`: emitidas, puladas com motivo, falhas e restantes. */
export function catchupMarkdown(s: CatchupSummary): string {
  const { report } = s;
  const skipped = [...s.certificationSkipped, ...report.skipped];
  const blocked =
    report.blockedBy !== null && report.blockedBy.needed > s.budgetBytes
      ? ` — ${report.blockedBy.label} precisa de ${gb(report.blockedBy.needed)}, mais que o ` +
        'orçamento inteiro: rode com orçamento maior'
      : '';
  const lines = [
    '## Proveniência retroativa',
    '',
    `- Modo: ${s.dryRun ? 'dry-run (nada sobe ao S3)' : 'publicação'}`,
    `- Orçamento: ${gb(s.budgetBytes)} de DBC; baixados: ${gb(s.downloadedBytes)}`,
    `- Emitidas: ${report.done.length} (${report.uploaded} enviadas ao S3)`,
    `- Puladas: ${skipped.length}`,
    `- Falharam: ${report.failed.length}`,
    `- Restantes (orçamento): ${report.remaining.length}${blocked}`,
    `- Já no formato atual: ${s.selection.current.length}`,
    `- Pendentes neste run (fora): ${s.selection.pending.length}`,
  ];
  const { unreadable } = s.selection;
  if (unreadable.length > 0) {
    const names = unreadable.slice(0, 20).join(', ');
    lines.push(`- Provenance publicado ilegível (não tocado): ${unreadable.length} — ${names}`);
  }
  lines.push(
    ...table(
      '### Puladas\n\n| Partição | Motivo | Detalhe |\n|---|---|---|',
      skipped.map((x) => `| ${x.label} | ${x.reason} | ${x.detail} |`),
    ),
    ...table(
      '### Falharam\n\n| Partição | Erro |\n|---|---|',
      report.failed.map((x) => `| ${x.label} | ${x.message.replace(/\s+/g, ' ')} |`),
    ),
    ...table(
      '### Emitidas\n\n| Partição |\n|---|',
      report.done.map((x) => `| ${x} |`),
    ),
  );
  return `${lines.join('\n')}\n`;
}
