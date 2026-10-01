import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { gitSha } from '../lib/git-sha.js';

const SHA = 'd36b1dc55d43d17962eb63054a157d48e17e4fcf';
const OTHER = 'e058ed8000000000000000000000000000000000';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'git-sha-'));
}

describe('gitSha', () => {
  it('lê HEAD destacado (SHA direto)', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), `${SHA}\n`);
    expect(gitSha(repo)).toBe(SHA);
  });

  it('resolve ref de branch em repositório normal', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${SHA}\n`);
    expect(gitSha(repo)).toBe(SHA);
  });

  it('resolve ref via packed-refs', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(repo, '.git', 'packed-refs'),
      `# pack-refs with: peeled\n${OTHER} refs/heads/outra\n${SHA} refs/heads/main\n`,
    );
    expect(gitSha(repo)).toBe(SHA);
  });

  it('segue o gitdir de uma worktree e acha o ref no diretório comum', () => {
    const main = tmp();
    const common = join(main, '.git');
    const wtGitDir = join(common, 'worktrees', 'wt');
    mkdirSync(join(common, 'refs', 'heads', 'fix'), { recursive: true });
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(common, 'refs', 'heads', 'fix', 'x'), `${SHA}\n`);
    writeFileSync(join(wtGitDir, 'HEAD'), 'ref: refs/heads/fix/x\n');
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n');

    const worktree = tmp();
    writeFileSync(join(worktree, '.git'), `gitdir: ${wtGitDir}\n`);
    expect(gitSha(worktree)).toBe(SHA);
  });

  it('devolve unknown sem .git ou com ref inexistente', () => {
    expect(gitSha(tmp())).toBe('unknown');
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/sumiu\n');
    expect(gitSha(repo)).toBe('unknown');
  });

  it('devolve unknown quando .git é arquivo sem gitdir', () => {
    const repo = tmp();
    writeFileSync(join(repo, '.git'), 'lixo\n');
    expect(gitSha(repo)).toBe('unknown');
  });
});
