/**
 * Final review-round fixes (tiny).
 *
 * Covers:
 *   1. dispatch-property spy forwards all args; the spy's earlier
 *      wrapper dropped `commitNodes`, making the dead-code construction
 *      at the call site visible to a future reader as a footgun. The
 *      comment also referenced the earlier `displayOrder` field name.
 *   2. `_handleCompareVersions` external-caller recipe was misleading —
 *      `getSelectedCommitsOldestFirst()` returns `readonly string[]`,
 *      not `IMenuStateNode[]`, and "a parents map" isn't a codebase
 *      concept. Updated to point at `getExtendedLogState().commitNodes`
 *      + the canonical projection in `_handleCommitContextMenu`.
 *
 * Doc-only assertions; no behavioural change.
 */

import '../../setup';
import * as assert from 'assert';

describe('Wave B R3 — final review fixes', () => {
  // ─── dispatch-property spy forwards all args ────────────────────────────
  describe('dispatch property spy is now varargs', () => {
    it('spy wrapper forwards all positional args to the original handler', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'test/property/commitContextMenuDispatch.property.test.ts'),
        'utf8'
      );
      // The earlier wrapper used `async (commitHashes: string[]) => …
      // return original(commitHashes)`, dropping the second positional.
      // It now rewrites to `(...args)` + spread. Find the spy
      // installation block and assert it uses the spread form.
      const idx = src.indexOf('Install spies on each handler method');
      assert.ok(idx > 0, 'expected spy-installation comment block');
      const window = src.substring(idx, idx + 1000);
      assert.ok(
        /\.\.\.args/.test(window),
        'spy wrapper must forward args via the rest spread (...args) to the original handler'
      );
      assert.ok(
        /original\s*\(\s*\.\.\.args\s*\)/.test(window),
        'original(...) must be called with spread args, not just commitHashes'
      );
    });

    it('comment at the call site references commitNodes (not the pre-R2 displayOrder)', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'test/property/commitContextMenuDispatch.property.test.ts'),
        'utf8'
      );
      // The earlier comment used "displayOrder" (the earlier field
      // name); it should refer to commitNodes consistently.
      const idx = src.indexOf('await commands._handleAction(');
      assert.ok(idx > 0, 'expected the property _handleAction call site');
      // Look 600 chars back at the lead-up comment.
      const window = src.substring(Math.max(0, idx - 600), idx);
      assert.ok(
        !/displayOrder/.test(window),
        'lead-up comment must not reference the pre-R2 displayOrder field name'
      );
      assert.ok(
        /commitNodes/.test(window),
        'lead-up comment must reference commitNodes (the R2 collapsed shape)'
      );
    });
  });

  // ─── compareVersions external-caller recipe ─────────────────────────────
  describe('compareVersions comment recipe is accurate', () => {
    let src: string;
    before(async () => {
      const fs = await import('fs');
      const path = await import('path');
      src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
    });

    it('comment near the swap-fallback site no longer mentions getSelectedCommitsOldestFirst', () => {
      // The earlier comment at :1208-1217 incorrectly suggested
      // external callers feed `getSelectedCommitsOldestFirst()` (a
      // string[]) into commitNodes (an IMenuStateNode[]). The comment
      // now corrects the recipe.
      const handlerIdx = src.indexOf('private async _handleCompareVersions');
      assert.ok(handlerIdx > 0);
      const block = src.substring(handlerIdx, handlerIdx + 4000);
      // The body comment block (above the idx0/idx1 projection) is the
      // one that earlier had the misleading line. Look for the
      // "external caller" phrase and assert it doesn't pair with the
      // shape-mismatched recipe anymore.
      const externalIdx = block.indexOf('external caller');
      assert.ok(externalIdx > 0, 'expected the external-caller comment to exist');
      // Window from "external caller" to the end of the comment block.
      const commentTail = block.substring(externalIdx, externalIdx + 800);
      assert.ok(
        !/getSelectedCommitsOldestFirst/.test(commentTail),
        'external-caller recipe must NOT suggest getSelectedCommitsOldestFirst (returns string[], not IMenuStateNode[])'
      );
      assert.ok(
        !/parents\s+map/i.test(commentTail),
        'external-caller recipe must NOT mention "parents map" (not a codebase concept)'
      );
    });

    it('comment now points at the canonical projection in _handleCommitContextMenu', () => {
      const handlerIdx = src.indexOf('private async _handleCompareVersions');
      const block = src.substring(handlerIdx, handlerIdx + 4000);
      const externalIdx = block.indexOf('external caller');
      const commentTail = block.substring(externalIdx, externalIdx + 800);
      assert.ok(
        /_handleCommitContextMenu/.test(commentTail),
        'comment must point external callers at the canonical projection in _handleCommitContextMenu'
      );
      assert.ok(
        /getExtendedLogState/i.test(commentTail) || /commitNodes/.test(commentTail),
        'comment must mention the source data (getExtendedLogState().commitNodes or equivalent)'
      );
    });
  });
});
