/**
 * mtime dos arquivos do FTP DATASUS.
 *
 * O servidor devolve listagem no formato DOS (`MM-DD-YY hh:mmAM`) e não
 * anuncia MLSD, então o `basic-ftp` deixa `modifiedAt` indefinido e só
 * preenche `rawModifiedAt`. Até 2026-11 o `detect-new` gravava 1970 em
 * todo o state e o delta era, na prática, só por tamanho: um arquivo
 * reescrito com o mesmo tamanho passava despercebido.
 *
 * O horário é lido como UTC sem conversão: o fuso do servidor não é
 * publicado e, para detectar mudança, basta que o valor seja estável
 * entre uma sondagem e outra.
 */

/** Marcador de mtime desconhecido no state (entradas anteriores a este parser). */
export const UNKNOWN_MTIME = new Date(0);

const DOS_MTIME = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(AM|PM)$/i;

/**
 * Converte `rawModifiedAt` de uma listagem DOS (`10-30-26 09:51PM`) em
 * `Date`. Devolve `null` para formato desconhecido ou data impossível.
 */
export function parseDosMtime(raw: string): Date | null {
  const m = DOS_MTIME.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = 2000 + Number(m[3]);
  let hour = Number(m[4]) % 12;
  const minute = Number(m[5]);
  if (m[6]!.toUpperCase() === 'PM') hour += 12;
  if (month < 1 || month > 12 || day < 1 || day > 31 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Rejeita 02-30 e afins: Date.UTC transborda para o mês seguinte.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** `true` quando o mtime é o marcador de desconhecido (epoch). */
export function isUnknownMtime(value: Date | string): boolean {
  const ms = typeof value === 'string' ? new Date(value).getTime() : value.getTime();
  return Number.isNaN(ms) || ms === 0;
}
