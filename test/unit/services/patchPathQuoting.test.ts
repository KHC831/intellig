/**
 * Path-quoting fidelity across the two seams that recover a file path from
 * git's own output: the `diff --git` header (splitPatchByFile) and the
 * per-file apply prose (parseAppliedPatchFiles).
 *
 * git emits paths in three conventions in a single run — bare, C-quoted
 * (`"caf\303\251 q.txt"`), and single-quoted raw (`'café q.txt'`) — so a
 * whitespace-delimited token grab fuses distinct files and a partial prose
 * match inflates the touched-file set. The fixtures here are verbatim
 * captures from `git diff` / `git apply --3way --verbose` (git 2.50.1).
 */
import * as assert from 'assert';
import {
  filterPatchByFiles,
  splitPatchByFile,
  uniquePatchPaths,
} from '../../../src/patches/PatchService';
import { parseAppliedPatchFiles } from '../../../src/git-core/gitProse';

/** Verbatim `git diff` headers for paths with spaces and non-ASCII bytes. */
const SPACED_PATCH =
  'diff --git a/x y.txt b/x y.txt\n' +
  'index 7898192..6178079 100644\n' +
  '--- a/x y.txt\n' +
  '+++ b/x y.txt\n' +
  '@@ -1 +1 @@\n' +
  '-a\n' +
  '+a2\n' +
  'diff --git a/z y.txt b/z y.txt\n' +
  'index 6178079..7898192 100644\n' +
  '--- a/z y.txt\n' +
  '+++ b/z y.txt\n' +
  '@@ -1 +1 @@\n' +
  '-b\n' +
  '+b2\n';

const QUOTED_PATCH =
  'diff --git "a/caf\\303\\251 q.txt" "b/caf\\303\\251 q.txt"\n' +
  'index 7898192..6178079 100644\n' +
  '--- "a/caf\\303\\251 q.txt"\n' +
  '+++ "b/caf\\303\\251 q.txt"\n' +
  '@@ -1 +1 @@\n' +
  '-c\n' +
  '+c2\n';

describe('splitPatchByFile — paths with whitespace and non-ASCII bytes', () => {
  it('keeps two distinct space-bearing paths distinct', () => {
    const segments = splitPatchByFile(SPACED_PATCH);
    assert.deepStrictEqual(
      segments.map((s) => s.path),
      ['x y.txt', 'z y.txt']
    );
  });

  it('does not fuse space-bearing paths into one pick row', () => {
    assert.deepStrictEqual(uniquePatchPaths(SPACED_PATCH), [
      { path: 'x y.txt', count: 1 },
      { path: 'z y.txt', count: 1 },
    ]);
  });

  it('decodes a C-quoted non-ASCII path back to its real name', () => {
    const segments = splitPatchByFile(QUOTED_PATCH);
    assert.deepStrictEqual(
      segments.map((s) => s.path),
      ['café q.txt']
    );
  });

  it('still reads a plain unprefixed header', () => {
    const patch = 'diff --git a/plain.txt b/plain.txt\n@@ -1 +1 @@\n-d\n+d2\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['plain.txt']
    );
  });
});

/**
 * Verbatim `git diff` for two files literally named `x b/y.txt` and
 * `z b/y.txt`. The header is genuinely ambiguous — ` b/` appears twice — and
 * git disambiguates on the `---`/`+++` lines, appending a TAB after a name
 * that carries whitespace.
 */
const AMBIGUOUS_PATCH =
  'diff --git a/x b/y.txt b/x b/y.txt\n' +
  'index 7898192..c1827f0 100644\n' +
  '--- a/x b/y.txt\t\n' +
  '+++ b/x b/y.txt\t\n' +
  '@@ -1 +1 @@\n' +
  '-a\n' +
  '+a2\n' +
  'diff --git a/z b/y.txt b/z b/y.txt\n' +
  'index 6178079..e6bfff5 100644\n' +
  '--- a/z b/y.txt\t\n' +
  '+++ b/z b/y.txt\t\n' +
  '@@ -1 +1 @@\n' +
  '-b\n' +
  '+b2\n';

