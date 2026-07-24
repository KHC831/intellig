/**
 * Detached-HEAD SHA source audit (spec L11).
 *
 * The synthetic "(HEAD detached at <sha>)" row in the BRANCHES tree
 * carries the full 40-char SHA on a dedicated accessor,
 * `BranchTreeItem.getDetachedHeadSha()`. Command handlers that act on
 * that row (New Worktree reads it directly; checkout / new-branch-from go
 * through the tree-item spine) MUST read the SHA through the accessor —
 * NEVER by parsing it back out of the human-readable label with a regex
 * like `label.match(/\(HEAD detached at (.*?)\)/)`.
 *
 * Why this is a load-bearing invariant: the label is a presentation
 * string. It is localized-adjacent, abbreviated (short SHA), and
 * subject to formatting drift ("(HEAD detached at abc1234)" today, who
 * knows tomorrow). Parsing it to recover the checkout target is the
 * regression class that silently breaks checkout/new-branch-from when
 * the label format changes. The accessor returns the full, unabbreviated
 * SHA from the model, decoupled from how the row is rendered.
 *
 * This is a STATIC source audit: it reads the handler source and
 * asserts the accessor is used and no label-parsing pattern is present.
 * The behavioral coverage lives in the BranchContextMenu /
 * BranchTreeProvider suites; this audit guards against a refactor
 * reintroducing the label-parse shortcut.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function repoRoot(): string {
  // test/unit/audit/detachedHeadShaSource.audit.test.ts -> repo root.
  return path.resolve(__dirname, '../../..');
}

// The New Worktree handler is the sole command that reads the accessor
// directly; it lives in the worktree action module.
const READER_FILE = 'src/branches/branchWorktreeActions.ts';
// The label-parse ban covers every file that carries branch-menu handlers.
const BAN_FILES = [
  'src/branches/BranchContextMenuCommands.ts',
  'src/branches/branchWorktreeActions.ts',
];

describe('L11 audit — detached-HEAD SHA read via getDetachedHeadSha(), never label parsing', () => {
  let readerSource: string;
  let banSource: string;

  before(() => {
    readerSource = fs.readFileSync(path.join(repoRoot(), READER_FILE), 'utf-8');
    banSource = BAN_FILES.map((f) => fs.readFileSync(path.join(repoRoot(), f), 'utf-8')).join('\n');
  });

  it('uses getDetachedHeadSha() to obtain the checkout / new-branch start point', () => {
    assert.ok(
      readerSource.includes('getDetachedHeadSha()'),
      `${READER_FILE} must read the detached-HEAD SHA via getDetachedHeadSha(); ` +
        'the accessor returns the full SHA decoupled from the row label. See spec L11.'
    );
  });

  it('does NOT parse the SHA out of the "(HEAD detached at ...)" label', () => {
    // Any attempt to recover the SHA from the rendered label is the
    // regression this invariant forbids. Match the label phrase inside
    // a regex / string-search construct.
    const labelParsePattern = /HEAD detached at[^"'`]*\(\.\*|\.match\([^)]*HEAD detached/i;
    assert.ok(
      !labelParsePattern.test(banSource),
      `${BAN_FILES.join(', ')} must NOT parse the detached-HEAD SHA out of the row label. ` +
        'Use getDetachedHeadSha() instead. See spec L11.'
    );
  });

  it('the tree-item spine resolves the detached target via getDetachedHeadSha()', () => {
    // The handlers no longer read the accessor themselves — the tree-item
    // spine scope extracts the detached target ONCE (targetFromItem in
    // commandSpine.ts) and hands handlers a typed `{ kind: 'detached', sha }`.
    // Assert the single extraction point uses the accessor, keeping the
    // label-parse ban meaningful.
    const spineSource = fs.readFileSync(
      path.join(__dirname, '../../../src/commands/registration/commandSpine.ts'),
      'utf8'
    );
    assert.ok(
      spineSource.includes('getDetachedHeadSha?.()'),
      'commandSpine targetFromItem must resolve the detached SHA via getDetachedHeadSha()'
    );
  });
});
