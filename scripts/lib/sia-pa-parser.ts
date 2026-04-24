/**
 * Parser puro do nome de arquivo SIA-PA do FTP DATASUS.
 *
 * Formato: `PA{UF}{YY}{MM}{variant?}.dbc` (ex.: `PAAC2401.dbc`,
 * `PASP2403a.dbc`). `variant` é `''` para o canônico ou uma letra para
 * arquivos split (SP, MG, RJ quando o DBC excede o limite do formato).
 *
 * Extraído de `scripts/detect-new.ts` pra permitir teste unitário sem
 * depender de IO (FTP/filesystem).
 */

export const SIA_PA_REGEX = /^PA([A-Z]{2})(\d{2})(\d{2})([a-z]?)\.dbc$/i;

export interface SiaPaFileName {
  month: number;
  uf: string;
  variant: string;
  year: number;
}

export function parseSiaPaFileName(name: string): null | SiaPaFileName {
  const m = SIA_PA_REGEX.exec(name);
  if (!m) return null;
  const month = Number(m[3]);
  if (month < 1 || month > 12) return null;
  return {
    month,
    uf: m[1]!.toUpperCase(),
    variant: (m[4] ?? '').toLowerCase(),
    year: 2000 + Number(m[2]),
  };
}
