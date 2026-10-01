import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * SHA do commit em `repoRoot`, lido direto de `.git` (sem depender do
 * binário `git`). Suporta git worktree, onde `.git` é um arquivo
 * `gitdir: …` e os refs ficam no diretório comum (`commondir`) ou em
 * `packed-refs`. Antes, numa worktree o provenance saía `unknown`.
 */
export function gitSha(repoRoot: string): string {
  try {
    const gitDir = resolveGitDir(repoRoot);
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);

    const commonFile = join(gitDir, 'commondir');
    const commonDir = existsSync(commonFile)
      ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
      : gitDir;

    for (const dir of [gitDir, commonDir]) {
      const refPath = join(dir, ref);
      if (existsSync(refPath)) return readFileSync(refPath, 'utf8').trim();
    }
    const packed = join(commonDir, 'packed-refs');
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const [sha, name] = line.trim().split(' ');
        if (name === ref && sha) return sha;
      }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveGitDir(repoRoot: string): string {
  const dotGit = join(repoRoot, '.git');
  if (statSync(dotGit).isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!match?.[1]) throw new Error(`.git sem gitdir em ${repoRoot}`);
    return resolve(repoRoot, match[1].trim());
  }
  return dotGit;
}
