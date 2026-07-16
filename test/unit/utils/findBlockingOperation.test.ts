/**
 * Unit tests for `findBlockingOperation` — the marker probe behind the
 * history-rewrite in-progress pre-flight. A live rebase (`rebase-merge/` or
 * `rebase-apply/`) or a sequencer mid-flight (`CHERRY_PICK_HEAD` /
 * `REVERT_HEAD`) blocks starting a new interactive rebase; the probe names
 * the blocking operation so the refusal toast can. All filesystem state is
 * a fake `.git/` under workspace-notes/tmp.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { findBlockingOperation } from '../../../src/git-core/gitDirMarkers';

describe('findBlockingOperation', () => {
  let tmpDir: string;
  let gitDir: string;

  beforeEach(() => {
    const tmpBase = path.join(process.cwd(), 'workspace-notes', 'tmp');
    fs.mkdirSync(tmpBase, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(tmpBase, 'blocking-op-'));
    gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for a clean .git/', async () => {
    assert.strictEqual(await findBlockingOperation(gitDir), undefined);
  });

  it("detects an interactive rebase via rebase-merge/ → 'rebase'", async () => {
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    assert.strictEqual(await findBlockingOperation(gitDir), 'rebase');
  });

  it("detects a legacy am-style rebase via rebase-apply/ → 'rebase'", async () => {
    fs.mkdirSync(path.join(gitDir, 'rebase-apply'));
    assert.strictEqual(await findBlockingOperation(gitDir), 'rebase');
  });

  it("detects a cherry-pick sequencer via CHERRY_PICK_HEAD → 'cherry-pick'", async () => {
    fs.writeFileSync(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'a'.repeat(40) + '\n');
    assert.strictEqual(await findBlockingOperation(gitDir), 'cherry-pick');
  });

  it("detects a revert sequencer via REVERT_HEAD → 'revert'", async () => {
    fs.writeFileSync(path.join(gitDir, 'REVERT_HEAD'), 'b'.repeat(40) + '\n');
    assert.strictEqual(await findBlockingOperation(gitDir), 'revert');
  });

  it('a MERGE_HEAD alone does not block (merge conflicts are the unmerged-files gate)', async () => {
    fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), 'c'.repeat(40) + '\n');
    assert.strictEqual(await findBlockingOperation(gitDir), undefined);
  });

  it('returns undefined for a missing gitDir (probe never throws)', async () => {
    assert.strictEqual(await findBlockingOperation(path.join(tmpDir, 'nonexistent')), undefined);
  });
});

// F-K1: an am session must be NAMED as a patch apply — the refusal toast
// interpolates this value, and calling it a rebase points the user at
// rebase commands git will refuse during an am session.
describe('findBlockingOperation — git-am session', () => {
  const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');
  let amTmp: string;
  let amGitDir: string;

  beforeEach(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    amTmp = fs.mkdtempSync(path.join(TMP_ROOT, 'intellig-am-block-'));
    amGitDir = path.join(amTmp, '.git');
    fs.mkdirSync(amGitDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(amTmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('names rebase-apply/ WITH the applying marker a patch apply, not a rebase', async () => {
    const dir = path.join(amGitDir, 'rebase-apply');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'applying'), '', 'utf8');
    assert.strictEqual(await findBlockingOperation(amGitDir), 'patch apply (git am)');
  });

  it('still reports rebase-apply/ WITHOUT the applying marker as a rebase', async () => {
    fs.mkdirSync(path.join(amGitDir, 'rebase-apply'), { recursive: true });
    assert.strictEqual(await findBlockingOperation(amGitDir), 'rebase');
  });
});
