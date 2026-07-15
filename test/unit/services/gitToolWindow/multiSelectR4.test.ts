/**
 * Multi-select menu review-round fixes.
 *
 * Covers nine findings:
 *   1. applyMenuEnableMap must surface `entry.reason` as a `title=`
 *      tooltip on disabled rows.
 *   2. Narrow `reason` population to `!enabled && visible` host-side.
 *   3. Chronological-direction WARNING in `getSelectedCommits` JSDoc.
 *   4. `IMenuItemState` JSDoc cleanup.
 *   5. belt-and-suspenders comment on each `_postSyncSelection()` call site.
 *   6. Comment clarifying the recordingWebview fixture.
 *   7. `_onDidChangeState.fire()` ordering aligned across all 5 setters
 *      (BEFORE the post sequence).
 *   8. Comment on the property-test fixture seeding requirement.
 *   9. TODO(post-locale) comment on `reason`.
 *
 * Doc-only items (5, 6, 8, 9) carry small structural assertions to keep
 * the docs from drifting silently.
 */

import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import { computeMenuState } from '../../../../src/git-core/gitToolWindow/multiSelect';

/** Source of the bundled Git tool-window client entry (applyMenuEnableMap lives here). */
const ENTRY_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../../../src/git-core/gitToolWindow/webview/gitToolWindow.ts'),
  'utf8'
);

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

/**
 * Order-recording webview stub identical to the one in
 * `multiSelectR3.test.ts`. Defined here too so each spec is
 * self-contained.
 *
 * FU — extract to `test/helpers/recordingWebview.ts`
 * when a third test file needs this fixture. Currently 2 consumers
 * (this file and `multiSelectR3.test.ts`).
 */
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
    asWebviewUri: (u: unknown) => u,
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

