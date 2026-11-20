import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DATASUS_SDK_PACKAGE,
  DBC_DECODER_PACKAGE,
  PackageVersionError,
  pipelinePackages,
  readPackageVersion,
} from '../lib/package-version.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function installedVersion(dep: string): string {
  const path = join(REPO_ROOT, 'node_modules', dep, 'package.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

/** Repositório falso com `node_modules/<dep>/package.json` = `pkg`. */
function repoWith(dep: string, pkg: string): string {
  const root = mkdtempSync(join(tmpdir(), 'package-version-'));
  mkdirSync(join(root, 'node_modules', dep), { recursive: true });
  writeFileSync(join(root, 'node_modules', dep, 'package.json'), pkg);
  return root;
}

describe('pacotes registrados no provenance', () => {
  it('são dependências declaradas do repositório (o SDK é `@precisa-saude/datasus-sdk`)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(DATASUS_SDK_PACKAGE).toBe('@precisa-saude/datasus-sdk');
    expect(Object.keys(pkg.dependencies)).toContain(DATASUS_SDK_PACKAGE);
    expect(Object.keys(pkg.dependencies)).toContain(DBC_DECODER_PACKAGE);
  });
});

describe('pipelinePackages', () => {
  it('registra o nome e a versão instalados do SDK e do decoder', () => {
    expect(pipelinePackages(REPO_ROOT)).toEqual({
      datasusSdk: `@precisa-saude/datasus-sdk@${installedVersion(DATASUS_SDK_PACKAGE)}`,
      decoder: `@precisa-saude/datasus-dbc@${installedVersion(DBC_DECODER_PACKAGE)}`,
    });
  });

  it('nunca registra `unknown`', () => {
    expect(JSON.stringify(pipelinePackages(REPO_ROOT))).not.toContain('unknown');
  });

  it('falha, em vez de registrar `unknown`, quando o SDK não está instalado', () => {
    const root = repoWith(
      DBC_DECODER_PACKAGE,
      '{"name":"@precisa-saude/datasus-dbc","version":"2.0.4"}',
    );
    expect(() => pipelinePackages(root)).toThrow(PackageVersionError);
    expect(() => pipelinePackages(root)).toThrow(
      /@precisa-saude\/datasus-sdk não está instalado .*node_modules\/@precisa-saude\/datasus-sdk\/package\.json/,
    );
  });
});

describe('readPackageVersion', () => {
  it('lê nome e versão do package.json instalado', () => {
    const root = repoWith('@x/pacote', '{"name":"@x/pacote","version":"1.2.3"}');
    expect(readPackageVersion(root, '@x/pacote')).toEqual({ name: '@x/pacote', version: '1.2.3' });
  });

  it('falha quando o pacote não está instalado (o nome antigo do SDK, `@precisa-saude/datasus`)', () => {
    expect(() => readPackageVersion(REPO_ROOT, '@precisa-saude/datasus')).toThrow(
      /@precisa-saude\/datasus não está instalado/,
    );
  });

  it('falha quando o package.json não é JSON', () => {
    const root = repoWith('@x/pacote', '{');
    expect(() => readPackageVersion(root, '@x/pacote')).toThrow(
      /package\.json de @x\/pacote ilegível/,
    );
  });

  it('falha quando o package.json é de outro pacote', () => {
    const root = repoWith('@x/pacote', '{"name":"@x/outro","version":"1.2.3"}');
    expect(() => readPackageVersion(root, '@x/pacote')).toThrow(
      /package\.json em node_modules\/@x\/pacote é de @x\/outro/,
    );
  });

  it.each([
    ['sem versão', '{"name":"@x/pacote"}'],
    ['versão vazia', '{"name":"@x/pacote","version":""}'],
    ['versão não é string', '{"name":"@x/pacote","version":1}'],
    ['corpo nulo', 'null'],
  ])('falha com package.json sem versão válida: %s', (_caso, pkg) => {
    const root = repoWith('@x/pacote', pkg);
    expect(() => readPackageVersion(root, '@x/pacote')).toThrow(PackageVersionError);
  });
});
