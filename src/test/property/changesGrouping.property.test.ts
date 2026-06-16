import * as fc from 'fast-check';
import * as assert from 'assert';
import { groupFilesByDirectory, partitionUnversionedFiles } from '../../commits/CommitToolWindow';
import type { IChangelist, IFileChange } from '../../changelists/interfaces/IChangelistService';

/**
 * Property tests for the Local Changes grouping + Unversioned Files split
 * (workstream A item 4). Invariants:
 *  - directory grouping is loss-free (every file appears exactly once).
 *  - each file lands in the bucket matching its directory.
 *  - partitioning unversioned files never loses or duplicates a file.
 */

const statusArb = fc.constantFrom<IFileChange['status']>(
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked'
);

const fileArb: fc.Arbitrary<IFileChange> = fc
  .record({
    segments: fc.array(
      fc.string({ minLength: 1, maxLength: 5 }).filter((s) => !s.includes('/')),
      {
        minLength: 1,
        maxLength: 4,
      }
    ),
    status: statusArb,
  })
  .map((r) => ({ path: r.segments.join('/'), status: r.status, staged: false }));

// Files with unique paths.
const uniqueFilesArb = fc.uniqueArray(fileArb, {
  maxLength: 12,
  selector: (f) => f.path,
});

describe('groupFilesByDirectory — property', () => {
  it('is loss-free: every file appears exactly once across buckets', () => {
    fc.assert(
      fc.property(uniqueFilesArb, (files) => {
        const nodes = groupFilesByDirectory(files);
        const flattened = nodes.flatMap((n) => n.files.map((f) => f.path)).sort();
        const original = files.map((f) => f.path).sort();
        assert.deepStrictEqual(flattened, original);
      })
    );
  });

  it('each file is in the bucket whose dir matches the file path', () => {
    fc.assert(
      fc.property(uniqueFilesArb, (files) => {
        const nodes = groupFilesByDirectory(files);
        for (const node of nodes) {
          for (const f of node.files) {
            const slash = f.path.lastIndexOf('/');
            const dir = slash === -1 ? '' : f.path.slice(0, slash);
            assert.strictEqual(dir, node.dir);
          }
        }
      })
    );
  });

  it('buckets are sorted by directory', () => {
    fc.assert(
      fc.property(uniqueFilesArb, (files) => {
        const dirs = groupFilesByDirectory(files).map((n) => n.dir);
        const sorted = [...dirs].sort((a, b) => a.localeCompare(b));
        assert.deepStrictEqual(dirs, sorted);
      })
    );
  });
});

describe('partitionUnversionedFiles — property', () => {
  it('preserves all files (tracked ∪ unversioned == original)', () => {
    fc.assert(
      fc.property(uniqueFilesArb, (files) => {
        const changelists: IChangelist[] = [
          { id: 'def', name: 'Default', isDefault: true, isActive: true, files },
        ];
        const { changelists: tracked, unversioned } = partitionUnversionedFiles(changelists);
        const out = [
          ...tracked.flatMap((c) => c.files.map((f) => f.path)),
          ...unversioned.map((f) => f.path),
        ].sort();
        assert.deepStrictEqual(out, files.map((f) => f.path).sort());
      })
    );
  });

  it('the unversioned bucket holds exactly the untracked files', () => {
    fc.assert(
      fc.property(uniqueFilesArb, (files) => {
        const changelists: IChangelist[] = [
          { id: 'def', name: 'Default', isDefault: true, isActive: true, files },
        ];
        const { unversioned } = partitionUnversionedFiles(changelists);
        assert.deepStrictEqual(
          unversioned.map((f) => f.path).sort(),
          files
            .filter((f) => f.status === 'untracked')
            .map((f) => f.path)
            .sort()
        );
      })
    );
  });

  it('no tracked changelist still contains an untracked file', () => {
    fc.assert(
      fc.property(uniqueFilesArb, (files) => {
        const changelists: IChangelist[] = [
          { id: 'def', name: 'Default', isDefault: true, isActive: true, files },
        ];
        const { changelists: tracked } = partitionUnversionedFiles(changelists);
        for (const cl of tracked) {
          assert.ok(!cl.files.some((f) => f.status === 'untracked'));
        }
      })
    );
  });
});
