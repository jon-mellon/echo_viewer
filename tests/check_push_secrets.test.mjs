import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('pre-push checks outgoing commits and blocks a credential without printing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-secret-hook-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  mkdirSync(work);
  git(root, 'init', '--bare', remote);
  git(work, 'init');
  git(work, 'config', 'user.name', 'Hook Test');
  git(work, 'config', 'user.email', 'hook-test@example.invalid');
  git(work, 'config', 'core.hooksPath', '.githooks');
  git(work, 'remote', 'add', 'origin', remote);
  mkdirSync(join(work, '.githooks'));
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(sourceRoot, '.githooks/pre-push'), join(work, '.githooks/pre-push'));
  copyFileSync(join(sourceRoot, 'scripts/check_push_secrets.mjs'), join(work, 'scripts/check_push_secrets.mjs'));
  writeFileSync(join(work, 'README.md'), 'Safe repository.\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'Initial safe commit');
  const first = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Secret scan passed/);

  const fakeKey = 'AKIA' + 'A'.repeat(16);
  writeFileSync(join(work, 'leak.txt'), `credential=${fakeKey}\n`);
  git(work, 'add', 'leak.txt');
  git(work, 'commit', '-m', 'Add credential');
  const blocked = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: work, encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Push blocked/);
  assert.match(blocked.stderr, /leak\.txt:1/);
  assert.doesNotMatch(blocked.stderr, new RegExp(fakeKey));
});
