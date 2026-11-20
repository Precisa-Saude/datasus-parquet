/**
 * Nome e versão dos pacotes que o pipeline registra em
 * `pipeline.datasusSdk` e `pipeline.decoder` do provenance.
 *
 * Até 19/11/2026 o `emit-provenance` procurava o SDK pelo nome antigo,
 * `@precisa-saude/datasus` (trocado por `@precisa-saude/datasus-sdk` em
 * 3d1867f); a busca caía no fallback e o provenance saía com
 * `@precisa-saude/datasus@unknown`. Agora o nome vem de
 * uma constante conferida contra as dependências do repositório (teste) e
 * pacote ausente ou `package.json` ilegível derruba a emissão: uma versão
 * desconhecida no provenance publicado não permite reproduzir o pipeline.
 *
 * Lê `node_modules/<pacote>/package.json` direto do disco porque os pacotes
 * não exportam `./package.json` (`require.resolve` falharia).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** SDK que baixa os DBCs do FTP (`download` no `archive-sia-pa`). */
export const DATASUS_SDK_PACKAGE = '@precisa-saude/datasus-sdk';

/** Decoder de DBC (`readDbcRecords` no `archive-sia-pa`). */
export const DBC_DECODER_PACKAGE = '@precisa-saude/datasus-dbc';

export interface PackageInfo {
  name: string;
  version: string;
}

export class PackageVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageVersionError';
  }
}

/**
 * Nome e versão do pacote `dep` instalado em `repoRoot`. Lança
 * `PackageVersionError` se ele não estiver instalado, se o `package.json`
 * não for JSON, for de outro pacote ou não tiver versão.
 */
export function readPackageVersion(repoRoot: string, dep: string): PackageInfo {
  const relativePath = join('node_modules', dep, 'package.json');
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) {
    throw new PackageVersionError(
      `${dep} não está instalado (${relativePath} ausente em ${repoRoot}); ` +
        'rode `pnpm install --frozen-lockfile`',
    );
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // `readFileSync` e `JSON.parse` só lançam `Error`.
    throw new PackageVersionError(`package.json de ${dep} ilegível: ${(err as Error).message}`);
  }
  const { name, version } = (pkg ?? {}) as Partial<Record<keyof PackageInfo, unknown>>;
  if (name !== dep) {
    throw new PackageVersionError(
      `package.json em ${join('node_modules', dep)} é de ${String(name)}, não de ${dep}`,
    );
  }
  if (typeof version !== 'string' || version === '') {
    throw new PackageVersionError(`package.json de ${dep} sem versão`);
  }
  return { name, version };
}

/** Campos `datasusSdk` e `decoder` do provenance, como `nome@versão`. */
export function pipelinePackages(repoRoot: string): { datasusSdk: string; decoder: string } {
  const sdk = readPackageVersion(repoRoot, DATASUS_SDK_PACKAGE);
  const decoder = readPackageVersion(repoRoot, DBC_DECODER_PACKAGE);
  return {
    datasusSdk: `${sdk.name}@${sdk.version}`,
    decoder: `${decoder.name}@${decoder.version}`,
  };
}
