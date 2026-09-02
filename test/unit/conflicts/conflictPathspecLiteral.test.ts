/**
 * A conflict-resolution path handed to git is a PATHSPEC, not a filename:
 * `*`, `?` and `[` are wildcards, and `--` only separates paths from
 * options — it does not make what follows literal. Against a real git repo
 * (not a mocked argv capture), these prove the two consequences and that
 * routing the path through `literalPathspec` fixes both:
 *
 *   - `ConflictIndexWriter.takeSide` resolving `a[1].ts` silently discards
 *     uncommitted work in `a1.ts` (the character class also matches it).
 *   - `readUnmergedStages` scoped to `a[1].ts` fans out to every other
 *     unmerged path the pattern happens to match.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GitCli } from '../../../src/git-core/gitCli';
import { ConflictIndexWriter } from '../../../src/conflicts/conflictIndexWriter';
import { readUnmergedStages, scopedUnmergedEntry } from '../../../src/conflicts/conflictStageModel';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** `merge` exits non-zero on a real conflict — that failure is expected. */
function mergeExpectingConflict(cwd: string, branch: string): void {
  try {
    git(cwd, ['merge', '-q', branch]);
  } catch {
    // expected: merge stops with the conflict left in the index/worktree
  }
}

describe('conflict resolution — pathspec character-class collision (real git)', () => {
  let repoRoot: string;
  let gitCli: GitCli;

  beforeEach(() => {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    repoRoot = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'pathspec-literal-'));
    git(repoRoot, ['init', '-q', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'a@b.c']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    gitCli = new GitCli();
  });

  afterEach(() => {
    gitCli.dispose();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('takeSide resolving "a[1].ts" does not discard an uncommitted edit to "a1.ts"', async () => {
    // Base commit holds both files; only "a[1].ts" diverges between branches
    // so "a1.ts" stays fully merged (no conflict of its own).
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'base\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'committed-plain\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-q', '-m', 'base']);

    git(repoRoot, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'theirs\n');
    git(repoRoot, ['commit', '-q', '-am', 'feature edits a[1].ts']);

    git(repoRoot, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'ours\n');
    git(repoRoot, ['commit', '-q', '-am', 'ours edits a[1].ts']);

    mergeExpectingConflict(repoRoot, 'feature');

    // The user's uncommitted work on the OTHER file — never staged, never
    // part of the conflict.
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'USER EDIT NOT COMMITTED\n');

    const read = await readUnmergedStages(gitCli, repoRoot, 'a[1].ts');
    assert.strictEqual(read.ok, true);
    const entry = scopedUnmergedEntry(read, 'a[1].ts');
    assert.ok(entry?.stage3, 'a[1].ts has a theirs side to take');

    const writer = new ConflictIndexWriter(gitCli);
    await writer.takeSide(repoRoot, 'a[1].ts', '--theirs', entry);

    assert.strictEqual(
      fs.readFileSync(path.join(repoRoot, 'a1.ts'), 'utf8'),
      'USER EDIT NOT COMMITTED\n',
      'resolving a[1].ts must not touch a1.ts'
    );
    assert.strictEqual(fs.readFileSync(path.join(repoRoot, 'a[1].ts'), 'utf8'), 'theirs\n');
  });

  it('readUnmergedStages scoped to "a[1].ts" does not fan out to other unmerged paths', async () => {
    // Both files conflict this time, so a raw (non-literal) pathspec read
    // scoped to "a[1].ts" also matches the unrelated "a1.ts" conflict.
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'base1\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'base2\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-q', '-m', 'base']);

    git(repoRoot, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'f1\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'f2\n');
    git(repoRoot, ['commit', '-q', '-am', 'feature edits both']);

    git(repoRoot, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repoRoot, 'a[1].ts'), 'm1\n');
    fs.writeFileSync(path.join(repoRoot, 'a1.ts'), 'm2\n');
    git(repoRoot, ['commit', '-q', '-am', 'main edits both']);

    mergeExpectingConflict(repoRoot, 'feature');

    const read = await readUnmergedStages(gitCli, repoRoot, 'a[1].ts');
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(
      Array.from(read.ok ? read.stages.keys() : []),
      ['a[1].ts'],
      'a read scoped to a[1].ts must not also report a1.ts'
    );
  });
});
