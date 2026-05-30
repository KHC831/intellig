/**
 * Wave A R5 — final review-round fixes.
 *
 * Covers:
 *   1. MEDIUM — TL4-M-1 = Senior L-2 — `updateLogState` fire-before-post
 *               alignment. The 5 setters fire `onDidChangeState` BEFORE
 *               the post sequence (R4-7). `updateLogState` was the
 *               outlier — fire AFTER. R5-1 aligns it.
 *   2. LOW    — Senior L-1 — dead-code cleanup in reason builders. The
 *               R4-2 visibility narrowing made
 *               `squashReason(selectedCount<2)` and ALL of
 *               `compareVersionsReason` unreachable. R5-2 deletes them.
 *   3. LOW    — TL4-L-1 — invariant comment on apply-loop gate.
 *   4. LOW    — Senior L-4 — duplicate TODO(post-locale) cleanup.
 *   5. FU     — TL4-L-2 — inline-script extraction trigger comment.
 *   6. FU     — TL4-L-3 — recordingWebview extraction comment in both
 *               R3 and R4 test files.
 *   7. FU     — TL4-L-4 — ADR-009 §3 bifurcation FU note.
 *   8. FU     — Senior L-3 — jsdom behavioural witness FU note in R4
 *               test file.
 *
 * Doc-only items (3, 5, 6, 7, 8) carry small structural assertions to
 * keep them from drifting silently.
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitToolWindowProvider } from '../../../../ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import { computeMenuState } from '../../../../git-core/gitToolWindow/multiSelect';

function mkCommit(
  hash: string,
  message = `commit ${hash}`,
  parents: string[] = []
): {
  hash: string;
  shortHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authorDate: Date;
  commitDate: Date;
} {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

/** Same recording-webview pattern as R3/R4. */
function recordingWebview(provider: GitToolWindowProvider): {
  events: Array<{ kind: 'html' | 'post'; type?: string }>;
} {
  const events: Array<{ kind: 'html' | 'post'; type?: string }> = [];
  let storedHtml = '';
  const webview = {
    get html(): string {
      return storedHtml;
    },
    set html(v: string) {
      storedHtml = v;
      events.push({ kind: 'html' });
    },
    postMessage: (msg: { type?: string }) => {
      events.push({ kind: 'post', type: msg.type });
      return Promise.resolve(true);
    },
    cspSource: 'test:',
    asWebviewUri: (u: vscode.Uri) => u,
  };
  (provider as unknown as { _view: unknown })._view = {
    webview,
    visible: true,
    show: () => {},
    title: 'test',
    description: '',
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  };
  return { events };
}

