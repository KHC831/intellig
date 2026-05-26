import * as assert from 'assert';
import {
  parseStatus,
  statusCodeToFileStatus,
  parseStashList,
  parseRemotes,
  parseHead,
  parseRepositoryState,
  parseHunks,
  parseDiff,
  parseBranches,
  parseLog,
  parseTags,
  getLogFormat,
  getBranchFormat,
  getTagFormat,
} from '../../../utils/gitParser';

describe('Git Parser Utilities', () => {
  describe('parseStatus', () => {
    it('should parse modified files', () => {
      const output = ' M src/file.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/file.ts');
      assert.strictEqual(result[0].indexStatus, ' ');
      assert.strictEqual(result[0].workTreeStatus, 'M');
    });

    it('should parse added files', () => {
      const output = 'A  src/newfile.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/newfile.ts');
      assert.strictEqual(result[0].indexStatus, 'A');
      assert.strictEqual(result[0].workTreeStatus, ' ');
    });

    it('should parse untracked files', () => {
      const output = '?? src/untracked.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/untracked.ts');
      assert.strictEqual(result[0].indexStatus, '?');
      assert.strictEqual(result[0].workTreeStatus, '?');
    });

    it('should parse renamed files', () => {
      const output = 'R  old.ts -> new.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'new.ts');
      assert.strictEqual(result[0].renamed, 'old.ts');
      assert.strictEqual(result[0].indexStatus, 'R');
    });

    it('should parse multiple files', () => {
      const output = ' M file1.ts\nA  file2.ts\n?? file3.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 3);
    });

    it('should handle empty output', () => {
      const result = parseStatus('');
      assert.strictEqual(result.length, 0);
    });

    it('should parse deleted files', () => {
      const output = 'D  src/deleted.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/deleted.ts');
      assert.strictEqual(result[0].indexStatus, 'D');
      assert.strictEqual(result[0].workTreeStatus, ' ');
    });

    it('should parse copied files', () => {
      const output = 'C  original.ts -> copy.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'copy.ts');
      assert.strictEqual(result[0].indexStatus, 'C');
    });

    it('should parse unmerged/conflicted files (both modified)', () => {
      const output = 'UU src/conflict.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/conflict.ts');
      assert.strictEqual(result[0].indexStatus, 'U');
      assert.strictEqual(result[0].workTreeStatus, 'U');
    });

    it('should parse unmerged files (added by us)', () => {
      const output = 'AU src/added-by-us.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/added-by-us.ts');
      assert.strictEqual(result[0].indexStatus, 'A');
      assert.strictEqual(result[0].workTreeStatus, 'U');
    });

    it('should parse unmerged files (deleted by them)', () => {
      const output = 'UD src/deleted-by-them.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/deleted-by-them.ts');
      assert.strictEqual(result[0].indexStatus, 'U');
      assert.strictEqual(result[0].workTreeStatus, 'D');
    });

    it('should parse ignored files', () => {
      const output = '!! node_modules/\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'node_modules/');
      assert.strictEqual(result[0].indexStatus, '!');
      assert.strictEqual(result[0].workTreeStatus, '!');
    });

    it('should parse staged and modified files', () => {
      const output = 'MM src/both.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/both.ts');
      assert.strictEqual(result[0].indexStatus, 'M');
      assert.strictEqual(result[0].workTreeStatus, 'M');
    });

    it('should parse files with spaces in path', () => {
      const output = ' M src/my file.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/my file.ts');
    });

    it('should parse renamed files in work tree', () => {
      const output = ' R old name.ts -> new name.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'new name.ts');
      assert.strictEqual(result[0].renamed, 'old name.ts');
      assert.strictEqual(result[0].workTreeStatus, 'R');
    });

    it('should skip lines that are too short', () => {
      const output = 'AB\n M valid.ts\n';
      const result = parseStatus(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'valid.ts');
    });
  });

  describe('statusCodeToFileStatus', () => {
    it('should return conflicted for U status', () => {
      assert.strictEqual(statusCodeToFileStatus('U', ' '), 'conflicted');
      assert.strictEqual(statusCodeToFileStatus(' ', 'U'), 'conflicted');
    });

    it('should return added for A status', () => {
      assert.strictEqual(statusCodeToFileStatus('A', ' '), 'added');
    });

    it('should return deleted for D status', () => {
      assert.strictEqual(statusCodeToFileStatus('D', ' '), 'deleted');
    });

    it('should return renamed for R status', () => {
      assert.strictEqual(statusCodeToFileStatus('R', ' '), 'renamed');
    });

    it('should return copied for C status', () => {
      assert.strictEqual(statusCodeToFileStatus('C', ' '), 'copied');
    });

    it('should return untracked for ? status', () => {
      assert.strictEqual(statusCodeToFileStatus(' ', '?'), 'untracked');
    });

    it('should return ignored for ! status', () => {
      assert.strictEqual(statusCodeToFileStatus(' ', '!'), 'ignored');
    });

    it('should return modified for M status', () => {
      assert.strictEqual(statusCodeToFileStatus('M', ' '), 'modified');
      assert.strictEqual(statusCodeToFileStatus(' ', 'M'), 'modified');
    });
  });

  describe('parseRemotes', () => {
    it('should parse remote with fetch and push URLs', () => {
      const output =
        'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)\n';
      const result = parseRemotes(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'origin');
      assert.strictEqual(result[0].fetchUrl, 'https://github.com/user/repo.git');
      assert.strictEqual(result[0].pushUrl, 'https://github.com/user/repo.git');
    });

    it('should parse multiple remotes', () => {
      const output =
        'origin\thttps://github.com/user/repo.git (fetch)\n' +
        'origin\thttps://github.com/user/repo.git (push)\n' +
        'upstream\thttps://github.com/other/repo.git (fetch)\n' +
        'upstream\thttps://github.com/other/repo.git (push)\n';
      const result = parseRemotes(output);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'origin');
      assert.strictEqual(result[1].name, 'upstream');
    });

    it('should handle empty output', () => {
      const result = parseRemotes('');
      assert.strictEqual(result.length, 0);
    });
  });

  describe('parseStashList', () => {
    it('should parse stash entries', () => {
      const output =
        'stash@{0}: WIP on main: abc1234 Some commit message\nstash@{1}: On feature: def5678 Another message\n';
      const result = parseStashList(output);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].index, 0);
      assert.strictEqual(result[0].branch, 'main');
      assert.strictEqual(result[1].index, 1);
      assert.strictEqual(result[1].branch, 'feature');
    });

    it('should handle empty output', () => {
      const result = parseStashList('');
      assert.strictEqual(result.length, 0);
    });
  });

  describe('parseHead', () => {
    it('should parse branch name from refs/heads/', () => {
      const result = parseHead('refs/heads/main', 'abc123');

      assert.strictEqual(result.name, 'main');
      assert.strictEqual(result.commit, 'abc123');
    });

    it('should parse upstream information', () => {
      const result = parseHead('refs/heads/main', 'abc123', 'origin/main', '2\t3');

      assert.strictEqual(result.upstream?.remote, 'origin');
      assert.strictEqual(result.upstream?.name, 'main');
      assert.strictEqual(result.ahead, 2);
      assert.strictEqual(result.behind, 3);
    });

    it('should handle detached HEAD', () => {
      const result = parseHead('abc123', 'abc123');

      // In detached HEAD state, the branch output is the commit hash itself
      // which doesn't start with refs/, so it's treated as the branch name
      assert.strictEqual(result.name, 'abc123');
      assert.strictEqual(result.commit, 'abc123');
    });
  });

  describe('parseRepositoryState', () => {
    it('should detect rebasing state', () => {
      assert.strictEqual(parseRepositoryState('rebase in progress'), 'rebasing');
      assert.strictEqual(parseRepositoryState('interactive rebase in progress'), 'rebasing');
    });

    it('should detect merging state', () => {
      assert.strictEqual(parseRepositoryState('merge in progress'), 'merging');
      assert.strictEqual(parseRepositoryState('You have unmerged paths'), 'merging');
    });

    it('should detect cherry-picking state', () => {
      assert.strictEqual(parseRepositoryState('cherry-pick in progress'), 'cherry-picking');
    });

    it('should detect reverting state', () => {
      assert.strictEqual(parseRepositoryState('revert in progress'), 'reverting');
    });

    it('should return idle for normal state', () => {
      assert.strictEqual(parseRepositoryState('On branch main\nnothing to commit'), 'idle');
    });
  });

  describe('parseHunks', () => {
    it('should parse a simple hunk', () => {
      const lines = [
        '@@ -1,3 +1,4 @@ function test() {',
        ' line1',
        '-line2',
        '+line2modified',
        '+newline',
        ' line3',
      ];
      const result = parseHunks(lines);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].oldStart, 1);
      assert.strictEqual(result[0].oldLines, 3);
      assert.strictEqual(result[0].newStart, 1);
      assert.strictEqual(result[0].newLines, 4);
      assert.strictEqual(result[0].lines.length, 5);
    });

    it('should parse multiple hunks', () => {
      const lines = [
        '@@ -1,2 +1,2 @@',
        ' line1',
        '-old',
        '+new',
        '@@ -10,2 +10,3 @@',
        ' line10',
        '+added',
        ' line11',
      ];
      const result = parseHunks(lines);

      assert.strictEqual(result.length, 2);
    });

    it('should handle hunk with single line counts', () => {
      const lines = ['@@ -1 +1 @@', '-old', '+new'];
      const result = parseHunks(lines);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].oldStart, 1);
      assert.strictEqual(result[0].oldLines, 1);
      assert.strictEqual(result[0].newStart, 1);
      assert.strictEqual(result[0].newLines, 1);
    });

    it('should correctly identify line types', () => {
      const lines = ['@@ -1,3 +1,3 @@', ' context', '-deleted', '+added'];
      const result = parseHunks(lines);

      assert.strictEqual(result[0].lines[0].type, 'context');
      assert.strictEqual(result[0].lines[0].content, 'context');
      assert.strictEqual(result[0].lines[1].type, 'delete');
      assert.strictEqual(result[0].lines[1].content, 'deleted');
      assert.strictEqual(result[0].lines[2].type, 'add');
      assert.strictEqual(result[0].lines[2].content, 'added');
    });

    it('should handle empty lines as context', () => {
      const lines = ['@@ -1,2 +1,2 @@', '', '-old'];
      const result = parseHunks(lines);

      assert.strictEqual(result[0].lines[0].type, 'context');
    });
  });

  describe('parseDiff', () => {
    it('should parse a simple diff', () => {
      const output = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2modified
+newline
 line3
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/file.ts');
      assert.strictEqual(result[0].status, 'modified');
      assert.strictEqual(result[0].binary, false);
      assert.strictEqual(result[0].hunks.length, 1);
    });

    it('should parse new file diff', () => {
      const output = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/new.ts');
      assert.strictEqual(result[0].status, 'added');
    });

    it('should parse deleted file diff', () => {
      const output = `diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/deleted.ts');
      assert.strictEqual(result[0].status, 'deleted');
    });

    it('should parse renamed file diff', () => {
      const output = `diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'new.ts');
      assert.strictEqual(result[0].oldPath, 'old.ts');
      assert.strictEqual(result[0].status, 'renamed');
    });

    it('should parse copied file diff', () => {
      const output = `diff --git a/original.ts b/copy.ts
copy from original.ts
copy to copy.ts
--- a/original.ts
+++ b/copy.ts
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'copy.ts');
      assert.strictEqual(result[0].status, 'copied');
    });

    it('should detect binary files', () => {
      const output = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'image.png');
      assert.strictEqual(result[0].binary, true);
    });

    it('should parse multiple file diffs', () => {
      const output = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old1
+new1
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old2
+new2
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].path, 'file1.ts');
      assert.strictEqual(result[1].path, 'file2.ts');
    });

    it('should handle empty diff output', () => {
      const result = parseDiff('');
      assert.strictEqual(result.length, 0);
    });

    it('should parse diff with multiple hunks', () => {
      const output = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,2 +1,2 @@
 line1
-old
+new
@@ -10,2 +10,3 @@
 line10
+added
 line11
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].hunks.length, 2);
    });
  });

  describe('format functions', () => {
    it('getLogFormat should return a valid format string', () => {
      const format = getLogFormat();
      assert.ok(format.includes('%H')); // Full hash
      assert.ok(format.includes('%h')); // Short hash
      assert.ok(format.includes('%an')); // Author name
      assert.ok(format.includes('%ae')); // Author email
    });

    it('Wave I — getLogFormat default separator is `\\x1f` (ASCII Unit Separator)', () => {
      // Pinned by Wave I: the previous `|` default collided with names
      // containing `|`. Switching to `\x1f` (an unprintable C0 control
      // character that never appears in normalised git idents) makes
      // parseLog round-trip such names safely.
      const format = getLogFormat();
      assert.ok(format.includes('\x1f'), `expected \\x1f in default format, got ${format}`);
      assert.ok(!format.includes('|'), 'default format must not embed pipe separator');
    });

    it('Wave I — getLogFormat accepts an explicit separator override', () => {
      // Explicit override path: parseLog/parseCommit forward whatever
      // separator the caller sets, so legacy callers can still pass `|`.
      const format = getLogFormat('|');
      assert.ok(format.includes('|'));
      assert.ok(!format.includes('\x1f'));
    });
  });

  describe('parseLog (Wave I — `\\x1f` separator)', () => {
    /**
     * parseLog-separator-1 (Wave I): an author name containing `|`
     * round-trips correctly under the new `\x1f` separator. Pre-Wave-I
     * `Alice|Bob` would have split mid-field and corrupted every later
     * field (email → date → committer name → …).
     */
    it('parseLog-separator-1: author with literal `|` in name parses cleanly', () => {
      const sep = '\x1f';
      const fields = [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // %H
        'aaaaaaa', // %h
        'Alice|Bob', // %an  ← contains a pipe
        'alice@example.com', // %ae
        '2024-05-01T12:00:00Z', // %aI
        'Alice|Bob', // %cn
        'alice@example.com', // %ce
        '2024-05-01T12:00:00Z', // %cI
        '', // %P (no parents)
        'Subject line', // %s
      ];
      const output = fields.join(sep) + '\n\0';
      const commits = parseLog(output);
      assert.strictEqual(commits.length, 1);
      assert.strictEqual(commits[0].author.name, 'Alice|Bob');
      assert.strictEqual(commits[0].committer.name, 'Alice|Bob');
      assert.strictEqual(commits[0].author.email, 'alice@example.com');
      assert.strictEqual(commits[0].message, 'Subject line');
    });

    /**
     * parseLog-separator-2 (Wave I): multi-commit log round-trips under
     * the new separator. Confirms the entry split on `\0` and the field
     * split on `\x1f` are independent.
     */
    it('parseLog-separator-2: multi-commit round-trip under `\\x1f`', () => {
      const sep = '\x1f';
      const mkEntry = (h: string, msg: string): string =>
        [
          h.padEnd(40, '0'),
          h.substring(0, 7),
          'Author',
          'a@x.com',
          '2024-05-01T12:00:00Z',
          'Author',
          'a@x.com',
          '2024-05-01T12:00:00Z',
          '',
          msg,
        ].join(sep) + '\n';
      const output = mkEntry('aa', 'first') + '\0' + mkEntry('bb', 'second') + '\0';
      const commits = parseLog(output);
      assert.strictEqual(commits.length, 2);
      assert.strictEqual(commits[0].message, 'first');
      assert.strictEqual(commits[1].message, 'second');
    });

    it('getBranchFormat should return a valid format string', () => {
      const format = getBranchFormat();
      assert.ok(format.includes('%(refname)'));
      assert.ok(format.includes('%(objectname)'));
    });

    it('getTagFormat should return a valid format string', () => {
      const format = getTagFormat();
      assert.ok(format.includes('%(refname)'));
      assert.ok(format.includes('%(objecttype)'));
    });

    it('Wave I R1 — getTagFormat default separator is `\\x1f` (ASCII Unit Separator)', () => {
      // Pinned by Wave I R1: the previous `|` default collided with
      // tagger names containing `|`. Switching to `\x1f` (an unprintable
      // C0 control character that never appears in normalised git
      // idents) makes parseTags round-trip such names safely.
      const format = getTagFormat();
      assert.ok(format.includes('\x1f'), `expected \\x1f in default format, got ${format}`);
      assert.ok(!format.includes('|'), 'default format must not embed pipe separator');
    });

    it('Wave I R1 — getTagFormat accepts an explicit separator override', () => {
      // Explicit override path: parseTags forwards whatever separator
      // the caller sets, so legacy callers can still pass `|`.
      const format = getTagFormat('|');
      assert.ok(format.includes('|'));
      assert.ok(!format.includes('\x1f'));
    });

    /**
     * parseTags-separator-1 (Wave I R1): a tagger name containing `|`
     * round-trips correctly under the new `\x1f` separator. Pre-Wave-I-R1
     * the literal `|` in `Alice|Bob` would have split mid-field and
     * corrupted email → date → subject downstream. Mirrors
     * `parseLog-separator-1` (Wave I).
     */
    it('parseTags-separator-1: tagger with literal `|` in name parses cleanly', () => {
      const sep = '\x1f';
      const fields = [
        'refs/tags/v1.0.0', // %(refname)
        'abc123def456', // %(*objectname)%(objectname)
        'tag', // %(objecttype) — annotated
        'Alice|Bob', // %(taggername)  ← contains a pipe
        'alice@example.com', // %(taggeremail)
        '2024-05-01T12:00:00+00:00', // %(taggerdate:iso)
        'Release | with pipe in subject', // %(subject)
      ];
      const output = fields.join(sep) + '\n';
      const tags = parseTags(output);
      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, 'v1.0.0');
      assert.strictEqual(tags[0].commit, 'abc123def456');
      assert.strictEqual(tags[0].isAnnotated, true);
      assert.ok(tags[0].tagger, 'Should have tagger');
      assert.strictEqual(tags[0].tagger?.name, 'Alice|Bob');
      assert.strictEqual(tags[0].tagger?.email, 'alice@example.com');
      assert.strictEqual(tags[0].message, 'Release | with pipe in subject');
    });
  });

  /**
   * Wave F / F3 — `parseBranches` filters git's parenthesized pseudo-refs.
   *
   * Pre-Wave-F, `git branch -a --format` lines like
   * `(HEAD detached at 5eed84b)|<sha>||*` leaked through `parseBranches`
   * as `type='local'` branches with the parenthesized name as `.name`.
   * That fake branch then propagated into the branch tree, log graph
   * chips, and `_handleNewBranchFrom`'s `startPoint = item.branch?.name`,
   * where it became the `<startPoint>` argument to
   * `git checkout -b <new> <startPoint>` — failing with
   * `fatal: '(HEAD detached at 5eed84b)' is not a commit`.
   *
   * The fix filters any refname matching `/^\(.*\)$/` (after `.trim()`).
   * The predicate is broad on purpose: it catches detached HEAD,
   * `(no branch, rebasing main)`, `(no branch, bisect started on …)`,
   * `(no branch, cherry-pick of …)`, and any future variant — git's own
   * format produces parenthesized labels for all such states.
   *
   * Detached state itself is surfaced separately via `repo.head?.commit`
   * (StatusBarService:273-276, BranchPopup:704-707) — the parser is the
   * wrong place to model it.
   */
  describe('parseBranches — Wave F pseudo-ref filtering', () => {
    it('parseBranches-detached-1: single detached pseudo-ref → returns empty array', () => {
      const output = '(HEAD detached at abc1234)|abc1234567890123456789012345678901234567890||*';
      const result = parseBranches(output);
      assert.deepStrictEqual(
        result,
        [],
        'parenthesized refname must be filtered, not pass through as a branch'
      );
    });

    it('parseBranches-detached-2: detached + 2 normal local + 1 remote → 3 branches; pseudo-ref absent', () => {
      const output = [
        '(HEAD detached at abc1234)|abc1234567890123456789012345678901234567890||*',
        'refs/heads/main|def4567890123456789012345678901234567890abc|origin/main|',
        'refs/heads/feature|ghi7890123456789012345678901234567890abcdef||',
        'refs/remotes/origin/main|def4567890123456789012345678901234567890abc||',
      ].join('\n');
      const result = parseBranches(output);

      assert.strictEqual(result.length, 3, 'expected 3 branches (detached pseudo-ref filtered)');
      const names = result.map((b) => b.name);
      assert.ok(
        !names.some((n) => n.startsWith('(')),
        `no branch.name should start with '('; got ${JSON.stringify(names)}`
      );
      assert.deepStrictEqual(names.sort(), ['feature', 'main', 'origin/main']);

      // Pin: the kept entries retain their full shape (the filter only
      // drops parenthesized lines, doesn't mangle siblings).
      const main = result.find((b) => b.name === 'main');
      assert.ok(main, 'main must survive the filter');
      assert.strictEqual(main.type, 'local');
      assert.strictEqual(main.commit, 'def4567890123456789012345678901234567890abc');
      assert.strictEqual(main.upstream?.remote, 'origin');
      assert.strictEqual(main.upstream?.name, 'main');
    });

    it('parseBranches-detached-3: mid-rebase pseudo-ref → filtered', () => {
      // git emits this during `git rebase -i` while paused.
      const output = '(no branch, rebasing main)|abc1234567890123456789012345678901234567890||*';
      const result = parseBranches(output);
      assert.deepStrictEqual(result, [], 'mid-rebase parenthesized label must be filtered');
    });

    it('parseBranches-detached-4: mid-bisect pseudo-ref → filtered', () => {
      const output =
        '(no branch, bisect started on main)|abc1234567890123456789012345678901234567890||*';
      const result = parseBranches(output);
      assert.deepStrictEqual(result, [], 'mid-bisect parenthesized label must be filtered');
    });

    it('parseBranches-detached-5: detached pseudo-ref as ONLY entry → returns empty array', () => {
      // Pin the edge case where the user is detached and the only line
      // git emits is the pseudo-ref. Pre-fix this would hand back a
      // 1-element list with a parenthesized name; post-fix the result
      // is empty so the UI shows zero branches and falls back to
      // `repo.head?.commit` for detached display.
      const output = '(HEAD detached from origin/main)|deadbeefdeadbeefdeadbeefdeadbeefdeadbeef||*';
      const result = parseBranches(output);
      assert.deepStrictEqual(result, []);
    });

    it('parseBranches-detached-6: mid-cherry-pick pseudo-ref → filtered', () => {
      // git emits this while a cherry-pick is paused on a conflict.
      // The parity doc §1.1 enumerates this as a covered variant; pin
      // it explicitly so the structural rule's coverage is auditable
      // by-fixture rather than implied by the predicate shape alone.
      const output =
        '(no branch, cherry-pick of abcdef1)|abc1234567890123456789012345678901234567890||*';
      const result = parseBranches(output);
      assert.deepStrictEqual(result, [], 'mid-cherry-pick parenthesized label must be filtered');
    });

    it('parseBranches-no-regression: existing local + remote fixtures parse unchanged (no over-filtering)', () => {
      // Pin we did NOT widen the filter so it eats real branches.
      // Note: git itself accepts `(` in refnames (`git check-ref-format
      // 'refs/heads/(foo)'` exits 0); the filter is safe NOT because
      // git rejects such names, but because real branches always emit
      // through the `refs/heads/...` / `refs/remotes/...` /
      // `refs/tags/...` prefix, so the trimmed refname starts with `r`
      // — never with `(`. This fixture exercises names with hyphens,
      // dots, slashes, and multi-segment paths to pin the filter is
      // narrow.
      const output = [
        'refs/heads/main|def4567890123456789012345678901234567890abc||*',
        'refs/heads/feature/JIRA-123|aaa4567890123456789012345678901234567890abc||',
        'refs/heads/release-1.0|bbb4567890123456789012345678901234567890abc||',
        'refs/remotes/origin/main|def4567890123456789012345678901234567890abc||',
        'refs/remotes/upstream/feature|ccc4567890123456789012345678901234567890abc||',
      ].join('\n');
      const result = parseBranches(output);

      assert.strictEqual(result.length, 5, 'all 5 normal branches must survive');
      assert.deepStrictEqual(result.map((b) => b.name).sort(), [
        'feature/JIRA-123',
        'main',
        'origin/main',
        'release-1.0',
        'upstream/feature',
      ]);
      // Type assignment must be unchanged for normal branches.
      assert.strictEqual(result.find((b) => b.name === 'main')?.type, 'local');
      assert.strictEqual(result.find((b) => b.name === 'feature/JIRA-123')?.type, 'local');
      assert.strictEqual(result.find((b) => b.name === 'origin/main')?.type, 'remote');
      assert.strictEqual(result.find((b) => b.name === 'upstream/feature')?.type, 'remote');
      // isHead set correctly — main carried `*`, others did not.
      assert.strictEqual(result.find((b) => b.name === 'main')?.isHead, true);
      assert.strictEqual(result.find((b) => b.name === 'feature/JIRA-123')?.isHead, false);
    });
  });
});
