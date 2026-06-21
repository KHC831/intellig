/**
 * Detached-HEAD SHA source audit (spec L11).
 *
 * The synthetic "(HEAD detached at <sha>)" row in the BRANCHES tree
 * carries the full 40-char SHA on a dedicated accessor,
 * `BranchTreeItem.getDetachedHeadSha()`. Command handlers that act on
 * that row (checkout, new-branch-from) MUST read the SHA through the
 * accessor — NEVER by parsing it back out of the human-readable label
 * with a regex like `label.match(/\(HEAD detached at (.*?)\)/)`.
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

const HANDLER_FILE = 'src/branches/BranchContextMenuCommands.ts';

describe('L11 audit — detached-HEAD SHA read via getDetachedHeadSha(), never label parsing', () => {
  const abs = path.join(repoRoot(), HANDLER_FILE);
  let source: string;

  before(() => {
    source = fs.readFileSync(abs, 'utf-8');
  });

  it('uses getDetachedHeadSha() to obtain the checkout / new-branch start point', () => {
    assert.ok(
      source.includes('getDetachedHeadSha()'),
      `${HANDLER_FILE} must read the detached-HEAD SHA via getDetachedHeadSha(); ` +
        'the accessor returns the full SHA decoupled from the row label. See spec L11.'
    );
  });

  it('does NOT parse the SHA out of the "(HEAD detached at ...)" label', () => {
    // Any attempt to recover the SHA from the rendered label is the
    // regression this invariant forbids. Match the label phrase inside
    // a regex / string-search construct.
    const labelParsePattern = /HEAD detached at[^"'`]*\(\.\*|\.match\([^)]*HEAD detached/i;
    assert.ok(
      !labelParsePattern.test(source),
      `${HANDLER_FILE} must NOT parse the detached-HEAD SHA out of the row label. ` +
        'Use getDetachedHeadSha() instead. See spec L11.'
    );
  });

  it('both _handleCheckout and _handleNewBranchFrom fall back to getDetachedHeadSha()', () => {
    // Each handler computes its ref as `item.branch?.name ?? ...
    // getDetachedHeadSha()`. Assert both handler BODIES reference the
    // accessor so neither regresses independently. Match the method
    // DEFINITION (`private async _handleX(`), not the bare name — the
    // bare name's first occurrence is the registerLoggedCommand call
    // site, whose body is a one-line delegation that doesn't contain
    // the accessor.
    const checkoutIdx = source.indexOf('private async _handleCheckout(');
    const newBranchIdx = source.indexOf('private async _handleNewBranchFrom(');
    assert.ok(checkoutIdx >= 0, '_handleCheckout definition must exist');
    assert.ok(newBranchIdx >= 0, '_handleNewBranchFrom definition must exist');

    // Slice a generous window after each definition and confirm the
    // accessor appears within it (the ref-resolution line is near the
    // top of each handler body).
    const checkoutWindow = source.slice(checkoutIdx, checkoutIdx + 1500);
    const newBranchWindow = source.slice(newBranchIdx, newBranchIdx + 1500);
    assert.ok(
      checkoutWindow.includes('getDetachedHeadSha()'),
      '_handleCheckout must resolve the detached-HEAD start point via getDetachedHeadSha()'
    );
    assert.ok(
      newBranchWindow.includes('getDetachedHeadSha()'),
      '_handleNewBranchFrom must resolve the detached-HEAD start point via getDetachedHeadSha()'
    );
  });
});