describe('Wave A R5 — final review fixes', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ─── R5-1 MEDIUM: updateLogState fires BEFORE the post sequence ─────────
  describe('R5-1 (MEDIUM) — updateLogState fires onDidChangeState BEFORE the post sequence (TL4-M-1)', () => {
    it('source order: fire precedes both _post* helpers', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const start = src.indexOf('public updateLogState(');
      assert.ok(start > 0, 'updateLogState not found');
      const end = src.indexOf('\n  }\n', start);
      const body = src.substring(start, end);
      const firePos = body.indexOf('this._onDidChangeState.fire()');
      const postSyncPos = body.indexOf('this._postSyncSelection()');
      const postMenuPos = body.indexOf('this._postMenuStateUpdate()');
      assert.ok(firePos !== -1, 'expected fire() in updateLogState');
      assert.ok(postSyncPos !== -1, 'expected _postSyncSelection() in updateLogState');
      assert.ok(postMenuPos !== -1, 'expected _postMenuStateUpdate() in updateLogState');
      assert.ok(
        firePos < postSyncPos,
        `updateLogState: fire (pos ${firePos}) must precede _postSyncSelection (pos ${postSyncPos})`
      );
      assert.ok(
        firePos < postMenuPos,
        `updateLogState: fire (pos ${firePos}) must precede _postMenuStateUpdate (pos ${postMenuPos})`
      );
    });

    it('behavioural: subscriber sees the change BEFORE postMessage lands on the wire', () => {
      const { events } = recordingWebview(provider);

      let snapshotAtFire: Array<{ kind: 'html' | 'post'; type?: string }> | undefined;
      const sub = provider.onDidChangeState(() => {
        // Snapshot on the FIRST fire only — multiple subscribers /
        // multiple events would otherwise overwrite. updateLogState
        // fires once, so this is fine.
        if (!snapshotAtFire) {
          snapshotAtFire = events.map((e) => ({ ...e }));
        }
      });

      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      sub.dispose();
      assert.ok(snapshotAtFire, 'onDidChangeState handler did not fire');
      const postsBeforeFire = snapshotAtFire.filter(
        (e) =>
          e.kind === 'post' && (e.type === 'updateMenuEnableState' || e.type === 'syncSelection')
      );
      assert.strictEqual(
        postsBeforeFire.length,
        0,
        `updateLogState: onDidChangeState should fire BEFORE the post sequence; saw ${postsBeforeFire.length} posts before fire`
      );
    });

    it('ADR-009 §3 generalizes the fire-before-post rule beyond setters', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adr = fs.readFileSync(
        path.join(process.cwd(), 'docs/adr/ADR-009-webview-state-ownership.md'),
        'utf8'
      );
      // R4 wording was "Selection mutators fire …"; R5-1 generalizes to
      // any host method calling _post* helpers.
      assert.ok(
        /any host method|methods?\s+that\s+call(?:s)?\s+`?_post|every\s+method|generalizes/i.test(
          adr
        ),
        'ADR-009 §3 must generalize the fire-before-post rule beyond just setters'
      );
    });
  });

  // ─── R5-2 LOW: dead-code cleanup in reason builders ─────────────────────
  describe('R5-2 (LOW) — dead-code cleanup in reason builders (Senior L-1)', () => {
    it('multiSelect.ts no longer carries the unreachable squashReason(selectedCount<2) branch', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      // The hidden-at-N=1 branch produced "Squash needs at least 2 commits selected."
      // R5-2 deletes it because the visible-and-disabled gate excludes that case.
      assert.ok(
        !/Squash needs at least 2 commits selected/.test(src),
        'unreachable squashReason(N<2) branch must be deleted'
      );
    });

    it('multiSelect.ts no longer declares compareVersionsReason as code', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      // The unreachable builder `const compareVersionsReason = ...` must
      // be deleted. The name MAY still appear in the dead-code rationale
      // comment that explains why it was deleted; we filter those out
      // before the check.
      const codeOnly = src
        // Strip line comments (// ...) — anchored to line start so we
        // don't strip URL-like things that have // mid-line.
        .replace(/^\s*\/\/.*$/gm, '')
        // Strip block comments (/** ... */ and /* ... */).
        .replace(/\/\*[\s\S]*?\*\//g, '');
      assert.ok(
        !/compareVersionsReason/.test(codeOnly),
        'unreachable compareVersionsReason builder must be deleted from code (comments may still mention it)'
      );
    });

    it('reason builder still produces correct output for the surviving cases', () => {
      // Smoke check: the visible-and-disabled cases still surface their reason.
      const nodesArr = [
        { hash: 'aaa', parentCount: 1 },
        { hash: 'bbb', parentCount: 1 },
        { hash: 'ccc', parentCount: 1 },
        { hash: 'ddd', parentCount: 1 },
      ];
      // Gap → contiguity reason.
      const gap = computeMenuState({
        selectedHashes: new Set(['aaa', 'ccc']),
        commitNodes: nodesArr,
        headHash: 'aaa',
      });
      assert.ok(
        gap.squashCommits.reason && /contiguous|consecutive|gap/i.test(gap.squashCommits.reason)
      );

      // Merge in selection.
      const withMerge = [
        { hash: 'aaa', parentCount: 1 },
        { hash: 'bbb', parentCount: 1 },
        { hash: 'ccc', parentCount: 2 }, // merge
        { hash: 'ddd', parentCount: 1 },
      ];
      const merge = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc', 'ddd']),
        commitNodes: withMerge,
        headHash: 'aaa',
      });
      assert.ok(merge.squashCommits.reason && /merge/i.test(merge.squashCommits.reason));
    });

    it('compareVersions never carries a reason (always either visible+enabled or hidden)', () => {
      const nodesArr = [
        { hash: 'aaa', parentCount: 1 },
        { hash: 'bbb', parentCount: 1 },
        { hash: 'ccc', parentCount: 1 },
      ];
      for (const sel of [
        new Set<string>(),
        new Set(['aaa']),
        new Set(['aaa', 'bbb']),
        new Set(['aaa', 'bbb', 'ccc']),
      ]) {
        const state = computeMenuState({
          selectedHashes: sel,
          commitNodes: nodesArr,
          headHash: 'aaa',
        });
        assert.strictEqual(
          state.compareVersions.reason,
          undefined,
          `compareVersions.reason must always be undefined (sel size=${sel.size})`
        );
      }
    });
  });

  // ─── R5-3 LOW: invariant comment on apply-loop gate ─────────────────────
  describe('R5-3 (LOW) — invariant comment on applyMenuEnableMap title gate (TL4-L-1)', () => {
    it('inline script applyMenuEnableMap carries an INVARIANT comment near the title gate', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const idx = src.indexOf('function applyMenuEnableMap');
      assert.ok(idx > 0);
      const window = src.substring(idx, idx + 2000);
      assert.ok(
        /INVARIANT/.test(window),
        'applyMenuEnableMap must carry an INVARIANT comment cross-referencing computeMenuState'
      );
      assert.ok(
        /multiSelect\.ts|computeMenuState|visible\s*&&\s*!enabled/i.test(window),
        'INVARIANT comment must cross-reference the host-side reason gate'
      );
    });
  });

  // ─── R5-4 LOW: duplicate TODO(post-locale) cleanup ──────────────────────
  describe('R5-4 (LOW) — TODO(post-locale) appears once, on the field (Senior L-4)', () => {
    it('multiSelect.ts has exactly one TODO(post-locale) marker', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      const matches = src.match(/TODO\(post-locale\)/g) || [];
      assert.strictEqual(
        matches.length,
        1,
        `expected exactly 1 TODO(post-locale), got ${matches.length}`
      );
    });

    it('the surviving TODO is on the `reason?: string` field, not the interface JSDoc', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      const todoIdx = src.indexOf('TODO(post-locale)');
      const reasonIdx = src.indexOf('reason?: string');
      assert.ok(todoIdx > 0 && reasonIdx > 0);
      // The TODO must be CLOSER to `reason?: string` than to
      // `export interface IMenuItemState`.
      const ifaceIdx = src.indexOf('export interface IMenuItemState');
      const distFromIface = todoIdx - ifaceIdx;
      const distFromField = Math.abs(reasonIdx - todoIdx);
      assert.ok(
        distFromField < distFromIface,
        `TODO(post-locale) should live near the field (${distFromField}) not the interface (${distFromIface})`
      );
    });
  });

  // ─── R5-5 FU: inline-script extraction trigger ──────────────────────────
  describe('R5-5 (FU) — inline-script extraction trigger comment (TL4-L-2)', () => {
    it('GitToolWindowProvider.ts contains an FU comment naming the extraction trigger', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      assert.ok(
        /FU\b[\s\S]{0,200}extract inline-script|FU\b[\s\S]{0,200}asWebviewUri/i.test(src),
        'expected FU comment near the inline script naming the extraction trigger (5 functions / async data flow)'
      );
    });
  });

  // ─── R5-6 FU: recordingWebview extraction in R3 + R4 ────────────────────
  describe('R5-6 (FU) — recordingWebview extraction comment in both R3 and R4 test files (TL4-L-3)', () => {
    async function readTestFile(name: string): Promise<string> {
      const fs = await import('fs');
      const path = await import('path');
      return fs.readFileSync(
        path.join(process.cwd(), 'src/test/unit/services/gitToolWindow/', name),
        'utf8'
      );
    }

    it('multiSelectR3.test.ts has an FU comment about extraction', async () => {
      const src = await readTestFile('multiSelectR3.test.ts');
      assert.ok(
        /FU\b[\s\S]{0,200}extract[\s\S]{0,300}helpers/i.test(src),
        'multiSelectR3.test.ts must carry an FU extraction comment'
      );
    });

    it('multiSelectR4.test.ts has an FU comment about extraction', async () => {
      const src = await readTestFile('multiSelectR4.test.ts');
      assert.ok(
        /FU\b[\s\S]{0,200}extract[\s\S]{0,300}helpers/i.test(src),
        'multiSelectR4.test.ts must carry an FU extraction comment'
      );
    });
  });

  // ─── R5-7 FU: ADR-009 §3 bifurcation note ───────────────────────────────
  describe('R5-7 (FU) — ADR-009 §3 bifurcation FU (TL4-L-4)', () => {
    it('ADR-009 contains an FU note about §3 bifurcation when Wave C lands', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const adr = fs.readFileSync(
        path.join(process.cwd(), 'docs/adr/ADR-009-webview-state-ownership.md'),
        'utf8'
      );
      assert.ok(
        /FU\b[\s\S]{0,400}(?:bifurcat|sub-rule|§3a|new ADR)/i.test(adr),
        'ADR-009 must carry an FU note about bifurcating §3 / splitting an ADR when Wave C adds another sub-rule'
      );
    });
  });

  // ─── R5-8 FU: jsdom behavioural witness deferral note ───────────────────
  describe('R5-8 (FU) — jsdom behavioural-witness FU note in multiSelectR4.test.ts (Senior L-3)', () => {
    it('R4-1 test block carries an FU note about deferring full DOM coverage', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/test/unit/services/gitToolWindow/multiSelectR4.test.ts'),
        'utf8'
      );
      const idx = src.indexOf('R4-1 (HIGH)');
      assert.ok(idx > 0);
      // Look BOTH 800 chars before (the FU note may sit immediately
      // above the `describe(...)` block) and 2000 chars after (in case
      // a future edit moves it inside the block).
      const window = src.substring(Math.max(0, idx - 800), idx + 2000);
      assert.ok(
        /FU\b[\s\S]{0,200}structural-only|FU\b[\s\S]{0,200}jsdom|FU\b[\s\S]{0,200}runtime witness/i.test(
          window
        ),
        'R4-1 test block must carry an FU note about structural-only coverage + ext-host runtime witness'
      );
    });
  });
});
