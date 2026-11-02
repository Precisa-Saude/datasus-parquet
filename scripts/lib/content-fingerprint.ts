/**
 * Impressão digital do conteúdo de uma partição (as linhas, não os bytes).
 *
 * Por que não o SHA256 do Parquet: o mesmo conteúdo decodificado produz
 * Parquet com bytes diferentes entre ambientes (versão do DuckDB, ordem
 * dos empates no `ORDER BY`). Em 2026-11-02, o AC 2025-09 publicado
 * (1.311.943 bytes) e o re-decodificado localmente (1.299.728 bytes)
 * tinham as mesmas 173.845 linhas e somas idênticas.
 *
 * Por que não o tamanho/mtime do DBC: o DATASUS re-exporta DBCs sem mudar
 * o conteúdo (o mesmo AC 2025-09 encolheu de 4.932.873 para 4.472.719
 * bytes com conteúdo idêntico).
 *
 * A impressão é independente da ordem das linhas e estável entre versões
 * do DuckDB: md5 do JSON de cada linha, combinado por soma (metade baixa)
 * e XOR (metade alta), mais a contagem. Linhas duplicadas — comuns no
 * BPA — não se cancelam porque a soma as conta.
 */

export const FINGERPRINT_VERSION = 'v1';

export interface FingerprintRow {
  /** `count(*)` como texto (BIGINT vem como bigint ou string do driver). */
  n: bigint | number | string;
  /** Soma das metades baixas do md5, em hexadecimal. */
  s: string;
  /** XOR das metades altas do md5, em hexadecimal. */
  x: string;
}

/** SQL que produz uma `FingerprintRow` para o Parquet em `file`. */
export function fingerprintSql(file: string): string {
  const escaped = file.replace(/'/g, "''");
  return (
    'SELECT count(*)::VARCHAR AS n, ' +
    'to_hex(sum(md5_number_lower(to_json(t)::VARCHAR)::HUGEINT)::HUGEINT) AS s, ' +
    'to_hex(bit_xor(md5_number_upper(to_json(t)::VARCHAR))) AS x ' +
    `FROM read_parquet('${escaped}') t`
  );
}

/** `v1:<linhas>:<soma>:<xor>`; partição vazia tem soma e xor vazios. */
export function formatFingerprint(row: FingerprintRow): string {
  const n = String(row.n);
  if (!/^\d+$/.test(n)) throw new Error(`contagem inválida na impressão: '${n}'`);
  return `${FINGERPRINT_VERSION}:${n}:${(row.s ?? '').toUpperCase()}:${(row.x ?? '').toUpperCase()}`;
}

/**
 * `output.fingerprint` de um `part.provenance.json` publicado, ou `null`
 * se o arquivo não tiver (provenance anterior a esta versão) ou for
 * ilegível. Sem impressão publicada, a partição conta como alterada.
 */
export function publishedFingerprint(raw: null | string | undefined): null | string {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const output = (parsed as { output?: { fingerprint?: unknown } } | null)?.output;
  const fp = output?.fingerprint;
  return typeof fp === 'string' && fp.startsWith(`${FINGERPRINT_VERSION}:`) ? fp : null;
}

/** `true` quando a impressão local é idêntica à publicada. */
export function isUnchanged(local: string, published: null | string): boolean {
  return published !== null && local === published;
}

export interface UnchangedRow {
  fingerprint: string;
  month: number;
  /** `generatedAt` do provenance publicado que já descreve esse conteúdo. */
  publishedAt: null | string;
  uf: string;
  year: number;
}

/** Tabela markdown das partições puladas, para o resumo do job. */
export function unchangedMarkdown(rows: readonly UnchangedRow[], limit = 50): string {
  if (rows.length === 0) return 'Nenhuma partição com conteúdo idêntico ao publicado.';
  const lines = [
    '| UF | Competência | Linhas | Publicada em |',
    '|---|---|---|---|',
    ...rows
      .slice(0, limit)
      .map(
        (r) =>
          `| ${r.uf} | ${r.year}-${String(r.month).padStart(2, '0')} | ${Number(r.fingerprint.split(':')[1]).toLocaleString('pt-BR')} | ${r.publishedAt ?? '—'} |`,
      ),
  ];
  if (rows.length > limit) lines.push('', `… e mais ${rows.length - limit}.`);
  return lines.join('\n');
}
