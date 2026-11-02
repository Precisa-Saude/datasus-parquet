/**
 * Janela revisável do SIA-PA (issue #46).
 *
 * Pelas datas dos arquivos no FTP, cada publicação mensal do DATASUS
 * reescreve a competência mais recente e as 11 anteriores (12 ao todo; na
 * publicação de 2026-10-30, 2025-09..2026-08 ganharam mtime novo e
 * 2025-08 ficou como estava); depois disso a competência deixa de mudar.
 *
 * A janela era a rede de segurança enquanto o `detect-new` não lia o mtime
 * do FTP. Com tamanho + mtime no delta ela é opcional (`--window N`) e o
 * `refresh.yml` não a usa mais.
 */

/** Tamanho observado da reescrita: a competência mais recente e as 11 anteriores. */
export const REVISION_WINDOW = 12;

/** `AAAA-MM` a partir de ano e mês. */
export function competencia(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Primeira competência da janela que termina em `latest` (`AAAA-MM`) e tem
 * `size` competências. `size` 0 ou negativo desliga a janela (`null`).
 */
export function windowStart(latest: string, size: number): null | string {
  if (size <= 0) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(latest);
  if (!match) throw new Error(`competência inválida: '${latest}' (esperado AAAA-MM)`);
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) - (size - 1);
  return competencia(Math.floor(total / 12), (total % 12) + 1);
}

/** `true` quando a competência está dentro da janela que começa em `start`. */
export function inWindow(year: number, month: number, start: null | string): boolean {
  return start !== null && competencia(year, month) >= start;
}
