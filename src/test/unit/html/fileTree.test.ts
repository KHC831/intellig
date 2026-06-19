/**
 * Unit / example tests for buildFileTree() in
 * src/git-core/gitToolWindow/html/fileTree.ts
 *
 * Follows the detailsPanel.test.ts style: Mocha describe/it + node assert.
 * Pins the empty-input behaviour and the design's "File-tree forest example"
 * (a compacted src/main/java directory node, App.java before Util.java, ordered
 * before the root-level README.md leaf).
 */

import '../../setup';
import * as assert from 'assert';
import {
  buildFileTree,
  renderFileTree,
  IDirectoryNode,
  IFileLeaf,
  IFileTreeRenderDeps,
} from '../../../git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../../git-core/interfaces/IGitToolWindowProvider';
import { FileStatus } from '../../../git-core/interfaces/IGitService';

describe('buildFileTree()', () => {
  describe('empty input', () => {
    it('should return an empty forest for an empty file list', () => {
      assert.deepStrictEqual(buildFileTree([]), [], 'buildFileTree([]) should be []');
    });
  });

  describe('File-tree forest example (design section "File-tree forest example")', () => {
    // Input (flat), matching the design's worked example.
    const fixture: IChangedFile[] = [
      { path: 'src/main/java/App.java', status: 'modified' },
      { path: 'src/main/java/Util.java', status: 'added' },
      { path: 'README.md', status: 'modified' },
    ];

    it('should produce a top level with the directory before the root-level file', () => {
      const forest = buildFileTree(fixture);

      assert.strictEqual(forest.length, 2, 'top level should have exactly two nodes');
      assert.strictEqual(
        forest[0].kind,
        'directory',
        'the directory node should sort before the root-level file'
      );
      assert.strictEqual(
        forest[1].kind,
        'file',
        'the root-level README.md leaf should come after the directory'
      );
    });

    it('should compact src/main/java into a single directory node', () => {
      const forest = buildFileTree(fixture);
      const dir = forest[0] as IDirectoryNode;

      assert.strictEqual(dir.kind, 'directory');
      assert.strictEqual(
        dir.name,
        'src/main/java',
        'the single-child directory chain should be compacted into one /-joined node'
      );
    });

    it('should order App.java before Util.java inside the compacted directory', () => {
      const forest = buildFileTree(fixture);
      const dir = forest[0] as IDirectoryNode;

      assert.strictEqual(dir.children.length, 2, 'directory should hold the two java files');
      assert.strictEqual(dir.children[0].kind, 'file');
      assert.strictEqual(dir.children[1].kind, 'file');

      const first = dir.children[0];
      const second = dir.children[1];
      assert.strictEqual(first.name, 'App.java', 'App.java should sort first');
      assert.strictEqual(second.name, 'Util.java', 'Util.java should sort second');
    });

    it('should render the root-level README.md as a top-level leaf', () => {
      const forest = buildFileTree(fixture);
      const leaf = forest[1] as IFileLeaf;

      assert.strictEqual(leaf.kind, 'file');
      assert.strictEqual(leaf.name, 'README.md', 'root-level file keeps its base name');
    });

    it('should carry the original IChangedFile verbatim on each leaf', () => {
      const forest = buildFileTree(fixture);
      const dir = forest[0] as IDirectoryNode;
      const app = dir.children[0] as IFileLeaf;
      const readme = forest[1] as IFileLeaf;

      assert.deepStrictEqual(
        app.file,
        { path: 'src/main/java/App.java', status: 'modified' },
        'leaf should retain the full original path and status'
      );
      assert.deepStrictEqual(
        readme.file,
        { path: 'README.md', status: 'modified' },
        'root leaf should retain the full original path and status'
      );
    });
  });
});

/**
 * Collapsible directory-tree rendering contract.
 *
 * IntelliJ-parity: every directory row carries a chevron toggle and wraps its
 * descendants in a single container so collapse is a one-class/display toggle.
 * The tree opens fully expanded (chevron pointing down, aria-expanded="true",
 * no hidden container) with no persistence.
 */
describe('renderFileTree() — collapsible directory chevrons', () => {
  const deps: IFileTreeRenderDeps = {
    escapeHtml: (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
    statusColor: (status: FileStatus): string => `var(--status-${status})`,
    statusChar: (status: FileStatus): string => status.charAt(0).toUpperCase(),
    fileName: (path: string): string => {
      const segments = path.split('/').filter((s) => s.length > 0);
      return segments.length === 0 ? path : segments[segments.length - 1];
    },
    commitHash: 'deadbeef',
  };

  const fixture: IChangedFile[] = [
    { path: 'src/main/java/App.java', status: 'modified' },
    { path: 'src/main/java/util/Helpers.java', status: 'added' },
    { path: 'README.md', status: 'modified' },
  ];

  it('emits a chevron toggle on each directory row (codicon-chevron-down, expanded)', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    // Two directory rows in the fixture: compacted `src/main/java` and `util`.
    const chevrons = (html.match(/class="dir-chevron[^"]*codicon-chevron-down/g) ?? []).length;
    assert.strictEqual(chevrons, 2, 'every directory row must carry a down-chevron toggle');
  });

  it('marks every directory row aria-expanded="true" by default', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    const expanded = (html.match(/aria-expanded="true"/g) ?? []).length;
    assert.strictEqual(expanded, 2, 'both directory rows default to expanded');
    assert.ok(
      !html.includes('aria-expanded="false"'),
      'no directory row may default to collapsed (no persistence, all-expanded on open)'
    );
  });

  it('wraps each directory’s descendants in a single children container', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    // One container per directory so collapse is a single toggle.
    const containers = (html.match(/class="changed-dir-children"/g) ?? []).length;
    assert.strictEqual(containers, 2, 'each directory wraps its children in one container');
  });

  it('uses tree/treeitem a11y roles for the directory tree', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    assert.ok(html.includes('role="treeitem"'), 'directory rows use role="treeitem"');
    assert.ok(html.includes('role="group"'), 'children container uses role="group"');
  });

  it('associates each directory with its children via a stable id', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    // Each directory row references the children container it controls.
    const controls = (html.match(/aria-controls="dir-children-/g) ?? []).length;
    assert.strictEqual(controls, 2, 'each directory row points at its children container id');
  });

  it('renders all rows visible on initial render (no collapsed/hidden markup)', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    assert.ok(!html.includes('changed-dir-collapsed'), 'no row is collapsed on initial render');
    // All three files present in the output.
    assert.ok(html.includes('App.java'));
    assert.ok(html.includes('Helpers.java'));
    assert.ok(html.includes('README.md'));
  });

  it('makes each directory row keyboard-focusable with tabindex="0"', () => {
    const html = renderFileTree(buildFileTree(fixture), 0, deps);

    // Both directory rows are interactive (toggle on Enter/Space), so each
    // must be in the tab order — matching the focusable file leaves.
    const dirRowTabindex = (html.match(/class="changed-dir-item"[^>]*tabindex="0"/g) ?? []).length;
    assert.strictEqual(dirRowTabindex, 2, 'each directory row must carry tabindex="0"');
  });
});