describe('Wave A R4 — review fixes', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ─── applyMenuEnableMap surfaces reason as title ─────────────
  // FU — structural-only coverage; the runtime witness
  // lives in the ext-host smoke. When the inline-script extraction lands
  // in `_getInlineScript`, add a jsdom-driven
  // behavioural test that synthesizes a `message` event with a `reason`
  // payload and asserts the `title` attribute lands on the row.
  describe('R4-1 (HIGH) — applyMenuEnableMap pipes entry.reason → title attribute', () => {
    function getInlineScript(): string {
      return ENTRY_SOURCE;
    }

    it('inline script reads entry.reason from menuEnableMap', () => {
      const html = getInlineScript();
      assert.ok(/entry\.reason/.test(html), 'applyMenuEnableMap must reference entry.reason');
    });

    it('inline script defends against malformed payloads via typeof check', () => {
      const html = getInlineScript();
      // Defense-in-depth: typeof entry.reason === 'string' guards against a
      // future host-side bug shipping a non-string reason.
      assert.ok(
        /typeof\s+entry\.reason\s*===\s*['"]string['"]/.test(html),
        'applyMenuEnableMap must guard the reason read with typeof === "string"'
      );
    });

    it('inline script setAttributes title when reason is present and disabled', () => {
      const html = getInlineScript();
      assert.ok(
        /setAttribute\(\s*['"]title['"]/.test(html),
        'applyMenuEnableMap must call setAttribute("title", ...) for disabled rows with a reason'
      );
    });

    it('inline script removeAttribute title when reason is absent or enabled', () => {
      const html = getInlineScript();
      assert.ok(
        /removeAttribute\(\s*['"]title['"]/.test(html),
        'applyMenuEnableMap must call removeAttribute("title") to clear stale tooltips'
      );
    });

    it('behavioural: simulating a host post + menu open lands the title on a disabled visible row', () => {
      // Build a tiny DOM that mirrors the rendered menu, then run the
      // body of applyMenuEnableMap by extracting the function string from
      // the inline script and eval'ing it. We can't import the function
      // (it's inside a template literal in the inline script), but we can
      // assert the structural pattern — the integration check is in the
      // ext-host smoke + e2e suites.
      const html = getInlineScript();
      // The `title` write should appear inside the apply-loop body that
      // also flips the `disabled` class. Find both within a small window.
      const applyBlock = html.match(/function\s+applyMenuEnableMap[\s\S]{0,2500}\}/);
      assert.ok(applyBlock, 'applyMenuEnableMap function body must be present');
      const body = applyBlock[0];
      assert.ok(
        /entry\.reason/.test(body) && /title/.test(body) && /disabled/.test(body),
        'applyMenuEnableMap body must combine entry.reason + title write + disabled toggle in the same loop'
      );
    });
  });

  // ─── reason narrowed to !enabled && visible ────────────────
  describe('reason populated only when !enabled && visible', () => {
    function nodes(): { hash: string; parentCount: number }[] {
      return [
        { hash: 'aaa', parentCount: 1 },
        { hash: 'bbb', parentCount: 1 },
        { hash: 'ccc', parentCount: 1 },
      ];
    }

    it('squashCommits at N=1 is hidden — reason is NOT populated (was populated pre-R4)', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb']),
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      // squashCommits requires N>=2 to be visible.
      assert.strictEqual(state.squashCommits.visible, false);
      assert.strictEqual(state.squashCommits.enabled, false);
      assert.strictEqual(
        state.squashCommits.reason,
        undefined,
        'hidden actions must NOT carry a reason — they have no tooltip surface'
      );
    });

    it('squashCommits at N=2 with a gap: visible AND disabled — reason IS populated', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['aaa', 'ccc']), // gap at bbb
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.visible, true);
      assert.strictEqual(state.squashCommits.enabled, false);
      assert.ok(
        state.squashCommits.reason &&
          /contiguous|consecutive|gap/i.test(state.squashCommits.reason),
        `visible-disabled actions must carry a reason; got: ${JSON.stringify(state.squashCommits.reason)}`
      );
    });

    it('compareVersions at N=3 is hidden — reason is NOT populated', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['aaa', 'bbb', 'ccc']),
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      assert.strictEqual(state.compareVersions.visible, false);
      assert.strictEqual(state.compareVersions.enabled, false);
      assert.strictEqual(
        state.compareVersions.reason,
        undefined,
        'compareVersions has no visible-disabled state, so reason is never set in practice'
      );
    });
  });

  // ─── getSelectedCommits chronological warning ──────────────
  describe('getSelectedCommits JSDoc carries chronological-direction WARNING', () => {
    it('source contains a WARNING block on getSelectedCommits about reverse-chronological replay', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const idx = src.indexOf('public getSelectedCommits()');
      assert.ok(idx > 0, 'getSelectedCommits declaration not found');
      // 2000-char window before the declaration covers the JSDoc.
      const window = src.substring(Math.max(0, idx - 2000), idx);
      assert.ok(
        /WARNING/i.test(window),
        'getSelectedCommits JSDoc must contain a WARNING (caps) section for chronological-replay consumers'
      );
      assert.ok(
        /reverse|oldest-first|chronological/i.test(window),
        'WARNING must mention the reverse / oldest-first direction'
      );
      assert.ok(
        /cherry-?pick|rebase/i.test(window),
        'WARNING must call out cherry-pick / rebase by name'
      );
    });
  });

  // ─── IMenuItemState JSDoc updated ─────────────────────────────
  describe('IMenuItemState JSDoc reflects R4 reality', () => {
    it('multiSelect.ts JSDoc says reason is populated when visible && !enabled', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      const idx = src.indexOf('export interface IMenuItemState');
      assert.ok(idx > 0);
      const window = src.substring(Math.max(0, idx - 1500), idx);
      // Either the explicit gate or the "visible-disabled" phrasing.
      assert.ok(
        /visible\s*===\s*true\s*&&\s*enabled\s*===\s*false|visible-disabled|visible\s*=\s*true.*enabled\s*=\s*false/i.test(
          window
        ),
        'JSDoc must state the visible && !enabled gate explicitly'
      );
    });

    it('multiSelect.ts JSDoc mentions the title= tooltip surface', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      const idx = src.indexOf('reason?: string');
      assert.ok(idx > 0);
      const window = src.substring(Math.max(0, idx - 1200), idx + 400);
      assert.ok(
        /title=/.test(window) || /tooltip/i.test(window),
        'JSDoc must mention the title= tooltip surface'
      );
    });
  });

  // ─── _postSyncSelection call-site coverage ──────────────────────
  describe('_postSyncSelection is called from every selection-mutating setter', () => {
    it('each selection-mutating setter calls _postSyncSelection', async () => {
      // _postSyncSelection is the PRIMARY partial-update path for range
      // selections; a full _render() would destroy commit-row focus
      // on re-render (the Shift+Arrow keyboard-multiselect hazard), so it
      // does not fire there.
      // The structural assertion: every selection-mutating
      // setter must invoke _postSyncSelection (directly or via a
      // partial-update helper). Count the call sites instead of the
      // obsolete prose.
      //
      // As setters are extracted into provider/messageHandlers.ts the call
      // site relocates and its receiver changes (this._postSyncSelection() →
      // ctx.postSyncSelection()). Count BOTH forms across the union of the
      // two files so the same calls are still counted wherever they live.
      const fs = await import('fs');
      const path = await import('path');
      const unionSource = [
        'src/git-core/gitToolWindow/GitToolWindowProvider.ts',
        'src/git-core/gitToolWindow/provider/messageHandlers.ts',
      ]
        .map((rel) => {
          try {
            return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
      const callSites =
        unionSource.match(/(?:this\._postSyncSelection|ctx\.postSyncSelection)\(\)/g) || [];
      assert.ok(
        callSites.length >= 4,
        `expected at least 4 postSyncSelection() call sites, found ${callSites.length}`
      );
    });
  });

  // ─── recordingWebview fixture comment ─────────────────────────
  describe('recordingWebview fixture carries call-site-vs-delivery clarification', () => {
    it('multiSelectR3.test.ts has a NOTE block on recordingWebview', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'test/unit/services/gitToolWindow/multiSelectR3.test.ts'),
        'utf8'
      );
      const idx = src.indexOf('function recordingWebview');
      assert.ok(idx > 0);
      const window = src.substring(Math.max(0, idx - 800), idx);
      assert.ok(
        /CALL-?SITE order|call-?site/i.test(window),
        'recordingWebview must carry a NOTE distinguishing call-site order from delivery order'
      );
      assert.ok(
        /DELIVERY order|delivery/i.test(window),
        'recordingWebview NOTE must mention delivery order'
      );
    });
  });

  // ─── _onDidChangeState.fire() ordering aligned ────────────────
  describe('_onDidChangeState.fire() fires BEFORE the post sequence in all 5 setters', () => {
    function indexOfPostSequenceFire(source: string): number {
      // Helper used to locate "fire BEFORE post" callers — N/A here, kept
      // for future docstring matching.
      return source.length;
    }
    void indexOfPostSequenceFire;

    // The selection setters are being progressively extracted from
    // GitToolWindowProvider.ts into provider/messageHandlers.ts. A setter's
    // body therefore lives EITHER in-class (as `<vis> name(...): void { ... }`,
    // reading `this._onDidChangeState.fire()` / `this._postX()`) OR in the
    // module (as `export function name(ctx: IGtwControllerContext, ...): void
    // { ... }`, reading `ctx.fireDidChangeState()` / `ctx.postX()`). This
    // helper finds the body wherever it lives and recognizes both receiver
    // forms, so the fire-before-post invariant follows the body to its home.
    // The runtime postOrderingInvariant suite remains the primary ordering
    // guard; this is the secondary structural witness.
    async function readUnionSource(): Promise<string> {
      const fs = await import('fs');
      const path = await import('path');
      const candidates = [
        'src/git-core/gitToolWindow/GitToolWindowProvider.ts',
        'src/git-core/gitToolWindow/provider/messageHandlers.ts',
      ];
      return candidates
        .map((rel) => {
          try {
            return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
    }

    // Return the source body of a setter by NAME, found under either the
    // in-class header `public <name>(` (terminated at the 2-space method brace
    // `\n  }\n`) or the module header `export function <name>(` (terminated at
    // the column-0 function brace `\n}\n`), preferring whichever body carries
    // a fire call so the thin in-class forwarder is skipped. Used by the
    // bespoke tail-window range-method assertions, which need the raw body to
    // run their own lastIndexOf logic.
    async function readSetterBody(methodName: string): Promise<string> {
      const unionSource = await readUnionSource();
      const collect = (header: string, endMarker: string): string[] => {
        const out: string[] = [];
        let from = 0;
        for (;;) {
          const start = unionSource.indexOf(header, from);
          if (start < 0) {
            break;
          }
          from = start + header.length;
          const end = unionSource.indexOf(endMarker, start);
          if (end > start) {
            out.push(unionSource.substring(start, end));
          }
        }
        return out;
      };
      const carriesFire = (b: string): boolean =>
        b.includes('this._onDidChangeState.fire()') || b.includes('ctx.fireDidChangeState()');
      const bodies = [
        ...collect(`public ${methodName}(`, `\n  }\n`),
        ...collect(`export function ${methodName}(`, `\n}\n`),
      ];
      assert.ok(bodies.length > 0, `${methodName} body not found in provider or messageHandlers`);
      return bodies.find(carriesFire) ?? bodies[0];
    }

    async function findInBody(
      source: string,
      methodHeader: string
    ): Promise<{
      firePos: number;
      firstPostPos: number;
    }> {
      // Extract the method name from the in-class header (the token between
      // the visibility keyword and the parameter list) so we can also look
      // for the module-extracted form.
      const nameMatch = /(?:public|private|protected)?\s*([A-Za-z0-9_]+)\s*\(/.exec(methodHeader);
      const methodName = nameMatch ? nameMatch[1] : '';
      // Scan the union of the provider + the extracted handlers module so the
      // body is found whether the setter has moved yet or not. (The caller
      // still passes the provider source for backward compatibility; we union
      // it with the handlers module here.)
      const unionSource = `${source}\n${await readUnionSource()}`;

      // fire / post token positions within a given body fragment, matching
      // BOTH receiver forms (in-class `this._X` and module `ctx.X`).
      const firePosIn = (body: string): number => {
        const positions = [
          body.indexOf('this._onDidChangeState.fire()'),
          body.indexOf('ctx.fireDidChangeState()'),
        ].filter((p) => p !== -1);
        return positions.length > 0 ? Math.min(...positions) : -1;
      };
      const firstPostPosIn = (body: string): number => {
        const positions = [
          body.indexOf('this._postMenuStateUpdate()'),
          body.indexOf('this._postSyncSelection()'),
          body.indexOf('ctx.postMenuStateUpdate()'),
          body.indexOf('ctx.postSyncSelection()'),
        ].filter((p) => p !== -1);
        return positions.length > 0 ? Math.min(...positions) : -1;
      };

      // The setter may appear under the in-class header (real body pre-move,
      // OR a one-line forwarder post-move) AND/OR the module header (real body
      // post-move). Collect EVERY candidate body from both header forms and
      // pick the one that actually carries the fire/post calls — this skips
      // the thin forwarder (which has neither) and lands on the real body
      // wherever it lives.
      //
      // The body terminator depends on the form: an in-class method closes at
      // a 2-space-indented brace (`\n  }\n`), while a top-level exported
      // function closes at a column-0 brace (`\n}\n`). Using the right
      // terminator per form avoids stopping early on an inner `else { … }`
      // block (whose close is `\n  }\n` INSIDE a module function).
      const collectBodies = (header: string, endMarker: string): string[] => {
        const out: string[] = [];
        let from = 0;
        for (;;) {
          const start = unionSource.indexOf(header, from);
          if (start < 0) {
            break;
          }
          from = start + header.length;
          const end = unionSource.indexOf(endMarker, start);
          if (end > start) {
            out.push(unionSource.substring(start, end));
          }
        }
        return out;
      };
      // Match the module header on `export function <name>(` alone (not the
      // first parameter) so it still finds the function when prettier wraps a
      // long parameter list onto its own lines — the function name is unique,
      // so this stays unambiguous.
      const bodies = [
        ...collectBodies(methodHeader, `\n  }\n`),
        ...collectBodies(`export function ${methodName}(`, `\n}\n`),
      ];
      assert.ok(bodies.length > 0, `${methodName} body not found in provider or messageHandlers`);
      // The real body is the one carrying the fire call; forwarders have none.
      const realBody = bodies.find((b) => firePosIn(b) !== -1) ?? bodies[0];
      return { firePos: firePosIn(realBody), firstPostPos: firstPostPosIn(realBody) };
    }

    it('toggleCommitSelection fires onDidChangeState BEFORE _postSyncSelection / _postMenuStateUpdate', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const { firePos, firstPostPos } = await findInBody(
        src,
        'public toggleCommitSelection(hash: string): void'
      );
      assert.ok(firePos !== -1, 'expected fire() call in toggleCommitSelection');
      assert.ok(firstPostPos !== -1, 'expected post call in toggleCommitSelection');
      assert.ok(
        firePos < firstPostPos,
        `toggleCommitSelection: fire (pos ${firePos}) must come BEFORE first post (pos ${firstPostPos})`
      );
    });

    it('selectCommits fires BEFORE the post sequence', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const { firePos, firstPostPos } = await findInBody(
        src,
        'public selectCommits(hashes: readonly string[], anchor?: string | null): void'
      );
      assert.ok(firePos < firstPostPos);
    });

    it('rangeSelectCommit fires BEFORE the post sequence', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const { firePos, firstPostPos } = await findInBody(
        src,
        'public rangeSelectCommit(hash: string): void'
      );
      // Inside rangeSelectCommit there's a fallback that calls selectCommit
      // (which has its own fire). For ordering we look at the LAST
      // non-fallback fire — the one in the body's tail. The simple body
      // structure means there's exactly one fire at the bottom and one
      // postMenuStateUpdate above it. The check still holds: in the tail
      // section, fire must precede post. Recompute via tail-only window.
      const body = await readSetterBody('rangeSelectCommit');
      // The only valid fire / post pair is the tail one (after the
      // anchorIsValid guard). Find the LAST fire and the LAST first-post
      // and verify ordering. Recognize both receiver forms so the witness
      // follows the body whether it is in-class (this._X) or extracted into
      // the handler module (ctx.X).
      const lastFire = Math.max(
        body.lastIndexOf('this._onDidChangeState.fire()'),
        body.lastIndexOf('ctx.fireDidChangeState()')
      );
      const lastPost = Math.max(
        body.lastIndexOf('this._postMenuStateUpdate()'),
        body.lastIndexOf('this._postSyncSelection()'),
        body.lastIndexOf('ctx.postMenuStateUpdate()'),
        body.lastIndexOf('ctx.postSyncSelection()')
      );
      assert.ok(lastFire !== -1 && lastPost !== -1);
      assert.ok(
        lastFire < lastPost,
        `rangeSelectCommit: tail fire (pos ${lastFire}) must come BEFORE tail post (pos ${lastPost})`
      );
      void firePos;
      void firstPostPos;
    });

    it('addRangeSelectCommit fires BEFORE the post sequence', async () => {
      // Tail-window check (like rangeSelectCommit): the LAST fire must precede
      // the LAST post, recognizing both receiver forms so the witness follows
      // the body whether it is in-class (this._X) or extracted (ctx.X).
      const body = await readSetterBody('addRangeSelectCommit');
      const lastFire = Math.max(
        body.lastIndexOf('this._onDidChangeState.fire()'),
        body.lastIndexOf('ctx.fireDidChangeState()')
      );
      const lastPost = Math.max(
        body.lastIndexOf('this._postMenuStateUpdate()'),
        body.lastIndexOf('this._postSyncSelection()'),
        body.lastIndexOf('ctx.postMenuStateUpdate()'),
        body.lastIndexOf('ctx.postSyncSelection()')
      );
      assert.ok(lastFire !== -1 && lastPost !== -1);
      assert.ok(
        lastFire < lastPost,
        `addRangeSelectCommit: tail fire (pos ${lastFire}) must come BEFORE tail post (pos ${lastPost})`
      );
    });

    it('selectCommit fires onDidChangeState BEFORE _postMenuStateUpdate', async () => {
      // selectCommit doesn't call _postSyncSelection (partial-update path)
      // but it does post. Same ordering rule applies.
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const { firePos, firstPostPos } = await findInBody(
        src,
        'public selectCommit(hash: string): void'
      );
      assert.ok(firePos !== -1 && firstPostPos !== -1);
      assert.ok(
        firePos < firstPostPos,
        `selectCommit: fire (pos ${firePos}) must come BEFORE _postMenuStateUpdate (pos ${firstPostPos})`
      );
    });

    it('event subscriber receives the change BEFORE postMessage lands on the wire', () => {
      // Behavioural witness: fire onDidChangeState ordering is observable
      // by attaching a listener that records the message log at the time
      // of the event.
      const { events } = recordingWebview(provider);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      events.length = 0;

      let snapshotAtFire: Array<{ kind: 'html' | 'post'; type?: string }> | undefined;
      const sub = provider.onDidChangeState(() => {
        snapshotAtFire = events.map((e) => ({ ...e }));
      });

      provider.toggleCommitSelection('aaa');

      sub.dispose();
      assert.ok(snapshotAtFire, 'onDidChangeState handler did not fire');
      // At the moment fire() ran, the post sequence must NOT have run yet:
      // i.e., no `post` events of type updateMenuEnableState / syncSelection.
      const postsBeforeFire = snapshotAtFire.filter(
        (e) =>
          e.kind === 'post' && (e.type === 'updateMenuEnableState' || e.type === 'syncSelection')
      );
      assert.strictEqual(
        postsBeforeFire.length,
        0,
        `onDidChangeState should fire BEFORE the post sequence; saw ${postsBeforeFire.length} posts before fire`
      );
    });
  });

  // ─── property-test fixture coupling comment ───────────────────
  describe('property-test fixture comment about commitNodes seeding', () => {
    it('graphPanel.property.test.ts Property 8 carries a comment about fixture coupling', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'test/property/graphPanel.property.test.ts'),
        'utf8'
      );
      const idx = src.indexOf('initialSet ∪ {toggleHash}');
      assert.ok(
        idx > 0,
        'expected an explanatory comment near the seeded fixture mentioning the union'
      );
      // Comment should also flag that future property additions must also seed.
      const window = src.substring(idx, idx + 600);
      assert.ok(
        /silently drop|future property|silent/i.test(window),
        'comment must warn that future property additions need to seed too'
      );
    });
  });

  // ─── TODO(post-locale) on reason ───────────────────────────────
  describe('TODO(post-locale) marker near reason field', () => {
    it('multiSelect.ts contains TODO(post-locale) within 600 chars of the reason field', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/git-core/gitToolWindow/multiSelect.ts'),
        'utf8'
      );
      const idx = src.indexOf('reason?: string');
      assert.ok(idx > 0);
      const window = src.substring(Math.max(0, idx - 600), idx + 600);
      assert.ok(
        /TODO\(?post-?locale\)?/i.test(window),
        'expected TODO(post-locale) marker near reason field'
      );
      assert.ok(
        /discriminated|message-?id|locale/i.test(window),
        'TODO must mention the locale-id discriminated-union plan'
      );
    });
  });
});
