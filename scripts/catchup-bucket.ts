/**
 * Acesso ao bucket público pela proveniência retroativa.
 *
 * - `awsBucket`: o bucket de verdade, via aws CLI (as credenciais do
 *   runner, como nos outros passos do `refresh.yml`).
 * - `localBucket`: um diretório com a mesma estrutura de chaves, para
 *   testes e dry-run sem S3. Last-Modified é o mtime do arquivo e o ETag, o
 *   MD5 (upload simples).
 *
 * Único ponto de escrita: `upload`, que recusa qualquer chave fora de
 * `<dataset>/provenance/…/part.provenance.json` (`assertProvenanceUploadKey`).
 * Fica fora de `lib/` porque faz IO.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { assertProvenanceUploadKey, parseS3Listing, type S3Object } from './lib/s3-objects.js';

const execFileAsync = promisify(execFile);

export interface CatchupBucket {
  /** Baixa um objeto para `dest`. */
  download: (key: string, dest: string) => Promise<void>;
  /** Objetos sob `prefix`. */
  list: (prefix: string) => Promise<S3Object[]>;
  /**
   * Deixa os `part.provenance.json` publicados de `dataset` legíveis em
   * disco e devolve a raiz onde as chaves estão.
   */
  mirrorProvenance: (dataset: string, workDir: string) => Promise<string>;
  /** Descrição para o log. */
  name: string;
  /** Sobe um provenance. Só aceita chave de provenance do dataset. */
  upload: (file: string, key: string, dataset: string) => Promise<void>;
}

async function aws(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('aws', args, {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
}

export function awsBucket(bucket: string): CatchupBucket {
  return {
    download: async (key, dest) => {
      mkdirSync(dirname(dest), { recursive: true });
      await aws(['s3', 'cp', `s3://${bucket}/${key}`, dest, '--only-show-errors']);
    },
    list: async (prefix) =>
      parseS3Listing(
        await aws([
          's3api',
          'list-objects-v2',
          '--bucket',
          bucket,
          '--prefix',
          prefix,
          '--output',
          'json',
        ]),
      ),
    mirrorProvenance: async (dataset, workDir) => {
      const root = join(workDir, 'publicado');
      await aws([
        's3',
        'sync',
        `s3://${bucket}/${dataset}/provenance/`,
        join(root, dataset, 'provenance'),
        '--exclude',
        '*',
        '--include',
        '*part.provenance.json',
        '--delete',
        '--only-show-errors',
      ]);
      return root;
    },
    name: `s3://${bucket}`,
    upload: async (file, key, dataset) => {
      assertProvenanceUploadKey(key, dataset);
      await aws([
        's3',
        'cp',
        file,
        `s3://${bucket}/${key}`,
        '--content-type',
        'application/json',
        '--cache-control',
        'public, max-age=3600',
        '--only-show-errors',
      ]);
    },
  };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function localBucket(root: string): CatchupBucket {
  const keyOf = (path: string): string => relative(root, path).split(sep).join('/');
  return {
    download: (key, dest) => {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, key), dest);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        walk(join(root, prefix)).map((path) => ({
          etag: createHash('md5').update(readFileSync(path)).digest('hex'),
          key: keyOf(path),
          lastModified: statSync(path).mtime.toISOString(),
          size: statSync(path).size,
        })),
      ),
    mirrorProvenance: () => Promise.resolve(root),
    name: `diretório local ${root}`,
    upload: (file, key, dataset) => {
      assertProvenanceUploadKey(key, dataset);
      mkdirSync(dirname(join(root, key)), { recursive: true });
      copyFileSync(file, join(root, key));
      return Promise.resolve();
    },
  };
}
