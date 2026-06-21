/**
 * Spec — structural guards for the branch-focus feature.
 *
 * Per ADR-007, structural guards are TS-level pattern matches against
 * source files that catch wiring drift (e.g. someone deletes the message
 * handler case or renames the public method). The behavioural tests in
 * `focusBranch.test.ts` cover what the code DOES; these guards cover
 * that the code is wired AT ALL.
 *
 * Three guards:
 *  - SG-1: `focusBranchOnGraph` has a matching case in
 *          GitToolWindowProvider._handleWebviewMessage
 *  - SG-2: GitToolWindowProvider exposes `setFocusedBranch`
 *  - SG-3: package.json declares `intellig.branch.focusOnGraph` as a
 *          contributed command AND view/item/context binding
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

describe('Wave D / D4-spec — branch-focus structural guards', () => {
  it('SG-1: focusBranchOnGraph has a matching case in _handleWebviewMessage', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
      'utf8'
    );
    assert.ok(
      /case ['"]focusBranchOnGraph['"]\s*:/.test(src),
      "GitToolWindowProvider._handleWebviewMessage must have `case 'focusBranchOnGraph':`"
    );
  });

  it('SG-2: GitToolWindowProvider exposes setFocusedBranch as a public async method', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
      'utf8'
    );
    assert.ok(
      /public\s+async\s+setFocusedBranch\s*\(/.test(src),
      'GitToolWindowProvider must declare `public async setFocusedBranch(...)`'
    );
  });

  it('SG-3a: package.json declares intellig.branch.focusOnGraph as a contributed command', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      contributes: { commands: Array<{ command: string }>; menus: Record<string, unknown> };
    };
    const cmd = pkg.contributes.commands.find((c) => c.command === 'intellig.branch.focusOnGraph');
    assert.ok(
      cmd,
      'package.json must declare `intellig.branch.focusOnGraph` in contributes.commands'
    );
  });

  it('SG-3b: package.json wires intellig.branch.focusOnGraph into view/item/context as inline group', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      contributes: { menus: { 'view/item/context': Array<{ command: string; group: string }> } };
    };
    const items = pkg.contributes.menus['view/item/context'];
    const focusItems = items.filter((i) => i.command === 'intellig.branch.focusOnGraph');
    assert.ok(
      focusItems.length >= 1,
      'package.json must bind intellig.branch.focusOnGraph in view/item/context'
    );
    for (const item of focusItems) {
      assert.ok(
        /^inline(@\d+)?$/.test(item.group),
        `intellig.branch.focusOnGraph binding group must be 'inline' (got '${item.group}')`
      );
    }
  });
});
