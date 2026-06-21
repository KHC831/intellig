import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  buildFileTree,
  FileTreeNode,
  IDirectoryNode,
} from '../../src/git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../src/git-core/interfaces/IGitToolWindowProvider';
import { FileStatus } from '../../src/git-core/interfaces/IGitService';

// Feature: git-view-layout-parity, Property 2

/**
 * Property-based tests for the Changed Files directory tree builder.
 *
 * Property 2: Single-child directory chains are fully compacted
 *
 * For any set of changed files, no `DirectoryNode` in `buildFileTree(files)`
 * has exactly one child that is itself a `DirectoryNode` — every such chain
 * has been merged into one node whose label is the `/`-joined segments.
 *
 */
describe('File Tree Compaction Property Tests', () => {
  /**
   * A small pool of directory segment names. Drawing from a constrained pool
   * makes shared prefixes likely (exercising shared directory nodes) while
   * still allowing deep, unique single-child chains to form.
   */
  const segmentArb: fc.Arbitrary<string> = fc.constantFrom(
    'src',
    'main',
    'java',
    'com',
    'org',
    'util',
    'app',
    'lib',
    'core',
    'a',
    'b',
    'c'
  );

  /** File base names paired with an extension, drawn from a small pool. */
  const fileNameArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom('App', 'Util', 'Main', 'index', 'helper', 'README', 'x', 'y'),
      fc.constantFrom('.ts', '.js', '.java', '.md', '.txt')
    )
    .map(([base, ext]) => base + ext);

  /** All FileStatus values, so `renamed`/`oldPath` paths are exercised too. */
  const fileStatusArb: fc.Arbitrary<FileStatus> = fc.constantFrom(
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied',
    'untracked',
    'ignored',
    'conflicted'
  );

  /**
   * A path made of 0–5 directory segments plus a file name. Depth varies so
   * deep single-child chains (e.g. `src/main/java/com/App.java`) are produced
   * and must be compacted into one node.
   */
  const cleanPathArb: fc.Arbitrary<string> = fc
    .tuple(fc.array(segmentArb, { minLength: 0, maxLength: 5 }), fileNameArb)
    .map(([dirs, name]) => [...dirs, name].join('/'));

  /**
   * An adversarial path that injects empty segments via leading/trailing/
   * doubled separators, so the builder's empty-segment handling is exercised
   * without violating the no-empty-name invariant.
   */
  const adversarialPathArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom('', '/', '//'),
      fc.array(segmentArb, { minLength: 0, maxLength: 4 }),
      fc.constantFrom('', '/', '//'),
      fileNameArb
    )
    .map(([lead, dirs, mid, name]) => lead + dirs.join(mid || '/') + (mid || '') + name);

  const pathArb: fc.Arbitrary<string> = fc.oneof(
    { weight: 4, arbitrary: cleanPathArb },
    { weight: 1, arbitrary: adversarialPathArb }
  );

  const changedFileArb: fc.Arbitrary<IChangedFile> = fc
    .tuple(pathArb, fileStatusArb, fc.option(cleanPathArb, { nil: undefined }))
    .map(([path, status, oldPath]) =>
      status === 'renamed' && oldPath !== undefined ? { path, status, oldPath } : { path, status }
    );

  /**
   * Arrays of changed files with unique paths (the Details Panel only ever
   * renders distinct file paths). Depth and prefix sharing are intentionally
   * varied to surface compaction edge cases.
   */
  const changedFilesArb: fc.Arbitrary<IChangedFile[]> = fc
    .array(changedFileArb, { minLength: 0, maxLength: 12 })
    .map((files) => {
      const seen = new Set<string>();
      const unique: IChangedFile[] = [];
      for (const f of files) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          unique.push(f);
        }
      }
      return unique;
    });

  /**
   * Walk the forest and collect every DirectoryNode that has exactly one child
   * which is itself a DirectoryNode. Such a node would be an un-compacted chain
   * link and must never exist after `buildFileTree`.
   */
  function findUncompactedChains(nodes: readonly FileTreeNode[]): IDirectoryNode[] {
    const violations: IDirectoryNode[] = [];
    for (const node of nodes) {
      if (node.kind === 'directory') {
        if (node.children.length === 1 && node.children[0].kind === 'directory') {
          violations.push(node);
        }
        violations.push(...findUncompactedChains(node.children));
      }
    }
    return violations;
  }

  describe('Property 2: Single-child directory chains are fully compacted', () => {
    it('Property: no DirectoryNode has exactly one child that is a DirectoryNode', () => {
      fc.assert(
        fc.property(changedFilesArb, (files) => {
          const forest = buildFileTree(files);
          const violations = findUncompactedChains(forest);

          assert.strictEqual(
            violations.length,
            0,
            `Found ${violations.length} un-compacted directory chain(s) ` +
              `(single directory child not merged): ` +
              violations.map((v) => `"${v.name}"`).join(', ') +
              ` for input paths [${files.map((f) => f.path).join(', ')}]`
          );
        }),
        { numRuns: 200 }
      );
    });
  });
});
