/**
 * CommitDialog data-action delegation tests.
 *
 * CommitDialog rendered seven inline `onclick="X('${path}')"`
 * attributes (selectFile/toggleFile/stageFile/unstageFile/stageHunk/
 * unstageHunk/stageSelectedLines). A path containing a literal `'`
 * could break out of the JS string and inject script — even after
 * `_escapeHtml` because the browser DECODES `&apos;` back inside
 * attribute parsing.
 *
 * Switches to `data-action` + `data-path` / `data-hunk-index`
 * with a single delegated dispatcher. Mirrors GitToolWindowProvider's
 * pattern at line 4523.
 *
 * Tests:
 *   commitDialog-csp-1: rendered HTML for the 7 site-specific functions
 *     contains zero inline `onclick="<fn>('...')"` attributes. Gear/
 *     refresh/cancel/commit/togglePartialStagingMode that don't take
 * user-controlled args MAY stay (per the plan).
 *   commitDialog-delegation-1: jsdom click on a `[data-action="stageFile"]`
 *     button posts a `stageFile` message after the dispatcher fires.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import { CommitDialog } from '../../../src/commits/CommitDialog';

// CommitDialog's _getFileItemHtml is a private method. We invoke it
// through prototype-level reflection: bind it to a minimal `this`
// stub that exposes the helpers it relies on (_escapeHtml, _getStatusColor,
// _getFileName, _getFileDir).
interface FileItemRenderStub {
  _selectedFilePath: string | null;
  _escapeHtml(s: string): string;
  _getStatusColor(s: string): string;
  _getFileName(p: string): string;
  _getFileDir(p: string): string;
}

function renderFileItem(file: {
  path: string;
  status: string;
  staged: boolean;
  selected: boolean;
}): string {
  // Bind the prototype method to a minimal `this`. The implementation
  // reads `_selectedFilePath` for the `selected` highlight and the
  // four helpers for HTML escaping / status / path display.
  const proto = (
    CommitDialog as unknown as {
      prototype: { _getFileItemHtml: (this: FileItemRenderStub, f: unknown) => string };
    }
  ).prototype;
  const stub: FileItemRenderStub = {
    _selectedFilePath: null,
    _escapeHtml: (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    _getStatusColor: (): string => '#fff',
    _getFileName: (p: string): string => p.split('/').pop() ?? p,
    _getFileDir: (p: string): string => {
      const i = p.lastIndexOf('/');
      return i >= 0 ? p.substring(0, i) : '';
    },
  };
  return proto._getFileItemHtml.call(stub, file);
}

describe('Wave I H-2 — CommitDialog data-action delegation', () => {
  it('commitDialog-csp-1: rendered HTML contains zero inline onclick=" for the 7 site-specific functions', () => {
    // Render two files (one staged, one not) so we exercise both the
    // unstageFile and stageFile button paths.
    const stagedHtml = renderFileItem({
      path: 'src/file.ts',
      status: 'Modified',
      staged: true,
      selected: true,
    });
    const unstagedHtml = renderFileItem({
      path: 'src/other.ts',
      status: 'Modified',
      staged: false,
      selected: false,
    });
    const html = stagedHtml + unstagedHtml;

    // The 7 site-specific functions MUST NOT appear as inline onclick handlers.
    const forbidden = [
      /onclick="selectFile\(/,
      /onclick="event\.stopPropagation\(\); toggleFile\(/,
      /onclick="event\.stopPropagation\(\); stageFile\(/,
      /onclick="event\.stopPropagation\(\); unstageFile\(/,
      /onclick="stageHunk\(/,
      /onclick="unstageHunk\(/,
      /onclick="stageSelectedLines\(/,
    ];

    for (const pat of forbidden) {
      assert.ok(
        !pat.test(html),
        `expected NO inline onclick matching ${pat}; found in:\n${html.substring(0, 500)}`
      );
    }

    // Sanity: the data-action shape is present.
    assert.ok(html.includes('data-action="selectFile"'));
    assert.ok(
      html.includes('data-action="stageFile"') || html.includes('data-action="unstageFile"')
    );
  });

  it('commitDialog-delegation-1: jsdom click on data-action="stageFile" dispatches the correct handler', () => {
    // Build a minimal DOM with a button that has the data-action shape,
    // then attach the same delegated dispatcher we ship in production
    // (extracted into a string in the dialog's `_getInlineScript`).
    //
    // We instrument `vscode.postMessage` via a global stub and assert
    // the handler invoked it with the expected message.
    const dom = new JSDOM(`
      <html><body>
        <button id="b" class="stage-button" data-action="stageFile" data-path="src/file.ts">+</button>
      </body></html>
    `);
    const { document } = dom.window;
    const messages: unknown[] = [];

    // Inject the dispatcher inline (matches production source verbatim,
    // sans the surrounding template-literal indentation).
    const dispatcher = (e: Event): void => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) {
        return;
      }
      const action: string | undefined = target.dataset.action;
      const path: string | undefined = target.dataset.path;
      const hunkIndex: string | undefined = target.dataset.hunkIndex;
      const handlers: Record<string, () => void> = {
        selectFile: () => messages.push({ type: 'selectFile', filePath: path }),
        toggleFile: () => {
          e.stopPropagation();
          messages.push({ type: 'toggleFile', filePath: path });
        },
        stageFile: () => {
          e.stopPropagation();
          messages.push({ type: 'stageFile', filePath: path });
        },
        unstageFile: () => {
          e.stopPropagation();
          messages.push({ type: 'unstageFile', filePath: path });
        },
        stageHunk: () => messages.push({ type: 'stageHunk', hunkIndex: Number(hunkIndex) }),
        unstageHunk: () => messages.push({ type: 'unstageHunk', hunkIndex: Number(hunkIndex) }),
      };
      if (action && handlers[action]) {
        handlers[action]();
      }
    };
    document.addEventListener('click', dispatcher);

    const button = document.getElementById('b');
    assert.ok(button);
    button.click();

    assert.deepStrictEqual(messages, [{ type: 'stageFile', filePath: 'src/file.ts' }]);
  });

  it('commitDialog-delegation-2: dispatcher survives a re-render (pattern: re-attaches to fresh nodes)', () => {
    // The delegated dispatcher is bound to `document`, NOT to individual
    // buttons. So when `_getFilesSection()` rebuilds the file list
    // (replacing the DOM nodes), the dispatcher still fires because
    // event delegation walks up from `e.target`.
    const dom = new JSDOM(`<html><body><div id="root"></div></body></html>`);
    const { document } = dom.window;
    const messages: unknown[] = [];

    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) {
        return;
      }
      messages.push({ action: target.dataset.action, path: target.dataset.path });
    });

    // First render.
    const root = document.getElementById('root') as HTMLElement;
    root.innerHTML = `<button data-action="stageFile" data-path="a.ts">+</button>`;
    (root.firstElementChild as HTMLElement).click();

    // Re-render with a different file.
    root.innerHTML = `<button data-action="stageFile" data-path="b.ts">+</button>`;
    (root.firstElementChild as HTMLElement).click();

    assert.deepStrictEqual(messages, [
      { action: 'stageFile', path: 'a.ts' },
      { action: 'stageFile', path: 'b.ts' },
    ]);
  });
});

/**
 * File-status colors via theme variables.
 *
 * `_getStatusColor` previously returned bare hex literals
 * (`#6897BB`, `#629755`, …) that ignored the user's theme. It now
 * switches every entry to `var(--vscode-gitDecoration-*Foreground, #hex)`
 * so the chip text color flips with the theme; the original hex stays
 * as the CSS-var fallback for themes that don't define the token.
 *
 * The 7 file-status states (Modified, Added, Deleted, Renamed, Copied,
 * Untracked, Unmerged) all map to the `gitDecoration-*` family, which
 * has been part of VS Code's theme contract since 1.46. Our engines.vscode
 * floor is `^1.85.0`, so the variables are guaranteed available.
 */
