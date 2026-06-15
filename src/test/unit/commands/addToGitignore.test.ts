/**
 * P2 — Add to .gitignore (IntelliJ git4idea GitIgnoreFileActionGroup parity).
 *
 * Right-click an untracked file → "Add to .gitignore" appends the
 * repo-root-relative path to `<root>/.gitignore`. The parity-critical,
 * file-IO-free core is two pure helpers:
 *   - gitignorePatternFor(repoRoot, fileFsPath) → the POSIX, root-relative
 *     pattern git matches on (always `/`-separated, leading `/` anchors it).
 *   - buildGitignoreAppendContent(existing, pattern) → the new file text, a
 *     no-op when the pattern is already present (so repeated adds don't
 *     duplicate), always newline-terminated.
 */

import '../../setup';
import * as assert from 'assert';
import {
  gitignorePatternFor,
  buildGitignoreAppendContent,
} from '../../../commands/registration/explorerCommands';

describe('gitignorePatternFor (#P2 add-to-gitignore path)', () => {
  it('anchors a top-level file with a leading slash', () => {
    assert.strictEqual(gitignorePatternFor('/repo', '/repo/secret.env'), '/secret.env');
  });

  it('keeps the root-relative subdirectory path, POSIX-separated', () => {
    assert.strictEqual(
      gitignorePatternFor('/repo', '/repo/build/output/app.js'),
      '/build/output/app.js'
    );
  });

  it('normalizes Windows-style separators to POSIX', () => {
    assert.strictEqual(
      gitignorePatternFor('C:\\repo', 'C:\\repo\\dist\\bundle.js'),
      '/dist/bundle.js'
    );
  });

  it('returns undefined when the file is outside the repo root', () => {
    assert.strictEqual(gitignorePatternFor('/repo', '/other/file.txt'), undefined);
  });
});

describe('buildGitignoreAppendContent (#P2 dedup + newline)', () => {
  it('appends to an empty/absent .gitignore with a trailing newline', () => {
    assert.strictEqual(buildGitignoreAppendContent('', '/secret.env'), '/secret.env\n');
  });

  it('adds a separating newline when the file lacks a trailing one', () => {
    assert.strictEqual(
      buildGitignoreAppendContent('node_modules', '/secret.env'),
      'node_modules\n/secret.env\n'
    );
  });

  it('does not double the newline when the file already ends with one', () => {
    assert.strictEqual(
      buildGitignoreAppendContent('node_modules\n', '/secret.env'),
      'node_modules\n/secret.env\n'
    );
  });

  it('is a no-op when the exact pattern is already present (no duplicate)', () => {
    const existing = 'node_modules\n/secret.env\n';
    assert.strictEqual(buildGitignoreAppendContent(existing, '/secret.env'), existing);
  });

  it('matches an existing pattern ignoring surrounding whitespace', () => {
    const existing = 'node_modules\n  /secret.env  \n';
    assert.strictEqual(buildGitignoreAppendContent(existing, '/secret.env'), existing);
  });

  it('does NOT treat a comment or a different pattern as a match', () => {
    const existing = '# /secret.env is intentional\n';
    assert.strictEqual(
      buildGitignoreAppendContent(existing, '/secret.env'),
      '# /secret.env is intentional\n/secret.env\n'
    );
  });
});
