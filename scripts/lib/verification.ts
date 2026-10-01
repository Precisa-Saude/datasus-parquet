/**
 * Verificação das partições contra o FTP (issue #46).
 *
 * A fonte da contagem esperada é o cabeçalho de cada DBC lido direto do
 * FTP (12 bytes), nunca o cache local: em 2026-10-01 uma checagem que lia
 * a contagem dos mesmos arquivos em cache passaria, apesar de 19 partições
 * terem sido montadas a partir de DBCs híbridos (começo antigo, fim novo).
 */

/**
 * `recordCount` do cabeçalho DBF/DBC: uint32 little-endian nos bytes 4–7.
 * `null` se o buffer for curto demais para conter o cabeçalho.
 */
export function parseRecordCount(header: Uint8Array): null | number {
  if (header.byteLength < 8) return null;
  return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true);
}

export interface PartitionKey {
  month: number;
  uf: string;
  year: number;
}

export function partitionKey(p: PartitionKey): string {
  return `${p.uf}|${p.year}-${String(p.month).padStart(2, '0')}`;
}

export type VerificationStatus = 'divergente' | 'ftp-ilegivel' | 'ok' | 'sem-parquet';

export interface VerificationRow extends PartitionKey {
  ftpRows: null | number;
  rows: null | number;
  status: VerificationStatus;
}

/** Compara a contagem do parquet com a soma dos cabeçalhos das variantes. */
export function classify(rows: null | number, ftpRows: null | number): VerificationStatus {
  if (rows === null) return 'sem-parquet';
  if (ftpRows === null) return 'ftp-ilegivel';
  return rows === ftpRows ? 'ok' : 'divergente';
}

export interface VerifiedFile {
  generatedAt: string;
  rejected: VerificationRow[];
  verified: VerificationRow[];
}

/** Conjunto de chaves `UF|AAAA-MM` aprovadas num `_verified.json`. */
export function verifiedKeys(raw: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`_verified.json inválido: não é JSON (${msg})`);
  }
  const verified = (parsed as Partial<VerifiedFile> | null)?.verified;
  if (!Array.isArray(verified)) {
    throw new Error('_verified.json inválido: `verified` não é uma lista');
  }
  return new Set(verified.map((v) => partitionKey(v)));
}

/** Tabela markdown das partições rejeitadas, para o resumo do job ou uma issue. */
export function rejectedMarkdown(rows: readonly VerificationRow[], limit = 50): string {
  if (rows.length === 0) return 'Nenhuma partição rejeitada.';
  const fmt = (n: null | number): string => (n === null ? '—' : n.toLocaleString('pt-BR'));
  const lines = [
    '| UF | Competência | Linhas no parquet | recordCount no FTP | Situação |',
    '|---|---|---|---|---|',
    ...rows
      .slice(0, limit)
      .map(
        (r) =>
          `| ${r.uf} | ${r.year}-${String(r.month).padStart(2, '0')} | ${fmt(r.rows)} | ${fmt(r.ftpRows)} | ${r.status} |`,
      ),
  ];
  if (rows.length > limit) lines.push('', `… e mais ${rows.length - limit}.`);
  return lines.join('\n');
}
