import * as fc from 'fast-check';
import * as assert from 'assert';
import { computeChangelistCommitPlan, IChangelistCommitView } from '../../src/commits/CommitDialog';
import { runCheckinHandlers, ICheckinContext } from '../../src/commits/CheckinHandlers';

/**
 * Property tests for workstream A:
 *  - computeChangelistCommitPlan (changelist→index mapping invariants).
 *  - runCheckinHandlers (before-commit check framework invariants).
 *
 * The mapping mirrors git4idea's GitCheckinEnvironment per-changelist commit:
 * the selected changelist's files are what gets committed, and everything
 * else (in other changelists) must be excludable via the unstage delta.
 */

// Arbitrary for a set of changelists with disjoint file paths (post-reconcile
// invariant: a path lives in exactly one changelist). We build disjointness by
// prefixing each path with its changelist index.
const changelistsArb = fc
  .array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      files: fc.array(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 8 }),
          staged: fc.boolean(),
        }),
        { maxLength: 5 }
      ),
    }),
    { minLength: 1, maxLength: 5 }
  )
  .map((raw) => {
    // Force unique changelist ids and unique paths across the whole set.
    const seenIds = new Set<string>();
    const out: IChangelistCommitView[] = [];
    raw.forEach((cl, i) => {
      let id = cl.id;
      while (seenIds.has(id)) {
        id = `${id}_${i}`;
      }
      seenIds.add(id);
      const files = cl.files.map((f, j) => ({
        path: `${i}/${j}/${f.name}`,
        staged: f.staged,
      }));
      out.push({ id, files });
    });
    return out;
  });

describe('computeChangelistCommitPlan — property', () => {
  it('selectedFiles is exactly the target changelist files', () => {
    fc.assert(
      fc.property(changelistsArb, (changelists) => {
        const target = changelists[0];
        const plan = computeChangelistCommitPlan(changelists, target.id);
        assert.ok(plan);
        assert.deepStrictEqual(
          plan.selectedFiles,
          target.files.map((f) => f.path)
        );
      })
    );
  });

  it('selectedFiles is always a subset of allFiles paths', () => {
    fc.assert(
      fc.property(changelistsArb, (changelists) => {
        const target = changelists[changelists.length - 1];
        const plan = computeChangelistCommitPlan(changelists, target.id);
        assert.ok(plan);
        const allPaths = new Set(plan.allFiles.map((f) => f.path));
        for (const p of plan.selectedFiles) {
          assert.ok(allPaths.has(p), `selected ${p} missing from allFiles`);
        }
      })
    );
  });

  it('allFiles paths are unique', () => {
    fc.assert(
      fc.property(changelistsArb, (changelists) => {
        const plan = computeChangelistCommitPlan(changelists, changelists[0].id);
        assert.ok(plan);
        const paths = plan.allFiles.map((f) => f.path);
        assert.strictEqual(new Set(paths).size, paths.length);
      })
    );
  });

  it('every staged file NOT in the target appears in allFiles (so it can be unstaged)', () => {
    fc.assert(
      fc.property(changelistsArb, (changelists) => {
        const target = changelists[0];
        const plan = computeChangelistCommitPlan(changelists, target.id);
        assert.ok(plan);
        const targetPaths = new Set(target.files.map((f) => f.path));
        const allByPath = new Map(plan.allFiles.map((f) => [f.path, f.staged]));
        for (const cl of changelists) {
          if (cl.id === target.id) {
            continue;
          }
          for (const f of cl.files) {
            if (f.staged) {
              assert.ok(!targetPaths.has(f.path));
              assert.strictEqual(allByPath.get(f.path), true);
            }
          }
        }
      })
    );
  });
});

describe('runCheckinHandlers — property', () => {
  const contextArb: fc.Arbitrary<ICheckinContext> = fc.record({
    userName: fc.option(fc.string(), { nil: undefined }),
    userEmail: fc.option(fc.string(), { nil: undefined }),
    userIdentityResolved: fc.boolean(),
    detachedHead: fc.boolean(),
    files: fc.array(
      fc.record({
        path: fc.string({ minLength: 1 }),
        status: fc.constantFrom(
          'modified',
          'added',
          'deleted',
          'conflicted',
          'untracked'
        ) as fc.Arbitrary<ICheckinContext['files'][number]['status']>,
      }),
      { maxLength: 6 }
    ),
  });

  it('hasBlockingProblem iff at least one error-severity problem exists', () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        const result = runCheckinHandlers(ctx);
        const anyError = result.problems.some((p) => p.severity === 'error');
        assert.strictEqual(result.hasBlockingProblem, anyError);
      })
    );
  });

  it('never blocks when identity is unresolved AND no conflicts (only detached can warn)', () => {
    fc.assert(
      fc.property(
        contextArb.filter((c) => !c.files.some((f) => f.status === 'conflicted')),
        (ctx) => {
          const result = runCheckinHandlers({ ...ctx, userIdentityResolved: false });
          assert.strictEqual(result.hasBlockingProblem, false);
        }
      )
    );
  });

  it('a conflicted file in the commit always produces a blocking problem', () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        const withConflict: ICheckinContext = {
          ...ctx,
          userName: 'Kit',
          userEmail: 'k@e.com',
          userIdentityResolved: true,
          files: [...ctx.files, { path: 'conflict.ts', status: 'conflicted' }],
        };
        const result = runCheckinHandlers(withConflict);
        assert.strictEqual(result.hasBlockingProblem, true);
      })
    );
  });
});