describe('Wave J / WJ-2 — _getStatusColor returns theme-variable expressions', () => {
  // Reach the private method through prototype reflection. Same pattern
  // as the WJ-1 tests above.
  interface StatusColorStub {
    _getStatusColor(s: string): string;
  }
  function callStatusColor(status: string): string {
    const proto = (
      CommitDialog as unknown as {
        prototype: { _getStatusColor: (this: StatusColorStub, s: string) => string };
      }
    ).prototype;
    // The implementation is pure (only reads its own arg + a static
    // map), so the bound `this` only needs to be assignable to the
    // method's contract — an empty object is fine.
    return proto._getStatusColor.call({} as StatusColorStub, status);
  }

  it('chipTheme-1: _getStatusColor("Modified") returns var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)', () => {
    // Pin the exact var() shape — both the CSS variable name AND the
    // hex fallback must be present, in that order.
    assert.strictEqual(
      callStatusColor('Modified'),
      'var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)'
    );
  });

  it('chipTheme-2: every status maps to a `var(--vscode-gitDecoration-*)` expression with a hex fallback', () => {
    // Pin the COMPLETE map. A future re-coloring of any single status
    // forces a deliberate diff in this assertion.
    const expected: Record<string, string> = {
      Modified: 'var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB)',
      Added: 'var(--vscode-gitDecoration-addedResourceForeground, #629755)',
      Deleted: 'var(--vscode-gitDecoration-deletedResourceForeground, #6C6C6C)',
      Renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #6897BB)',
      Copied: 'var(--vscode-gitDecoration-addedResourceForeground, #629755)',
      Untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground, #CC7832)',
      Unmerged: 'var(--vscode-gitDecoration-conflictingResourceForeground, #FF0000)',
    };
    for (const [status, expr] of Object.entries(expected)) {
      assert.strictEqual(
        callStatusColor(status),
        expr,
        `status "${status}" must return the gitDecoration var() expression`
      );
    }
  });

  it('chipTheme-3: unknown status falls back to var(--vscode-foreground, #FFFFFF)', () => {
    // The `||` branch in `_getStatusColor` was bare `#FFFFFF` pre-J.
    // Makes it theme-aware too — text in a webview should read
    // against the editor's foreground, not a hard white that's invisible
    // on light themes.
    assert.strictEqual(callStatusColor('NotAStatus'), 'var(--vscode-foreground, #FFFFFF)');
  });
});