describe('splitPatchByFile — paths whose name contains a b/ segment', () => {
  it('keeps two files that share an ambiguous header distinct', () => {
    assert.deepStrictEqual(
      splitPatchByFile(AMBIGUOUS_PATCH).map((s) => s.path),
      ['x b/y.txt', 'z b/y.txt']
    );
  });

  it('does not collapse them into one pick row', () => {
    assert.deepStrictEqual(uniquePatchPaths(AMBIGUOUS_PATCH), [
      { path: 'x b/y.txt', count: 1 },
      { path: 'z b/y.txt', count: 1 },
    ]);
  });

  it('filters to ONLY the selected file, not every block sharing a collapsed name', () => {
    const filtered = filterPatchByFiles(AMBIGUOUS_PATCH, ['x b/y.txt']);
    assert.ok(filtered.includes('a2'), 'the selected block is kept');
    assert.ok(!filtered.includes('b2'), 'the unselected block must NOT be applied');
  });

  it('reads the per-side lines for a quoted name too', () => {
    const patch =
      'diff --git "a/caf\\303\\251 q.txt" "b/caf\\303\\251 q.txt"\n' +
      '--- "a/caf\\303\\251 q.txt"\t\n' +
      '+++ "b/caf\\303\\251 q.txt"\t\n' +
      '@@ -1 +1 @@\n-c\n+c2\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['café q.txt']
    );
  });

  it('falls back to the old side for a deletion (+++ /dev/null)', () => {
    const patch =
      'diff --git a/del.txt b/del.txt\n' +
      'deleted file mode 100644\n' +
      '--- a/del.txt\n' +
      '+++ /dev/null\n' +
      '@@ -1 +0,0 @@\n-d\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['del.txt']
    );
  });

  it('uses the new side for an addition (--- /dev/null)', () => {
    const patch =
      'diff --git a/new.txt b/new.txt\n' +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      '+++ b/new.txt\n' +
      '@@ -0,0 +1 @@\n+n\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['new.txt']
    );
  });

  it('still falls back to the header when the per-side lines are absent', () => {
    const patch = 'diff --git a/only-header.txt b/only-header.txt\nGIT binary patch\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['only-header.txt']
    );
  });
});

/**
 * Verbatim `git diff --cached -M` for two PURE renames. A 100%-similar
 * rename carries no hunks, so there are no `---`/`+++` lines at all — the
 * unambiguous names live on `rename from` / `rename to`, without an
 * `a/`-`b/` prefix and without the trailing tab the per-side lines use.
 */
const RENAME_PATCH =
  'diff --git a/x b/y.txt b/z b/w.txt\n' +
  'similarity index 100%\n' +
  'rename from x b/y.txt\n' +
  'rename to z b/w.txt\n' +
  'diff --git a/q b/y.txt b/r b/w.txt\n' +
  'similarity index 100%\n' +
  'rename from q b/y.txt\n' +
  'rename to r b/w.txt\n';

