/**
 * The commit dialog's stylesheet is a quarter of its file and reaches the
 * webview through exactly one seam: `_getHtmlContent` inlines it into a
 * `<style>` block. Nothing else renders it, so if that seam breaks the dialog
 * still opens — unstyled — and every DOM assertion elsewhere keeps passing.
 *
 * These pins characterize the seam and the stylesheet's load-bearing content
 * before the builder moves out of the class, and stay afterwards as the fence.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitDialog } from '../../../src/commits/CommitDialog';
import { Uri } from '../../mocks/vscode';
import type { IGitService } from '../../../src/git-core/interfaces/IGitService';

/** Reach the private render seam the way the other CommitDialog suites do. */
interface IRenderSurface {
  _getHtmlContent(webview: vscode.Webview): string;
}

function surface(): { dialog: CommitDialog; render: IRenderSurface } {
  const dialog = new CommitDialog(Uri.file('/tmp/ext'), {} as IGitService);
  return { dialog, render: dialog as unknown as IRenderSurface };
}

/** Minimal webview: the seam only needs a CSP source and a URI mapper. */
const WEBVIEW = {
  cspSource: 'vscode-webview://test',
  asWebviewUri: (uri: vscode.Uri) => uri,
} as unknown as vscode.Webview;

/** The `<style>` block of a rendered document, as the webview receives it. */
function styleBlockOf(render: IRenderSurface): string {
  const html = render._getHtmlContent(WEBVIEW);
  const open = html.indexOf('<style>');
  assert.ok(open >= 0, 'the rendered document must carry a <style> block');
  const close = html.indexOf('</style>', open);
  assert.ok(close > open, 'the <style> block must be closed');
  return html.slice(open + '<style>'.length, close);
}

/** The `<style>` block's contents from a throwaway dialog. */
function renderedStyles(): string {
  const { dialog, render } = surface();
  try {
    return styleBlockOf(render);
  } finally {
    dialog.dispose();
  }
}

describe('commit dialog: stylesheet seam', () => {
  it('inlines the stylesheet into the rendered document', () => {
    const styles = renderedStyles();
    // Non-vacuity: an empty or truncated builder still produces a <style>
    // block, so assert there is a real stylesheet in it. The dialog's CSS has
    // been ~500 lines for its whole life; 2,000 characters is a floor no real
    // version approaches, not a size assertion.
    assert.ok(
      styles.length > 2000,
      `expected a full stylesheet inside <style>, got ${styles.length} characters`
    );
    assert.ok(
      styles.includes('.commit-dialog'),
      'the stylesheet must style the dialog root the body element carries'
    );
  });

  it('seeds the VS Code font variables it falls back on', () => {
    // Every later rule reads --vscode-font-family / --vscode-font-size; the
    // :root block is what guarantees they resolve when the host theme has not
    // supplied them (jsdom, or a theme that clears them).
    const styles = renderedStyles();
    assert.match(styles, /:root\s*\{[^}]*--vscode-font-family:/);
    assert.match(styles, /:root\s*\{[^}]*--vscode-font-size:/);
  });

  it('references no external resources the CSP would block', () => {
    // The document's CSP is built with images:false and fonts:false, so a
    // url(...) pointing off-host is not a styling nicety that degrades — it is
    // a blocked request. Local data: URIs stay legal.
    const styles = renderedStyles();
    const offHost = [...styles.matchAll(/url\(\s*['"]?([^'")]+)/g)]
      .map((m) => m[1].trim())
      .filter((ref) => !ref.startsWith('data:'));
    assert.deepStrictEqual(
      offHost,
      [],
      `the stylesheet must not fetch external resources: ${offHost.join(', ')}`
    );
  });

  it('renders the same stylesheet regardless of dialog state', () => {
    // The builder reads no dialog state, which is what lets it live outside the
    // class. Asserted through the render seam rather than against the builder
    // directly, so it keeps its teeth if state is ever threaded back in as an
    // argument: dynamic values belong in the data-init island, not the CSS.
    const { dialog, render } = surface();
    try {
      const before = styleBlockOf(render);
      Object.assign(dialog as unknown as Record<string, unknown>, {
        _amendMode: true,
        _committing: true,
        _partialStagingMode: true,
        _stagedFiles: [{ path: 'a.ts', status: 'Modified' }],
        _selectedFilePath: 'a.ts',
      });
      assert.strictEqual(
        styleBlockOf(render),
        before,
        'the stylesheet must not vary with dialog state'
      );
    } finally {
      dialog.dispose();
    }
  });
});
