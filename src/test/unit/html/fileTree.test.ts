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
  DirectoryNode,
  FileLeaf,
} from '../../../git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../../git-core/interfaces/IGitToolWindowProvider';

describe('buildFileTree()', () => {
  describe('empty input', () => {
    it('should return an empty forest for an empty file list', () => {
      assert.deepStrictEqual(buildFileTree([]), [], 'buildFileTree([]) should be []');
    });
  });

  describe('File-tree forest example (design §"File-tree forest example")', () => {
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
      const dir = forest[0] as DirectoryNode;

      assert.strictEqual(dir.kind, 'directory');
      assert.strictEqual(
        dir.name,
        'src/main/java',
        'the single-child directory chain should be compacted into one /-joined node'
      );
    });

    it('should order App.java before Util.java inside the compacted directory', () => {
      const forest = buildFileTree(fixture);
      const dir = forest[0] as DirectoryNode;

      assert.strictEqual(dir.children.length, 2, 'directory should hold the two java files');
      assert.strictEqual(dir.children[0].kind, 'file');
      assert.strictEqual(dir.children[1].kind, 'file');

      const first = dir.children[0] as FileLeaf;
      const second = dir.children[1] as FileLeaf;
      assert.strictEqual(first.name, 'App.java', 'App.java should sort first');
      assert.strictEqual(second.name, 'Util.java', 'Util.java should sort second');
    });

    it('should render the root-level README.md as a top-level leaf', () => {
      const forest = buildFileTree(fixture);
      const leaf = forest[1] as FileLeaf;

      assert.strictEqual(leaf.kind, 'file');
      assert.strictEqual(leaf.name, 'README.md', 'root-level file keeps its base name');
    });

    it('should carry the original IChangedFile verbatim on each leaf', () => {
      const forest = buildFileTree(fixture);
      const dir = forest[0] as DirectoryNode;
      const app = dir.children[0] as FileLeaf;
      const readme = forest[1] as FileLeaf;

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