describe('splitPatchByFile — pure renames', () => {
  it('keeps two ambiguous pure renames distinct', () => {
    assert.deepStrictEqual(
      splitPatchByFile(RENAME_PATCH).map((s) => s.path),
      ['z b/w.txt', 'r b/w.txt']
    );
  });

  it('does not collapse them into one pick row', () => {
    assert.deepStrictEqual(uniquePatchPaths(RENAME_PATCH), [
      { path: 'z b/w.txt', count: 1 },
      { path: 'r b/w.txt', count: 1 },
    ]);
  });

  it('filters to ONLY the selected rename', () => {
    const filtered = filterPatchByFiles(RENAME_PATCH, ['z b/w.txt']);
    assert.ok(filtered.includes('rename to z b/w.txt'), 'the selected rename is kept');
    assert.ok(!filtered.includes('rename to r b/w.txt'), 'the other rename must NOT be applied');
  });

  it('decodes a C-quoted rename', () => {
    const patch =
      'diff --git "a/caf\\303\\251 a.txt" "b/caf\\303\\251 b.txt"\n' +
      'similarity index 100%\n' +
      'rename from "caf\\303\\251 a.txt"\n' +
      'rename to "caf\\303\\251 b.txt"\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['café b.txt']
    );
  });

  it('does not strip a leading a/ from a rename name that really starts with it', () => {
    // `rename from`/`rename to` carry no a/-b/ prefix, so a repo path that
    // genuinely lives under `a/` must survive intact.
    const patch =
      'diff --git a/a/foo.txt b/a/bar.txt\n' +
      'similarity index 100%\n' +
      'rename from a/foo.txt\n' +
      'rename to a/bar.txt\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['a/bar.txt']
    );
  });

  it('prefers the rename lines when --no-prefix makes the per-side lines ambiguous', () => {
    // Verbatim `git diff --cached -M --no-prefix` for a rename into a
    // top-level directory literally named `b`. The per-side line reads
    // `+++ b/moved.txt`, which is indistinguishable from a `b/` prefix, so
    // stripping eats the real directory. The rename lines never carry a
    // prefix and are therefore the only unambiguous source.
    const patch =
      'diff --git src.txt b/moved.txt\n' +
      'similarity index 80%\n' +
      'rename from src.txt\n' +
      'rename to b/moved.txt\n' +
      '--- src.txt\n' +
      '+++ b/moved.txt\n' +
      '@@ -1,5 +1,5 @@\n l1\n-l2\n+CHANGED\n l3\n l4\n l5\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['b/moved.txt']
    );
  });

  it('a rename WITH content changes agrees with its per-side lines', () => {
    const patch =
      'diff --git a/old n.txt b/new n.txt\n' +
      'similarity index 80%\n' +
      'rename from old n.txt\n' +
      'rename to new n.txt\n' +
      '--- a/old n.txt\t\n' +
      '+++ b/new n.txt\t\n' +
      '@@ -1 +1 @@\n-a\n+b\n';
    assert.deepStrictEqual(
      splitPatchByFile(patch).map((s) => s.path),
      ['new n.txt']
    );
  });

  /**
   * The CONDITION these cases pin: a path holding a ` b/` segment — a space
   * immediately before `b/` — in a block carrying neither rename lines nor
   * `---`/`+++` lines. With no other source of names the header decides, and
   * the greedy patterns backtrack past the true boundary.
   *
   * Binary blocks and pure mode changes are the reachable instances TODAY, not
   * the definition. A third shape satisfying both conditions would fail the
   * same way, so re-derive from the condition rather than extending the list by
   * analogy. Fixtures are verbatim `git diff` (git 2.50.1).
   */
  describe('blocks whose only source of names is the header', () => {
    // Two DIFFERENT files, each under a directory whose name ends in ` b`, so
    // both headers contain a literal ' b/' and admit several readings.
    const TWO_BINARIES_WITH_B_SEGMENT =
      'diff --git a/x b/pic.bin b/x b/pic.bin\n' +
      'index b6f8b9a..bcbd643 100644\n' +
      'Binary files a/x b/pic.bin and b/x b/pic.bin differ\n' +
      'diff --git a/z b/pic.bin b/z b/pic.bin\n' +
      'index ed0d458..7d4e16a 100644\n' +
      'Binary files a/z b/pic.bin and b/z b/pic.bin differ\n';

    it('keeps two binaries under ` b`-suffixed directories apart', () => {
      assert.deepStrictEqual(
        splitPatchByFile(TWO_BINARIES_WITH_B_SEGMENT).map((s) => s.path),
        ['x b/pic.bin', 'z b/pic.bin']
      );
    });

    it('offers one pick row per binary rather than fusing them', () => {
      assert.deepStrictEqual(uniquePatchPaths(TWO_BINARIES_WITH_B_SEGMENT), [
        { path: 'x b/pic.bin', count: 1 },
        { path: 'z b/pic.bin', count: 1 },
      ]);
    });

    it('applies only the selected binary', () => {
      // Selecting one row must not drag the other file along: the two headers
      // differ only in a segment the greedy reading discarded.
      const filtered = filterPatchByFiles(TWO_BINARIES_WITH_B_SEGMENT, ['x b/pic.bin']);

      assert.strictEqual((filtered.match(/^diff --git /gm) ?? []).length, 1);
      assert.ok(filtered.includes('a/x b/pic.bin'));
      assert.ok(!filtered.includes('a/z b/pic.bin'), 'the unselected binary stays out');
    });

    it('keeps the directory of a pure mode change on a ` b/`-segment path', () => {
      // A mode change is the other block with neither rename lines nor
      // per-side lines, so it reaches the header arm exactly as a binary does.
      // Verbatim `git diff` after chmod +x on both files.
      const patch =
        'diff --git a/plain.sh b/plain.sh\n' +
        'old mode 100644\n' +
        'new mode 100755\n' +
        'diff --git a/x b/tool.sh b/x b/tool.sh\n' +
        'old mode 100644\n' +
        'new mode 100755\n';

      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['plain.sh', 'x b/tool.sh']
      );
      assert.ok(
        filterPatchByFiles(patch, ['x b/tool.sh']).includes('new mode 100755'),
        'the mode change is selectable by its true path'
      );
    });

    it('still separates two plain binaries', () => {
      // Negative control: no ' b/' segment, so this shape parses correctly even
      // with the header arm greedy. It fails only if the arm breaks outright.
      const patch =
        'diff --git a/logo.bin b/logo.bin\n' +
        'index 0a1b2c3..3c2b1a0 100644\n' +
        'Binary files a/logo.bin and b/logo.bin differ\n' +
        'diff --git a/pic.bin b/pic.bin\n' +
        'index b6f8b9a..bcbd643 100644\n' +
        'Binary files a/pic.bin and b/pic.bin differ\n';

      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['logo.bin', 'pic.bin']
      );
    });

    it('still separates a binary from its namesake in a real `b/` directory', () => {
      // Negative control: a genuine top-level `b/` directory is NOT the
      // trigger — the header has one reading because there is one space.
      const patch =
        'diff --git a/b/pic.bin b/b/pic.bin\n' +
        'index 0a1b2c3..3c2b1a0 100644\n' +
        'Binary files a/b/pic.bin and b/b/pic.bin differ\n' +
        'diff --git a/pic.bin b/pic.bin\n' +
        'index b6f8b9a..bcbd643 100644\n' +
        'Binary files a/pic.bin and b/pic.bin differ\n';

      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['b/pic.bin', 'pic.bin']
      );
    });
  });

  describe('--no-prefix blocks that carry no rename lines', () => {
    // Verbatim `git diff --no-prefix` of a MODIFICATION to a file in a real
    // top-level `b/` directory. There are no rename lines, so the rename arm
    // cannot help and the per-side arm sees `--- b/moved.txt`.
    const NO_PREFIX_MODIFICATION =
      'diff --git b/moved.txt b/moved.txt\n' +
      'index 4cb29ea..18e24a3 100644\n' +
      '--- b/moved.txt\n' +
      '+++ b/moved.txt\n' +
      '@@ -1,3 +1,3 @@\n one\n-two\n+CHANGED\n three\n';

    it('keeps the real `b/` directory in the path', () => {
      assert.deepStrictEqual(
        splitPatchByFile(NO_PREFIX_MODIFICATION).map((s) => s.path),
        ['b/moved.txt']
      );
    });

    it('is selectable by its true path', () => {
      // The defect was silent: the row said `moved.txt`, so selecting the file
      // the user actually saw applied nothing at all.
      const filtered = filterPatchByFiles(NO_PREFIX_MODIFICATION, ['b/moved.txt']);

      assert.ok(filtered.length > 0, 'the block survives selection by its true path');
      assert.ok(filtered.includes('+CHANGED'));
    });

    it('still strips a genuine a/-b/ prefix pair', () => {
      // Negative control: the ordinary prefixed shape must keep being stripped.
      const patch =
        'diff --git a/kept.txt b/kept.txt\n' +
        'index 4cb29ea..18e24a3 100644\n' +
        '--- a/kept.txt\n' +
        '+++ b/kept.txt\n' +
        '@@ -1 +1 @@\n-a\n+b\n';

      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['kept.txt']
      );
    });

    it('keeps a real top-level `b/` directory when --no-prefix ADDS a file', () => {
      // Verbatim `git diff --cached --no-prefix` adding a file into a real
      // top-level `b/` directory. The old side is /dev/null, so it carries no
      // prefix to pair against and the new side cannot be judged alone: the
      // header names both sides and is the only two-sided evidence here.
      const patch =
        'diff --git b/new.txt b/new.txt\n' +
        'new file mode 100644\n' +
        'index 0000000..d5f7fc3\n' +
        '--- /dev/null\n' +
        '+++ b/new.txt\n' +
        '@@ -0,0 +1 @@\n+added\n';
      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['b/new.txt']
      );
    });

    it('still strips the prefix on a PREFIXED add', () => {
      // Control: declining to judge a one-sided block must not leave every add
      // unstripped. Here the header pairs `a/`+`b/`, so the prefix is real.
      const patch =
        'diff --git a/new.txt b/new.txt\n' +
        'new file mode 100644\n' +
        'index 0000000..d5f7fc3\n' +
        '--- /dev/null\n' +
        '+++ b/new.txt\n' +
        '@@ -0,0 +1 @@\n+added\n';
      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['new.txt']
      );
    });

    it('keeps a real top-level `b/` directory when --no-prefix DELETES a file', () => {
      // The mirror case: the new side is /dev/null, so the old side would be
      // judging alone.
      const patch =
        'diff --git b/gone.txt b/gone.txt\n' +
        'deleted file mode 100644\n' +
        'index d5f7fc3..0000000\n' +
        '--- b/gone.txt\n' +
        '+++ /dev/null\n' +
        '@@ -1 +0,0 @@\n-gone\n';
      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['b/gone.txt']
      );
    });

    it('keeps a real top-level `a/` directory under --no-prefix', () => {
      // The mirror of the `b/` case: an unprefixed patch whose file lives in a
      // real `a/` directory must not lose it either.
      const patch =
        'diff --git a/moved.txt a/moved.txt\n' +
        'index 4cb29ea..18e24a3 100644\n' +
        '--- a/moved.txt\n' +
        '+++ a/moved.txt\n' +
        '@@ -1 +1 @@\n-a\n+b\n';

      assert.deepStrictEqual(
        splitPatchByFile(patch).map((s) => s.path),
        ['a/moved.txt']
      );
    });
  });
});

