/**
 * Property: parseHunks → serializeHunkLines round-trips a hunk body
 * byte-for-byte, INCLUDING the `\ No newline at end of file` marker.
 *
 * The marker was dropped on parse (and never emitted on build), so any
 * stage/unstage/revert/partial-shelve of a file without a trailing newline
 * produced a patch git rejected or that silently re-added a newline. This
 * pins the marker's survival across the whole parse→build cycle.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { parseHunks } from '../../src/git-core/gitParser';
import { serializeHunkLines, NO_NEWLINE_MARKER } from '../../src/git-core/patchBuilder';

/** A single diff body line: a `+`/`-`/` ` prefix plus newline-free content. */
const bodyLineArb = fc
  .tuple(
    fc.constantFrom('+', '-', ' '),
    fc.string({ maxLength: 12 }).map((s) => s.replace(/[\r\n]/g, ''))
  )
  .map(([prefix, content]) => `${prefix}${content}`);

describe('parseHunks ↔ serializeHunkLines round-trip', () => {
  it('preserves the no-newline marker at the end of a hunk body', () => {
    fc.assert(
      fc.property(
        fc.array(bodyLineArb, { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (bodyLines, trailingNoNewline) => {
          // Assemble a valid single hunk. Counts don't need to be accurate for
          // parseHunks (it reads line prefixes), so a generous header suffices.
          const header = '@@ -1,10 +1,10 @@';
          const body = trailingNoNewline ? [...bodyLines, NO_NEWLINE_MARKER] : bodyLines;
          const rawLines = [header, ...body];

          const hunks = parseHunks(rawLines);
          assert.strictEqual(hunks.length, 1, 'exactly one hunk parsed');

          const rebuilt = serializeHunkLines(hunks[0]);

          // The rebuilt body must equal the original body lines (the marker is
          // attached to the preceding line and re-emitted after it).
          assert.deepStrictEqual(rebuilt, body);

          // The marker must be modelled on the LAST content line, not floating.
          if (trailingNoNewline) {
            const last = hunks[0].lines[hunks[0].lines.length - 1];
            assert.strictEqual(last.noNewline, true, 'last line must carry noNewline');
          }
        }
      )
    );
  });

  it('attaches the marker to the correct side when both sides lack a trailing newline', () => {
    // `-old\n\ No newline\n+new\n\ No newline` — the classic modified-file-with-
    // no-trailing-newline shape. Both the delete and the add must round-trip
    // with their own marker.
    const raw = ['@@ -1 +1 @@', '-old', NO_NEWLINE_MARKER, '+new', NO_NEWLINE_MARKER];
    const [hunk] = parseHunks(raw);
    const del = hunk.lines.find((l) => l.type === 'delete');
    const add = hunk.lines.find((l) => l.type === 'add');
    assert.strictEqual(del?.noNewline, true);
    assert.strictEqual(add?.noNewline, true);
    assert.deepStrictEqual(serializeHunkLines(hunk), [
      '-old',
      NO_NEWLINE_MARKER,
      '+new',
      NO_NEWLINE_MARKER,
    ]);
  });
});
