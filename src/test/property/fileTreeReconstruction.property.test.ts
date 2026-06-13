import * as fc from 'fast-check';
import * as assert from 'assert';
import { buildFileTree, FileTreeNode } from '../../git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../git-core/interfaces/IGitToolWindowProvider';
import { FileStatus } from '../../git-core/interfaces/IGitService';

// Feature: git-view-layout-parity, Property 1

/**
 * Property-based tests for the Changed Files directory tree builder.
 *
 * Property 1: Tree reconstruction preserves the exact file path set
 *
 * For any set of changed files, flattening `buildFileTree(files)` —
 * concatenating each `DirectoryNode` label with `/` down to each `FileLeaf`
 * name — yields a collection of paths equal to the original set of
 * `file.path` values, with every input path appearing exactly once as a leaf.
 *
 * This validates that files are grouped under directory nodes (2.1), that
 * files sharing a common leading path collapse into one shared directory node
 * rather than being duplicated or dropped (2.3), that root-level files (no
 * `/`) appear as top-level leaves (2.4), that the total leaf count equals the
 * input file count (2.7), and that each leaf's directory depth equals its
 * ancestor-directory count (2.2 structural).
 *
 * Normalization note: `buildFileTree`/`insertFile` split each path on `/` and
 * drop empty segments (from `//`, leading/trailing `/`), so the reconstructed
 * path is the *normalized* path. A path that is empty or only separators
 * yields no usable segments and is carried verbatim as a top-level leaf named
 * by the original `file.path`. The expected set is therefore the input paths
 * normalized the same way (see `normalizePath`).
 *
 */
describe('File Tree Reconstruction Property Tests', () => {
  /**
   * Normalize a path the same way `insertFile` does: split on `/`, drop empty
   * segments, rejoin with `/`. A path with no usable segments (empty or only
   * separators) is carried verbatim as the leaf name, so it normalizes to
   * itself.
   */
  function normalizePath(path: string): string {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    return segments.length === 0 ? path : segments.join('/');
  }

  /**
   * Flatten the forest into the set of reconstructed leaf paths by joining
   * each ancestor `DirectoryNode` label with `/` down to each `FileLeaf` name.
   */
  function flattenLeafPaths(nodes: readonly FileTreeNode[], prefix: string): string[] {
    const paths: string[] = [];
    for (const node of nodes) {
      if (node.kind === 'directory') {
        paths.push(...flattenLeafPaths(node.children, `${prefix}${node.name}/`));
      } else {
        paths.push(`${prefix}${node.name}`);
      }
    }
    return paths;
  }

  /**
   * A small pool of directory segment names (mixed case). Drawing from a
   * constrained pool makes shared prefixes likely (exercising shared directory
   * nodes) while still allowing deep, unique chains to form.
   */
  const segmentArb: fc.Arbitrary<string> = fc.constantFrom(
    'src',
    'main',
    'java',
    'com',
    'org',
    'util',
    'App',
    'LIB',
    'Core',
    'a',
    'B',
    'c'
  );

  /** File base names (mixed case) paired with an extension, from a small pool. */
  const fileNameArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom('App', 'Util', 'Main', 'index', 'README', 'x', 'Y'),
      fc.constantFrom('.ts', '.js', '.java', '.md', '.txt')
    )
    .map(([base, ext]) => base + ext);

  /** All FileStatus values, so `renamed`/`oldPath` entries are exercised too. */
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
   * A clean path made of 0–5 directory segments plus a file name. Depth 0
   * means a root-level file (no `/`), so top-level leaves are exercised.
   */
  const cleanPathArb: fc.Arbitrary<string> = fc
    .tuple(fc.array(segmentArb, { minLength: 0, maxLength: 5 }), fileNameArb)
    .map(([dirs, name]) => [...dirs, name].join('/'));

  /**
   * An adversarial path that injects empty segments via leading/trailing/
   * doubled separators, so the builder's empty-segment normalization is
   * exercised. These normalize back to a clean path.
   */
  const adversarialPathArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom('', '/', '//'),
      fc.array(segmentArb, { minLength: 0, maxLength: 4 }),
      fileNameArb,
      fc.constantFrom('/', '//')
    )
    .map(([lead, dirs, name, sep]) => lead + [...dirs, name].join(sep));

  /**
   * A path consisting only of separators (or empty). These yield no usable
   * segments, so the file is carried as a top-level leaf named by the original
   * path — the root-leaf case the property must still reconstruct exactly.
   */
  const separatorOnlyPathArb: fc.Arbitrary<string> = fc.constantFrom('', '/', '//', '///');

  const pathArb: fc.Arbitrary<string> = fc.oneof(
    { weight: 5, arbitrary: cleanPathArb },
    { weight: 2, arbitrary: adversarialPathArb },
    { weight: 1, arbitrary: separatorOnlyPathArb }
  );

  const changedFileArb: fc.Arbitrary<IChangedFile> = fc
    .tuple(pathArb, fileStatusArb, fc.option(cleanPathArb, { nil: undefined }))
    .map(([path, status, oldPath]) =>
      status === 'renamed' && oldPath !== undefined ? { path, status, oldPath } : { path, status }
    );

  /**
   * Arrays of changed files deduplicated by their *normalized* path. Two
   * distinct raw paths (e.g. `a/b.txt` and `/a/b.txt`) reconstruct to the same
   * leaf path, so deduping by the normalized form keeps the expected set free
   * of accidental collisions and lets the "each path appears exactly once"
   * assertion be meaningful. Depth and prefix sharing are intentionally varied.
   */
  const changedFilesArb: fc.Arbitrary<IChangedFile[]> = fc
    .array(changedFileArb, { minLength: 0, maxLength: 14 })
    .map((files) => {
      const seen = new Set<string>();
      const unique: IChangedFile[] = [];
      for (const f of files) {
        const key = normalizePath(f.path);
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(f);
        }
      }
      return unique;
    });

  describe('Property 1: Tree reconstruction preserves the exact file path set', () => {
    it('Property: flattening buildFileTree yields exactly the normalized input path set, each once', () => {
      fc.assert(
        fc.property(changedFilesArb, (files) => {
          const forest = buildFileTree(files);
          const reconstructed = flattenLeafPaths(forest, '').sort();
          const expected = files.map((f) => normalizePath(f.path)).sort();

          // The reconstructed leaf path set equals the normalized input set,
          // with no path dropped, duplicated, or invented (2.1, 2.3, 2.4, 2.7).
          assert.deepStrictEqual(
            reconstructed,
            expected,
            `Reconstructed leaf paths [${reconstructed.join(', ')}] should equal ` +
              `normalized input paths [${expected.join(', ')}] for input ` +
              `[${files.map((f) => f.path).join(', ')}]`
          );

          // Each path appears exactly once as a leaf: leaf count equals input
          // count and there are no duplicates among reconstructed paths.
          assert.strictEqual(
            reconstructed.length,
            files.length,
            `Leaf count (${reconstructed.length}) should equal input file count (${files.length})`
          );
          assert.strictEqual(
            new Set(reconstructed).size,
            reconstructed.length,
            `Reconstructed paths should contain no duplicates: [${reconstructed.join(', ')}]`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