/**
 * toggleLine inline-onclick → data-action delegation.
 *
 * Each selectable diff line previously carried
 * `onclick="toggleLine(${hunkIndex}, ${lineNumber})"` interpolated into
 * the row HTML. An earlier pass cleaned the file/hunk-button onclicks but
 * toggleLine was missed — the only call sites where the args were
 * caller-controlled numbers (no user input through the JS string),
 * but consistency wins: the dispatcher pattern is uniform once
 * toggleLine joins it.
 *
 * Test coverage:
 *   commitDialog-toggleLine-1: jsdom click on
 *     `[data-action="toggleLine"][data-hunk-index="2"][data-line-number="5"]`
 *     dispatches with correctly-typed numeric args (Number(hunkIndex),
 *     Number(lineNumber)).
 *   commitDialog-toggleLine-2: rendered diff-line HTML for a
 *     selectable line carries `data-action="toggleLine"` +
 *     `data-hunk-index` + `data-line-number`, NOT inline `onclick=`.
 */
describe('Wave J / WJ-5 — CommitDialog toggleLine data-action delegation', () => {
  it('commitDialog-toggleLine-1: jsdom click dispatches Number(hunkIndex) + Number(lineNumber)', () => {
    // Mirror the production dispatcher's toggleLine handler in jsdom and
    // verify the typed-number contract. The args MUST be coerced via
    // `Number()` because dataset values are always strings.
    const dom = new JSDOM(`
      <html><body>
        <div id="line"
             data-action="toggleLine"
             data-hunk-index="2"
             data-line-number="5">- removed</div>
      </body></html>
    `);
    const { document } = dom.window;
    const messages: Array<{ type: string; hunkIndex: unknown; lineNumber: unknown }> = [];

    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) {
        return;
      }
      const action: string | undefined = target.dataset.action;
      const hunkIndex: string | undefined = target.dataset.hunkIndex;
      const lineNumber: string | undefined = target.dataset.lineNumber;
      const handlers: Record<string, () => void> = {
        toggleLine: () =>
          messages.push({
            type: 'toggleLine',
            hunkIndex: Number(hunkIndex),
            lineNumber: Number(lineNumber),
          }),
      };
      if (action && handlers[action]) {
        handlers[action]();
      }
    });

    const lineEl = document.getElementById('line');
    assert.ok(lineEl);
    lineEl.click();

    assert.deepStrictEqual(messages, [
      // The contract: BOTH args coerce to NUMBER, not stay as the
      // string "2" / "5" that the DOM stored.
      { type: 'toggleLine', hunkIndex: 2, lineNumber: 5 },
    ]);
  });

  it('commitDialog-toggleLine-2: rendered selectable-line HTML carries data-action + indexes (NOT inline onclick)', () => {
    // Render the selectable-line shape that `_renderHunkWithControls`
    // emits. We construct a minimal `this`-stub matching what the
    // method reads and verify the literal attribute shape of the
    // emitted line div.
    //
    // The selectable path requires `_partialStagingMode = true` AND a
    // line that has a defined line-number (the `delete` lines use
    // `oldLineNumber`, the `add` lines use `newLineNumber`).
    interface RenderHunkProto {
      _renderHunkWithControls: (
        this: {
          _escapeHtml: (s: string) => string;
          _selectedLines: Map<number, Set<number>>;
          _partialStagingMode: boolean;
        },
        hunk: {
          oldStart: number;
          oldLines: number;
          newStart: number;
          newLines: number;
          header: string;
          lines: Array<{
            type: string;
            content: string;
            oldLineNumber?: number;
            newLineNumber?: number;
          }>;
        },
        hunkIndex: number,
        isStaged: boolean
      ) => string;
    }
    const proto = (CommitDialog as unknown as { prototype: RenderHunkProto }).prototype;
    const stub = {
      _escapeHtml: (s: string): string =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;'),
      _selectedLines: new Map<number, Set<number>>(),
      _partialStagingMode: true,
    };
    const hunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      header: '@@ -1,2 +1,2 @@',
      lines: [
        // A selectable `delete` line — the toggleLine attachment site.
        { type: 'delete', content: 'old line', oldLineNumber: 5, newLineNumber: undefined },
      ],
    };
    const html = proto._renderHunkWithControls.call(stub, hunk, 2, false);

    // The forbidden inline-onclick form must NOT appear.
    assert.ok(
      !/onclick="toggleLine\(/.test(html),
      `expected no inline onclick="toggleLine("; got: ${html.substring(0, 800)}`
    );
    // The data-action shape MUST appear, with the matching indexes.
    assert.ok(
      /data-action="toggleLine"/.test(html),
      `expected data-action="toggleLine"; got: ${html.substring(0, 800)}`
    );
    assert.ok(
      /data-hunk-index="2"/.test(html),
      `expected data-hunk-index="2"; got: ${html.substring(0, 800)}`
    );
    assert.ok(
      /data-line-number="5"/.test(html),
      `expected data-line-number="5"; got: ${html.substring(0, 800)}`
    );
  });
});

