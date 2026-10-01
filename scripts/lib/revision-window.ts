/**
 * Janela revisável do SIA-PA (issue #46).
 *
 * Pelas datas dos arquivos no FTP, cada publicação mensal do DATASUS
 * reescreve a competência mais recente e as 12 anteriores; depois disso a
 * competência deixa de mudar. O refresh reprocessa essa janela inteira
 * sempre que detecta uma publicação nova, em vez de confiar só no delta de
 * tamanho contra o state.
 */

/** Tamanho padrão da janela: a competência mais recente e as 12 anteriores. */
export const REVISION_WINDOW = 13;

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
