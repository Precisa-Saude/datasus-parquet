/**
 * Diretório do cache de DBCs do `@precisa-saude/datasus-sdk`, com a mesma
 * regra do SDK (`XDG_CACHE_HOME` ou `~/.cache`). O archive e o
 * `emit-provenance` leem os DBCs dali; os dois precisam concordar.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function datasusCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const xdg = env['XDG_CACHE_HOME'];
  return xdg ? join(xdg, 'datasus-brasil') : join(home, '.cache', 'datasus-brasil');
}
