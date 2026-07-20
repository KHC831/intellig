/**
 * Companion spec for scripts/check-commit-details-builder.mjs.
 *
 * The guard exists because ICommitDetails carries fields a hand-typed literal
 * compiles happily without — dropping the "Committed by / on" line for exactly
 * the rewritten commits it describes. Every arm gets a fixture that FAILS and,
 * where the arm has a passing twin, one that passes, so a case cannot go green
 * by matching nothing.
 *
 * Re-proving the guard against real history: use the commit BEFORE the
 * details-panel base builder was introduced, and extract with
 * `git show <rev>:<path>` into a fixture root.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-commit-details-builder.mjs');

function makeFixture(source: string): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'details-builder-'));
  fs.mkdirSync(path.join(root, 'panel'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'details.ts'), source);
  return root;
}

function runGuard(root: string): { code: number; output: string } {
  try {
    return { code: 0, output: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const FIELDS = `hash: 'x', message: 'm', changedFiles: []`;

describe('check-commit-details-builder guard', () => {
  describe('annotated declarations', () => {
    it('fails a hand-built literal assigned to an annotated const', () => {
      const result = runGuard(makeFixture(`const d: ICommitDetails = { ${FIELDS} };`));

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /details\.ts:1/);
    });

    it('passes when the literal spreads the builder', () => {
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { ...commitToBaseDetails(c), ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 0);
    });

    it('fails a hand-built arm of a ternary initialiser', () => {
      // The literal does not follow the `=`, which is what a shape-matching
      // rule required. Both arms produce the annotated value.
      const result = runGuard(
        makeFixture(
          `const d: ICommitDetails = f ? { ...commitToBaseDetails(c), ${FIELDS} } : { ${FIELDS} };`
        )
      );

      assert.strictEqual(result.code, 1, 'every arm of the initialiser is a producer');
    });

    it('fails a hand-built element of an annotated array literal', () => {
      const result = runGuard(makeFixture(`const list: ICommitDetails[] = [{ ${FIELDS} }];`));

      assert.strictEqual(result.code, 1);
    });

    it('fails a hand-built literal returned from a .map into an annotated array', () => {
      const result = runGuard(
        makeFixture(`const list: ICommitDetails[] = nodes.map((n) => ({ ${FIELDS} }));`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('passes a .map whose literal spreads the builder', () => {
      const result = runGuard(
        makeFixture(
          `const list: ICommitDetails[] = nodes.map((n) => ({ ...commitNodeToBaseDetails(n), ${FIELDS} }));`
        )
      );

      assert.strictEqual(result.code, 0, 'the builder is what the arm is looking for');
    });

    it('fails an Array<ICommitDetails> annotation as well as the bracket form', () => {
      const result = runGuard(makeFixture(`const list: Array<ICommitDetails> = [{ ${FIELDS} }];`));

      assert.strictEqual(result.code, 1);
    });
  });

  describe('assertions', () => {
    it('fails a hand-built literal cast with `as`', () => {
      assert.strictEqual(
        runGuard(makeFixture(`const d = { ${FIELDS} } as ICommitDetails;`)).code,
        1
      );
    });

    it('honours the exempt annotation inside a cast literal', () => {
      // The cast arm slices the reported body from the ORIGINAL text; were it
      // to report the code view instead, the annotation would be blanked and
      // this exemption would silently stop working.
      const result = runGuard(
        makeFixture(
          `const d = { /* commit-details-builder-exempt: fixture */ ${FIELDS} } as ICommitDetails;`
        )
      );

      assert.strictEqual(result.code, 0);
    });

    it('fails a hand-built literal asserted with `satisfies`', () => {
      // `satisfies` is the modern spelling of the same assertion.
      const result = runGuard(makeFixture(`const d = { ${FIELDS} } satisfies ICommitDetails;`));

      assert.strictEqual(result.code, 1);
    });
  });

  describe('returns', () => {
    it('fails a hand-built literal returned from an annotated function', () => {
      const result = runGuard(
        makeFixture(`function build(): ICommitDetails {\n  return { ${FIELDS} };\n}`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a hand-built arm sitting beside a builder arm', () => {
      // The builder test is per-return, not per-body: one compliant path must
      // not vouch for the others.
      const result = runGuard(
        makeFixture(
          `function build(f: boolean): ICommitDetails {\n` +
            `  if (f) {\n    return { ...commitToBaseDetails(c), ${FIELDS} };\n  }\n` +
            `  return { ${FIELDS} };\n}`
        )
      );

      assert.strictEqual(result.code, 1, 'each return builds its own value');
    });

    it('passes when every return spreads the builder', () => {
      const result = runGuard(
        makeFixture(
          `function build(f: boolean): ICommitDetails {\n` +
            `  if (f) {\n    return { ...commitToBaseDetails(c), ${FIELDS} };\n  }\n` +
            `  return { ...commitNodeToBaseDetails(n), ${FIELDS} };\n}`
        )
      );

      assert.strictEqual(result.code, 0);
    });
  });

  describe('array push', () => {
    it('fails a hand-built literal pushed into an annotated array', () => {
      const result = runGuard(
        makeFixture(`const list: ICommitDetails[] = [];\nlist.push({ ${FIELDS} });`)
      );

      assert.strictEqual(result.code, 1);
    });
  });

  describe('panel-builder arm', () => {
    // This arm has its own reason to exist: the literal is an ARGUMENT, so no
    // annotation names the type anywhere in the statement.
    it('fails a hand-built literal passed to a details-panel builder', () => {
      const result = runGuard(makeFixture(`_getDetailsPanelModel(c, { ${FIELDS} });`));

      assert.strictEqual(result.code, 1);
    });

    it('passes the same call when the literal spreads the builder', () => {
      const result = runGuard(
        makeFixture(`_getDetailsPanelModel(c, { ...commitToBaseDetails(c), ${FIELDS} });`)
      );

      assert.strictEqual(result.code, 0);
    });
  });

  describe('declared-then-assigned arm', () => {
    // This arm sees ASSIGNMENTS that follow a declaration, whether or not the
    // declaration carried an initialiser of its own. Arm (a) covers only the
    // initialiser, so a fixture with no later assignment proves nothing here.
    it('fails a literal assigned to a variable declared earlier', () => {
      const result = runGuard(
        makeFixture(`let d: ICommitDetails | undefined;\nd = { ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('passes the deferred assignment when it spreads the builder', () => {
      const result = runGuard(
        makeFixture(
          `let d: ICommitDetails | undefined;\nd = { ...commitToBaseDetails(c), ${FIELDS} };`
        )
      );

      assert.strictEqual(result.code, 0);
    });
  });

  describe('brace matching reads code, not string contents', () => {
    it('sees a builder spread that follows a brace inside a string', () => {
      // Matching braces in raw text ended the literal at the `}` in the string,
      // so the spread after it was invisible and compliant code was reported.
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { message: '}', ...commitToBaseDetails(c) };`)
      );

      assert.strictEqual(result.code, 0, 'a brace in a string does not end the literal');
    });

    it('still reports a hand-built literal containing a brace in a string', () => {
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { message: '}', ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 1);
    });
  });

  describe('the builder must be composed, not merely mentioned', () => {
    it('fails a literal that only names the builder in a comment', () => {
      // Testing compliance against raw text let any author silence the fence
      // with a one-line comment. Composing is a code question.
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { /* ...commitToBaseDetails(c) */ ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('fails a literal that only names the builder inside a string', () => {
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { note: '...commitToBaseDetails(c)', ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 1);
    });

    it('still passes a literal that really spreads the builder', () => {
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { ...commitToBaseDetails(c), ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 0, 'the code view must not blank a real spread');
    });
  });

  describe('initialiser walk: shapes and boundaries', () => {
    it('fails a hand-built logical-OR fallback', () => {
      // The cache-miss shape: the fallback arm produces the annotated value.
      const result = runGuard(makeFixture(`const d: ICommitDetails = cached || { ${FIELDS} };`));

      assert.strictEqual(result.code, 1);
    });

    it('fails a hand-built logical-AND fallback', () => {
      const result = runGuard(makeFixture(`const d: ICommitDetails = ok && { ${FIELDS} };`));

      assert.strictEqual(result.code, 1);
    });

    it('reports an outer literal once, not again for each nested literal', () => {
      // The walk skips past a literal it has already reported; without that the
      // nested `author` object would be judged on its own and reported too.
      const result = runGuard(
        makeFixture(`const d: ICommitDetails = { author: { name: 'n' }, ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 1);
      assert.strictEqual(
        (result.output.match(/details\.ts:/g) ?? []).length,
        1,
        'one offence, one line reported'
      );
    });

    it('fails a hand-built element after a comma in an array initialiser', () => {
      const result = runGuard(
        makeFixture(
          `const list: ICommitDetails[] = [{ ...commitToBaseDetails(a) }, { ${FIELDS} }];`
        )
      );

      assert.strictEqual(result.code, 1, 'every element is a producer');
    });

    it('stops the initialiser at its own statement, not a later literal', () => {
      // The walk ends at the `;` that closes the declaration. Running past it
      // would drag the next statement's literal in and report it here.
      const result = runGuard(
        makeFixture(
          `const d: ICommitDetails = { ...commitToBaseDetails(c) };\nconst other = { plain: 1 };`
        )
      );

      assert.strictEqual(result.code, 0, 'the next statement is not part of the initialiser');
    });

    it('fails a reassignment to a variable that was declared WITH an initialiser', () => {
      // Arm (a) covers the initialiser only. Excluding initialised declarations
      // from arm (b) left every later assignment to them unchecked.
      const result = runGuard(
        makeFixture(`let d: ICommitDetails = { ...commitToBaseDetails(c) };\nd = { ${FIELDS} };`)
      );

      assert.strictEqual(result.code, 1);
    });
  });

  describe('escape hatch and scope', () => {
    it('passes a literal carrying the exempt annotation', () => {
      const result = runGuard(
        makeFixture(
          `const d: ICommitDetails = { /* commit-details-builder-exempt: fixture */ ${FIELDS} };`
        )
      );

      assert.strictEqual(result.code, 0);
    });

    it('does NOT accept the exempt annotation spelled inside a string', () => {
      // The hatch is a claim, and a claim has to be a comment. Reading it off
      // raw text accepted a string that merely contained the words.
      const result = runGuard(
        makeFixture(
          `const d: ICommitDetails = { note: 'commit-details-builder-exempt: nope', ${FIELDS} };`
        )
      );

      assert.strictEqual(result.code, 1, 'only a real comment may exempt');
    });

    it('does not exempt a literal from a comment on the preceding line', () => {
      // The annotation is scoped to the literal it exempts. One line above the
      // statement would blanket a ternary's arms, and this fence reports each
      // arm separately.
      const result = runGuard(
        makeFixture(
          `// commit-details-builder-exempt: too broad\nconst d: ICommitDetails = { ${FIELDS} };`
        )
      );

      assert.strictEqual(result.code, 1);
    });

    it('ignores a literal with no ICommitDetails relationship', () => {
      const result = runGuard(makeFixture(`const d = { ${FIELDS} };`));

      assert.strictEqual(result.code, 0, 'an unrelated literal is not this guard business');
    });

    it('fails loudly when the scan root does not exist', () => {
      // Reporting OK over a root it never read would read as a pass.
      const result = runGuard(path.join(SCRATCH_ROOT, 'details-builder-absent'));

      assert.strictEqual(result.code, 1);
      assert.match(result.output, /does not exist/);
    });
  });
});
