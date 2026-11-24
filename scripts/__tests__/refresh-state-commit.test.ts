import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../../.github/workflows/refresh.yml', import.meta.url),
  'utf8',
);
const commitStep = workflow
  .split('      - name: Commit state atualizado\n')[1]
  ?.split('\n      #')[0];
if (!commitStep) throw new Error('Passo de commit não encontrado');
const publishCommands = commitStep
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('git pull ') || line.startsWith('git push '));

const directories: string[] = [];
// Hooks exportam caminhos Git do repositório que está commitando.
// As fixtures não podem herdar esses caminhos nem os remotes do projeto.
const fixtureEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'protocol.allow',
  GIT_CONFIG_VALUE_0: 'never',
  GIT_CONFIG_KEY_1: 'protocol.file.allow',
  GIT_CONFIG_VALUE_1: 'always',
  GIT_CONFIG_KEY_2: 'init.templateDir',
  GIT_CONFIG_VALUE_2: '',
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: fixtureEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configureSigning(cwd: string, key: string): void {
  git(cwd, 'config', 'user.name', 'Refresh fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'config', 'gpg.format', 'ssh');
  git(cwd, 'config', 'user.signingkey', key);
  git(cwd, 'config', 'commit.gpgsign', 'true');
}

describe('commit do state no refresh', () => {
  it('ignora configurações globais, de sistema e templates de hooks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'refresh-config-')));
    directories.push(root);
    const template = join(root, 'templates');
    mkdirSync(join(template, 'hooks'), { recursive: true });
    writeFileSync(join(template, 'hooks/pre-commit'), 'hook herdado\n');
    writeFileSync(
      join(root, '.gitconfig'),
      `[core]\n\thooksPath = ${template}/hooks\n[init]\n\ttemplateDir = ${template}\n[url "https://example.invalid/"]\n\tinsteadOf = /fixture/\n`,
    );
    const systemConfig = join(root, 'system.gitconfig');
    writeFileSync(systemConfig, '[fixture]\n\tsystemLeak = config-contaminada\n');
    const env = {
      ...fixtureEnv,
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_CONFIG_SYSTEM: systemConfig,
    };
    expect(
      execFileSync('git', ['config', '--system', '--get', 'fixture.systemLeak'], {
        cwd: root,
        env,
        encoding: 'utf8',
      }).trim(),
    ).toBe('config-contaminada');
    const repository = join(root, 'repository');
    execFileSync('git', ['init', '--initial-branch=main', repository], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const config = execFileSync('git', ['config', '--list', '--show-origin'], {
      cwd: repository,
      env,
      encoding: 'utf8',
    });
    expect(config).not.toContain('.gitconfig');
    expect(config).not.toContain('hookspath');
    expect(config).not.toContain('insteadof');
    expect(config).not.toContain('fixture.systemleak');
    expect(existsSync(join(repository, '.git/hooks/pre-commit'))).toBe(false);
  });

  it.each([false, true])(
    'preserva pending e build locais durante o push (main avançou: %s)',
    (advanceRemote) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'refresh-state-')));
      directories.push(root);
      const remote = join(root, 'remote.git');
      const runner = join(root, 'runner');
      const other = join(root, 'other');
      const key = join(root, 'signing-key');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      git(root, 'init', '--bare', '--initial-branch=main', remote);
      git(root, 'clone', remote, runner);
      expect(git(runner, 'rev-parse', '--absolute-git-dir')).toBe(join(runner, '.git'));
      expect(git(runner, 'remote', 'get-url', 'origin')).toBe(remote);
      configureSigning(runner, key);
      mkdirSync(join(runner, 'state'));
      writeFileSync(join(runner, 'state/pending.json'), '{"pending":[]}\n');
      writeFileSync(join(runner, 'state/sia-pa.json'), '{"processed":{}}\n');
      git(runner, 'add', 'state');
      git(runner, 'commit', '-m', 'chore(data): prepara fixture');
      git(runner, 'push', 'origin', 'HEAD:main');
      git(root, 'clone', remote, other);
      expect(git(other, 'rev-parse', '--absolute-git-dir')).toBe(join(other, '.git'));
      expect(git(other, 'remote', 'get-url', 'origin')).toBe(remote);
      configureSigning(other, key);
      if (advanceRemote) {
        writeFileSync(join(other, 'README.md'), 'Alteração independente.\n');
        git(other, 'add', 'README.md');
        git(other, 'commit', '-m', 'docs: avança main');
        git(other, 'push', 'origin', 'HEAD:main');
      }
      const pending = '{"pending":[{"uf":"AC"}]}\n';
      const state = '{"processed":{"AC":{"2026-09":{}}}}\n';
      writeFileSync(join(runner, 'state/pending.json'), pending);
      writeFileSync(join(runner, 'state/sia-pa.json'), state);
      mkdirSync(join(runner, 'build-refresh'));
      writeFileSync(join(runner, 'build-refresh/_verified.json'), '{"verified":true}\n');
      git(runner, 'add', 'state/sia-pa.json');
      git(runner, 'commit', '-m', 'chore(data): atualiza state');

      expect(publishCommands).toHaveLength(2);
      execFileSync('bash', ['-e', '-c', publishCommands.join('\n')], {
        cwd: runner,
        env: fixtureEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      expect(readFileSync(join(runner, 'state/pending.json'), 'utf8')).toBe(pending);
      expect(readFileSync(join(runner, 'build-refresh/_verified.json'), 'utf8')).toBe(
        '{"verified":true}\n',
      );
      expect(git(runner, 'show', '--format=', '--name-only', 'HEAD')).toBe('state/sia-pa.json');
      expect(git(remote, 'show', 'main:state/sia-pa.json')).toBe(state.trim());
      expect(git(remote, 'show', 'main:state/pending.json')).toBe('{"pending":[]}');
      expect(git(runner, 'stash', 'list')).toBe('');
      if (advanceRemote) {
        expect(readFileSync(join(runner, 'README.md'), 'utf8')).toBe('Alteração independente.\n');
      }
    },
  );

  it('guarda metadados de recuperação antes que outro checkout limpe o runner', () => {
    const recovery = workflow.split('      - name: Preserva metadados em caso de falha\n')[1];
    expect(recovery).toBeDefined();
    expect(recovery).toContain('if: failure()');
    expect(recovery).toContain('state/sia-pa.json');
    expect(recovery).toContain('state/pending.json');
    expect(recovery).toContain('build-refresh/_verified.json');
    expect(recovery).toContain('build-refresh/_unchanged.json');
  });
});