describe('parseAppliedPatchFiles — the three quoting conventions of one run', () => {
  /**
   * Verbatim `git apply --3way --verbose` output. `Checking patch` and the
   * bare `Applied patch` arm print the C-quoted name; `Applied patch to`
   * prints the decoded name in single quotes. All three name ONE file.
   */
  const MIXED_OUTPUT =
    'Checking patch "caf\\303\\251 x.txt"...\n' +
    "Applied patch to 'café x.txt' cleanly.\n" +
    'Applied patch "caf\\303\\251 x.txt" cleanly.\n';

  it('collapses all three shapes of one path to a single decoded entry', () => {
    assert.deepStrictEqual(parseAppliedPatchFiles(MIXED_OUTPUT), ['café x.txt']);
  });

  it('recognises the bare `Applied patch <name> cleanly.` arm', () => {
    assert.deepStrictEqual(parseAppliedPatchFiles('Applied patch plain.txt cleanly.\n'), [
      'plain.txt',
    ]);
  });

  it('keeps a two-file run at two entries', () => {
    const out =
      'Checking patch "caf\\303\\251 x.txt"...\n' +
      'Checking patch plain.txt...\n' +
      "Applied patch to 'café x.txt' cleanly.\n" +
      "Applied patch to 'plain.txt' cleanly.\n";
    assert.deepStrictEqual(parseAppliedPatchFiles(out).sort(), ['café x.txt', 'plain.txt']);
  });

  it('collapses the conflicted arm onto the same decoded entry', () => {
    const out =
      'Checking patch "caf\\303\\251 x.txt"...\n' +
      "Applied patch to 'café x.txt' with conflicts.\n" +
      'Applied patch "caf\\303\\251 x.txt" cleanly.\n';
    assert.deepStrictEqual(parseAppliedPatchFiles(out), ['café x.txt']);
  });
});