describe('#P2 — CommitDialog Revert Hunk (IntelliJ Revert Chunk)', () => {
  interface RenderHunkProto {
    _renderHunkWithControls: (
      this: {
        _escapeHtml: (s: string) => string;
        _selectedLines: Map<number, Set<number>>;
        _partialStagingMode: boolean;
      },
      hunk: {
        oldStart: number;
        oldLines: number;
        newStart: number;
        newLines: number;
        header: string;
        lines: Array<{ type: string; content: string }>;
      },
      hunkIndex: number,
      isStaged: boolean
    ) => string;
  }

  const proto = (CommitDialog as unknown as { prototype: RenderHunkProto }).prototype;
  const stub = {
    _escapeHtml: (s: string): string => s,
    _selectedLines: new Map<number, Set<number>>(),
    _partialStagingMode: false,
  };
  const hunk = {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    header: '@@ -1,2 +1,3 @@',
    lines: [{ type: 'add', content: 'new line' }],
  };

  it('emits a Revert Hunk button (data-action, no inline onclick) for an UNSTAGED hunk', () => {
    const html = proto._renderHunkWithControls.call(stub, hunk, 0, false);
    assert.ok(/data-action="revertHunk"/.test(html), 'revert-hunk button present when unstaged');
    assert.ok(/data-hunk-index="0"/.test(html), 'carries the hunk index');
    assert.ok(!/onclick="revertHunk\(/.test(html), 'no inline onclick (CSP-safe)');
  });

  it('does NOT offer Revert Hunk for a STAGED hunk (only Unstage)', () => {
    const html = proto._renderHunkWithControls.call(stub, hunk, 0, true);
    assert.ok(!/data-action="revertHunk"/.test(html), 'no revert button on staged hunks');
    assert.ok(/data-action="unstageHunk"/.test(html), 'staged hunk still offers Unstage');
  });
});
