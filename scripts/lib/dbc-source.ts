/**
 * Resolução e verificação dos DBCs de uma partição SIA-PA contra a
 * listagem do FTP.
 *
 * O cache de download do SDK reusa o arquivo pelo caminho, sem conferir
 * se ele ainda bate com o FTP. Isso já fez o pipeline decodificar (a) a
 * versão anterior de um arquivo republicado pelo DATASUS, (b) variantes
 * `a`/`b`/`c` de versões diferentes misturadas no mesmo mês e (c) um
 * download truncado por timeout, que travou o decoder em laço por horas
 * (issue #43). Comparar o tamanho em bytes com a listagem antes de
 * decodificar fecha as três portas.
 */

export interface RemoteFile {
  name: string;
  size: number;
}

export const VARIANT_SUFFIXES = ['a', 'b', 'c', 'd', 'e'] as const;

/** `PA{UF}{AA}{MM}` — prefixo comum ao arquivo canônico e às variantes. */
export function siaPaBaseName(uf: string, year: number, month: number): string {
  const yy = String(year % 100).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  return `PA${uf}${yy}${mm}`;
}

/**
 * Arquivos que compõem a partição, segundo a listagem do FTP: o canônico
 * `PA{UF}{AA}{MM}.dbc` quando existe; senão as variantes `a`–`e`
 * presentes, em ordem. Lista vazia quando o mês não foi publicado.
 *
 * Usar a listagem em vez de sondar 550 evita os arquivos de 0 byte que
 * as tentativas frustradas deixavam no cache.
 */
export function resolvePartitionFiles(
  listing: ReadonlyMap<string, number>,
  uf: string,
  year: number,
  month: number,
): RemoteFile[] {
  const base = siaPaBaseName(uf, year, month);
  const canonical = `${base}.dbc`;
  const canonicalSize = listing.get(canonical);
  if (canonicalSize !== undefined) return [{ name: canonical, size: canonicalSize }];

  const files: RemoteFile[] = [];
  for (const suffix of VARIANT_SUFFIXES) {
    const name = `${base}${suffix}.dbc`;
    const size = listing.get(name);
    if (size !== undefined) files.push({ name, size });
  }
  return files;
}

export class SizeMismatchError extends Error {
  readonly actual: number;
  readonly expected: number;
  readonly file: string;

  constructor(file: string, expected: number, actual: number) {
    super(
      `tamanho divergente em ${file}: ${actual} bytes baixados, ${expected} na listagem do FTP`,
    );
    this.name = 'SizeMismatchError';
    this.file = file;
    this.expected = expected;
    this.actual = actual;
  }
}

export function checkSize(file: RemoteFile, bytes: Uint8Array): void {
  if (bytes.byteLength !== file.size) {
    throw new SizeMismatchError(file.name, file.size, bytes.byteLength);
  }
}

export type DownloadFn = (options: { forceRefresh?: boolean; path: string }) => Promise<Uint8Array>;

/**
 * Baixa (ou lê do cache) e confere o tamanho. Se divergir, força um
 * download novo — o caso típico é cópia antiga ou truncada no cache. Se
 * ainda divergir, lança `SizeMismatchError` para o retry de transporte do
 * chamador tratar.
 */
export async function fetchVerified(
  file: RemoteFile,
  dir: string,
  download: DownloadFn,
): Promise<Uint8Array> {
  const path = `${dir}/${file.name}`;
  const bytes = await download({ path });
  if (bytes.byteLength === file.size) return bytes;
  const fresh = await download({ forceRefresh: true, path });
  checkSize(file, fresh);
  return fresh;
}
