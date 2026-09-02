import * as assert from 'assert';
import {
  parseStatus,
  statusCodeToFileStatus,
  parseStashList,
  parseRemotes,
  parseHead,
  parseHunks,
  parseDiff,
  parseBranches,
  parseContainingBranches,
  parseBlame,
  parseLog,
  parseTags,
  fullCommitMessage,
  getLogFormat,
  getBranchFormat,
  getTagFormat,
  parseLineAttrPaths,
} from '../../../src/git-core/gitParser';

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

  describe('parseStatus — NUL-delimited (-z) format', () => {
    // `git status --porcelain -z` NUL-terminates each entry and emits paths
    // VERBATIM (no C-quoting), so non-ASCII / space / newline names survive.
    // For renames/copies the SOURCE path follows the destination as the next
    // NUL token (the reverse of the human `from -> to` order).

    it('parses a NUL-terminated modified entry', () => {
      const result = parseStatus(' M src/file.ts\0');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/file.ts');
      assert.strictEqual(result[0].workTreeStatus, 'M');
    });

    it('keeps a non-ASCII filename verbatim (no C-quoting/escaping)', () => {
      const result = parseStatus('UU café.txt\0');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'café.txt');
      assert.strictEqual(result[0].indexStatus, 'U');
      assert.strictEqual(result[0].workTreeStatus, 'U');
    });

    it('keeps a filename containing spaces', () => {
      const result = parseStatus(' M my report final.txt\0');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'my report final.txt');
    });

    it('keeps a filename containing an embedded newline as ONE entry', () => {
      // The whole point of -z: a `\n` in a name must not split the entry.
      const result = parseStatus('A  weird\nname.ts\0');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'weird\nname.ts');
      assert.strictEqual(result[0].indexStatus, 'A');
    });

    it('parses a -z rename: destination first, source as the next NUL token', () => {
      const result = parseStatus('R  new name.ts\0old name.ts\0');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'new name.ts');
      assert.strictEqual(result[0].renamed, 'old name.ts');
      assert.strictEqual(result[0].indexStatus, 'R');
    });

    it('parses a -z copy: destination first, original as the next NUL token', () => {
      const result = parseStatus('C  copy.ts\0original.ts\0');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'copy.ts');
      assert.strictEqual(result[0].renamed, 'original.ts');
      assert.strictEqual(result[0].indexStatus, 'C');
    });

    it('parses multiple mixed entries including a rename without losing alignment', () => {
      const output = ' M a.ts\0R  to.ts\0from.ts\0?? café.ts\0';
      const result = parseStatus(output);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].path, 'a.ts');
      assert.strictEqual(result[1].path, 'to.ts');
      assert.strictEqual(result[1].renamed, 'from.ts');
      assert.strictEqual(result[2].path, 'café.ts');
      assert.strictEqual(result[2].indexStatus, '?');
    });
  });

  describe('statusCodeToFileStatus', () => {
    it('should return conflicted for U status', () => {
      assert.strictEqual(statusCodeToFileStatus('U', ' '), 'conflicted');
      assert.strictEqual(statusCodeToFileStatus(' ', 'U'), 'conflicted');
    });

    it('should return conflicted for AA (both-added) and DD (both-deleted)', () => {
      // Unmerged states that show no `U` column — agrees with isConflictedStatus.
      assert.strictEqual(statusCodeToFileStatus('A', 'A'), 'conflicted');
      assert.strictEqual(statusCodeToFileStatus('D', 'D'), 'conflicted');
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

    it('keeps a local-path remote whose URL contains spaces', () => {
      // `git remote -v` prints `name\turl (type)`. A local path with spaces
      // ("/Users/me/My Repos/lib") was dropped by the old `\\S+` URL match, so
      // the remote vanished from push/fetch pickers and hosting links.
      const output =
        'origin\t/Users/me/My Repos/lib (fetch)\n' + 'origin\t/Users/me/My Repos/lib (push)\n';
      const result = parseRemotes(output);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].fetchUrl, '/Users/me/My Repos/lib');
      assert.strictEqual(result[0].pushUrl, '/Users/me/My Repos/lib');
    });
  });

  describe('parseHunks — line numbering + count-bounded body', () => {
    const DIFF = [
      '@@ -1,3 +1,3 @@',
      '-x',
      '+X',
      ' mid',
      '-last',
      '\\ No newline at end of file',
      '+last!',
      '\\ No newline at end of file',
      '', // split('\n') artifact after the final newline
    ];

    it('assigns oldLineNumber/newLineNumber from the hunk header', () => {
      // Line-subset staging keys selections by these numbers, and the dialog
      // renders the per-line checkbox only when the number is defined — an
      // unnumbered parse leaves the whole line-staging surface dead.
      const [hunk] = parseHunks(DIFF);
      const [del1, add1, ctx, del2, add2] = hunk.lines;
      assert.deepStrictEqual(
        [del1.type, del1.oldLineNumber, del1.newLineNumber],
        ['delete', 1, undefined]
      );
      assert.deepStrictEqual(
        [add1.type, add1.newLineNumber, add1.oldLineNumber],
        ['add', 1, undefined]
      );
      assert.deepStrictEqual([ctx.type, ctx.oldLineNumber, ctx.newLineNumber], ['context', 2, 2]);
      assert.deepStrictEqual([del2.type, del2.oldLineNumber], ['delete', 3]);
      assert.deepStrictEqual([add2.type, add2.newLineNumber], ['add', 3]);
      assert.strictEqual(del2.noNewline, true);
      assert.strictEqual(add2.noNewline, true);
    });

    it('stops consuming at the header counts — a trailing split artifact is not a context line', () => {
      const [hunk] = parseHunks(DIFF);
      assert.strictEqual(hunk.lines.length, 5, 'exactly the counted hunk body');
      assert.ok(
        hunk.lines.every((l) => l.content !== '' || l.type !== 'context'),
        'no phantom empty context line'
      );
    });

    it('numbers a second hunk from its own header', () => {
      const twoHunks = ['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -10,2 +10,3 @@', ' k', '+n', ' t'];
      const [, second] = parseHunks(twoHunks);
      const [k, n, t] = second.lines;
      assert.strictEqual(k.oldLineNumber, 10);
      assert.strictEqual(k.newLineNumber, 10);
      assert.strictEqual(n.newLineNumber, 11);
      assert.strictEqual(t.oldLineNumber, 11);
      assert.strictEqual(t.newLineNumber, 12);
    });
  });

  describe('parseStashList', () => {
    it('parses the dated `--format=%gd<sep>%ci<sep>%gs` output incl. REAL dates', () => {
      const sep = '\x1f';
      const output =
        ['stash@{0}', '2024-05-01 12:00:00 +0000', 'WIP on main: abc1234 Some commit message'].join(
          sep
        ) +
        '\n' +
        ['stash@{1}', '2023-01-02 03:04:05 +0000', 'On feature: def5678 Another message'].join(
          sep
        ) +
        '\n';
      const result = parseStashList(output);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].index, 0);
      assert.strictEqual(result[0].branch, 'main');
      // Pin the ABSOLUTE timestamp (timezone-independent via Date.UTC) so the
      // test also catches a host/locale-dependent %ci parse, not just "not now".
      assert.strictEqual(
        result[0].date.getTime(),
        Date.UTC(2024, 4, 1, 12, 0, 0),
        'stash date must come from %ci (2024-05-01 12:00:00 UTC), not the current time'
      );
      assert.strictEqual(result[1].index, 1);
      assert.strictEqual(result[1].branch, 'feature');
      assert.strictEqual(result[1].date.getTime(), Date.UTC(2023, 0, 2, 3, 4, 5));
    });

    it('parses the optional appended %H sha (4th field) and leaves it undefined when absent', () => {
      const sep = '\x1f';
      const withHash = [
        'stash@{0}',
        '2024-05-01 12:00:00 +0000',
        'WIP on main: abc1234 msg',
        'a'.repeat(40),
      ].join(sep);
      const withoutHash = ['stash@{1}', '2023-01-02 03:04:05 +0000', 'On feature: def msg'].join(
        sep
      );
      const result = parseStashList(`${withHash}\n${withoutHash}\n`);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].hash, 'a'.repeat(40), 'sha parsed from the 4th field');
      assert.strictEqual(result[1].hash, undefined, 'no sha field → hash undefined');
    });

    it('still parses the legacy `stash@{N}: WIP on branch: msg` form (no separator)', () => {
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

    it('does not flag a TEXT diff whose content contains "Binary files ... differ"', () => {
      // git prints the binary sentinel at column 0; a content line carries a
      // +/-/space prefix, so a doc that literally writes the sentence must not
      // read as binary.
      const output = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,2 +1,3 @@
 intro
+Binary files a/x and b/y differ
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'doc.md');
      assert.strictEqual(result[0].binary, false, 'a +prefixed content line is not the sentinel');
    });

    it('detects a genuine binary combined (diff --cc) block', () => {
      const output = `diff --cc image.png
index 1111111,2222222..3333333
Binary files a/image.png and b/image.png differ
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'image.png');
      assert.strictEqual(result[0].binary, true);
    });

    it('does not flag a combined (diff --cc) block whose content contains the sentinel', () => {
      const output = `diff --cc merged.md
@@@ -1,1 -1,1 +1,2 @@@
  intro
 +Binary files a/x and b/y differ
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'merged.md');
      assert.strictEqual(
        result[0].binary,
        false,
        'a prefixed combined content line is not the sentinel'
      );
    });

    it('C-unquotes a git-quoted (non-ASCII) header path', () => {
      // git C-quotes a special-byte path in the `diff --git` header, wrapping the
      // `a/`|`b/` prefix inside the quotes with octal byte escapes
      // (é → \303\251, its UTF-8 bytes). The old `^--git a/...` regex didn't
      // match the quoted form and dropped the file from the changed-files list.
      const output =
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n' +
        'index 1111111..2222222 100644\n' +
        '--- "a/caf\\303\\251.txt"\n' +
        '+++ "b/caf\\303\\251.txt"\n' +
        '@@ -1 +1 @@\n' +
        '-old\n' +
        '+new\n';
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'café.txt');
      assert.strictEqual(result[0].status, 'modified');
    });

    it('C-unquotes both sides of a quoted rename header', () => {
      const output =
        'diff --git "a/caf\\303\\251-old.txt" "b/caf\\303\\251-new.txt"\n' +
        'rename from "caf\\303\\251-old.txt"\n' +
        'rename to "caf\\303\\251-new.txt"\n' +
        '--- "a/caf\\303\\251-old.txt"\n' +
        '+++ "b/caf\\303\\251-new.txt"\n';
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'café-new.txt');
      assert.strictEqual(result[0].oldPath, 'café-old.txt');
      assert.strictEqual(result[0].status, 'renamed');
    });

    it('still parses an unquoted (ASCII) header unchanged', () => {
      // Zero-regression guard for the bare path the quoting change must not break.
      const output =
        'diff --git a/src/plain.ts b/src/plain.ts\n' +
        '--- a/src/plain.ts\n' +
        '+++ b/src/plain.ts\n' +
        '@@ -1 +1 @@\n' +
        '-a\n' +
        '+b\n';
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/plain.ts');
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

    // ─── Combined-diff (merge commit) support — Bug A ──────────────────────
    // `git show <merge-hash>` emits combined-diff output: `diff --cc <path>`
    // headers (no a/…b/ prefixes) and `@@@` hunks. A splitter keyed only on
    // `^diff --git ` would drop these entirely, making merge commits render
    // "No changed files"; parseDiff must capture them.
    it('should parse a single-file combined (merge) diff', () => {
      const output = `diff --cc src/foo.ts
index 1234567,abcdefg..fedcba9
--- a/src/foo.ts
+++ b/src/foo.ts
@@@ -10,3 -10,5 +10,4 @@@
  context
- removed-from-parent-0
 -removed-from-parent-1
++added-by-merge
  context
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, 'src/foo.ts');
      assert.strictEqual(result[0].status, 'modified');
      assert.strictEqual(result[0].oldPath, undefined);
    });

    it('should parse a multi-file combined (merge) diff with no duplicates', () => {
      const output = `diff --cc src/a.ts
index 1111111,2222222..3333333
--- a/src/a.ts
+++ b/src/a.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++merge-a
diff --cc src/b.ts
index 4444444,5555555..6666666
--- a/src/b.ts
+++ b/src/b.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++merge-b
diff --cc src/c.ts
index 7777777,8888888..9999999
--- a/src/c.ts
+++ b/src/c.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++merge-c
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 3);
      assert.deepStrictEqual(
        result.map((d) => d.path),
        ['src/a.ts', 'src/b.ts', 'src/c.ts']
      );
      const unique = new Set(result.map((d) => d.path));
      assert.strictEqual(unique.size, 3, 'paths must be unique');
      for (const d of result) {
        assert.strictEqual(d.status, 'modified');
      }
    });

    it('should capture both --git and --cc blocks in one input', () => {
      const output = `diff --git a/regular.ts b/regular.ts
--- a/regular.ts
+++ b/regular.ts
@@ -1 +1 @@
-old
+new
diff --cc merged.ts
index 1234567,abcdefg..fedcba9
--- a/merged.ts
+++ b/merged.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++added-by-merge
`;
      const result = parseDiff(output);

      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(
        result.map((d) => d.path),
        ['regular.ts', 'merged.ts']
      );
      // Regular block keeps its hunks; combined block reports none.
      assert.ok(result[0].hunks.length >= 1, 'regular diff retains hunks');
      assert.strictEqual(result[1].hunks.length, 0, 'combined diff has no parsed hunks');
    });
  });

  describe('fullCommitMessage', () => {
    // parseLog splits %s (subject → `message`) from %b (body); this is the
    // ONE sanctioned reassembly for consumers that need what the user wrote.

    it('round-trips a subject+body commit out of parseLog', () => {
      const sep = '\x1f';
      const line = [
        'a'.repeat(40),
        'a'.repeat(7),
        'Author',
        'a@x',
        '2026-01-01T00:00:00+00:00',
        'Author',
        'a@x',
        '2026-01-01T00:00:00+00:00',
        '',
        'Fix the widget',
        'G',
      ].join(sep);
      const output = `${line}\nFirst body line.\n\nSecond paragraph.\n\0`;
      const [commit] = parseLog(output);
      assert.strictEqual(commit.message, 'Fix the widget');
      assert.strictEqual(
        fullCommitMessage(commit),
        'Fix the widget\n\nFirst body line.\n\nSecond paragraph.'
      );
    });

    it('returns the subject alone when there is no body', () => {
      assert.strictEqual(fullCommitMessage({ message: 'Just a subject' }), 'Just a subject');
      assert.strictEqual(
        fullCommitMessage({ message: 'Just a subject', body: undefined }),
        'Just a subject'
      );
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

    it('getLogFormat default separator is `\\x1f` (ASCII Unit Separator)', () => {
      // Pinned by: the previous `|` default collided with names
      // containing `|`. Switching to `\x1f` (an unprintable C0 control
      // character that never appears in normalised git idents) makes
      // parseLog round-trip such names safely.
      const format = getLogFormat();
      assert.ok(format.includes('\x1f'), `expected \\x1f in default format, got ${format}`);
      assert.ok(!format.includes('|'), 'default format must not embed pipe separator');
    });

    it('getLogFormat accepts an explicit separator override', () => {
      // Explicit override path: parseLog/parseCommit forward whatever
      // separator the caller sets, so legacy callers can still pass `|`.
      const format = getLogFormat('|');
      assert.ok(format.includes('|'));
      assert.ok(!format.includes('\x1f'));
    });
  });

  describe('parseLog (Wave I — `\\x1f` separator)', () => {
    /**
     * parseLog-separator-1: an author name containing `|`
     * round-trips correctly under the new `\x1f` separator.
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

    it('a subject containing the `\\x1f` separator itself does not shift fields', () => {
      // The separator is chosen because it never appears in NORMALIZED git
      // fields — but a commit subject is free text and CAN carry a literal
      // C0 control. Since %s is the only free-text field on the line and
      // %G? follows it, the tail between field 8 and the final field IS the
      // subject: rejoin it instead of truncating at the first `\x1f` (which
      // also mis-read a subject fragment as the signature status).
      const sep = '\x1f';
      const weirdSubject = `left${sep}middle${sep}right`;
      const fields = [
        'a'.repeat(40), // %H
        'aaaaaaa', // %h
        'Author', // %an
        'a@x.com', // %ae
        '2024-05-01T12:00:00Z', // %aI
        'Author', // %cn
        'a@x.com', // %ce
        '2024-05-01T12:00:00Z', // %cI
        '', // %P
        weirdSubject, // %s ← contains the separator
        'G', // %G?
      ];
      const commits = parseLog(fields.join(sep) + '\nbody line\0');
      assert.strictEqual(commits.length, 1);
      assert.strictEqual(commits[0].message, weirdSubject, 'subject rejoined, not truncated');
      assert.strictEqual(commits[0].gpgStatus, 'G', 'signature status read from the LAST field');
      assert.strictEqual(commits[0].body, 'body line');
    });

    /**
     * parseLog-separator-2: multi-commit log round-trips under
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

    it('getBranchFormat default separator is `\\x1f`; branch name with literal `|` round-trips', () => {
      // The previous `|` default collided with branch names containing a pipe
      // (`git check-ref-format 'refs/heads/foo|bar'` exits 0), corrupting every
      // field. Mirrors the parseLog/parseTags `\x1f` switch.
      const format = getBranchFormat();
      assert.ok(format.includes('\x1f'), `expected \\x1f in default format, got ${format}`);
      assert.ok(!format.includes('|'), 'default format must not embed pipe separator');

      const sep = '\x1f';
      const line = ['refs/heads/foo|bar', 'a'.repeat(40), 'origin/foo|bar', '*'].join(sep);
      const branches = parseBranches(line);
      assert.strictEqual(branches.length, 1);
      assert.strictEqual(branches[0].name, 'foo|bar', 'branch name with a pipe must survive');
      assert.strictEqual(branches[0].commit, 'a'.repeat(40));
      assert.strictEqual(branches[0].upstream?.remote, 'origin');
      assert.strictEqual(branches[0].upstream?.name, 'foo|bar');
      assert.strictEqual(branches[0].isHead, true);
    });

    it('getBranchFormat accepts an explicit separator override', () => {
      const format = getBranchFormat('|');
      assert.ok(format.includes('|'));
      assert.ok(!format.includes('\x1f'));
    });

    it('getTagFormat should return a valid format string', () => {
      const format = getTagFormat();
      assert.ok(format.includes('%(refname)'));
      assert.ok(format.includes('%(objecttype)'));
    });

    it('getTagFormat dereferences annotated tags to the commit (no raw %(*objectname)%(objectname) adjacency)', () => {
      // BUG: the commit field was `%(*objectname)%(objectname)` with NO
      // separator between the two atoms. For an ANNOTATED tag git fills
      // BOTH atoms — %(objectname) is the tag-object SHA and
      // %(*objectname) is the dereferenced commit SHA — so they
      // concatenate into an 80-char string that never equals a real
      // 40-char commit hash. tagMap.get(commit.hash) then misses and the
      // chip never renders (lightweight tags happen to work because
      // %(*objectname) is empty for them). The fix uses git's
      // %(if)%(*objectname)%(then)…%(else)…%(end) deref-with-fallback so
      // both tag kinds yield the COMMIT SHA.
      const format = getTagFormat();
      assert.ok(
        !format.includes('%(*objectname)%(objectname)'),
        `format must not place %(*objectname) and %(objectname) adjacently (annotated-tag SHA concatenation bug); got ${format}`
      );
      // The deref-with-fallback idiom must be present so annotated tags
      // resolve to the commit they point at.
      assert.ok(
        format.includes('%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)'),
        `format must dereference annotated tags via %(if)%(*objectname)…; got ${format}`
      );
    });

    it('getTagFormat default separator is `\\x1f` (ASCII Unit Separator)', () => {
      // Pinned by: the previous `|` default collided with
      // tagger names containing `|`. Switching to `\x1f` (an unprintable
      // C0 control character that never appears in normalised git
      // idents) makes parseTags round-trip such names safely.
      const format = getTagFormat();
      assert.ok(format.includes('\x1f'), `expected \\x1f in default format, got ${format}`);
      assert.ok(!format.includes('|'), 'default format must not embed pipe separator');
    });

    it('getTagFormat accepts an explicit separator override', () => {
      // Explicit override path: parseTags forwards whatever separator
      // the caller sets, so legacy callers can still pass `|`.
      const format = getTagFormat('|');
      assert.ok(format.includes('|'));
      assert.ok(!format.includes('\x1f'));
    });

    /**
     * parseTags-separator-1: a tagger name containing `|`
     * round-trips correctly under the new `\x1f` separator. -
     * the literal `|` in `Alice|Bob` would have split mid-field and
     * corrupted email → date → subject downstream. Mirrors
     * `parseLog-separator-1`.
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
   * / F3 — `parseBranches` filters git's parenthesized pseudo-refs.
   *
   * `git branch -a --format` lines like
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
      const result = parseBranches(output, '|');
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
      const result = parseBranches(output, '|');

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
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(result, [], 'mid-rebase parenthesized label must be filtered');
    });

    it('parseBranches-detached-4: mid-bisect pseudo-ref → filtered', () => {
      const output =
        '(no branch, bisect started on main)|abc1234567890123456789012345678901234567890||*';
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(result, [], 'mid-bisect parenthesized label must be filtered');
    });

    it('parseBranches-detached-5: detached pseudo-ref as ONLY entry → returns empty array', () => {
      // Pin the edge case where the user is detached and the only line
      // git emits is the pseudo-ref. The result must be empty so the UI
      // shows zero branches and falls back to `repo.head?.commit` for
      // detached display, rather than a 1-element list with a parenthesized
      // name.
      const output = '(HEAD detached from origin/main)|deadbeefdeadbeefdeadbeefdeadbeefdeadbeef||*';
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(result, []);
    });

    it('parseBranches-detached-6: mid-cherry-pick pseudo-ref → filtered', () => {
      // git emits this while a cherry-pick is paused on a conflict.
      // The parity doc section 1.1 enumerates this as a covered variant; pin
      // it explicitly so the structural rule's coverage is auditable
      // by-fixture rather than implied by the predicate shape alone.
      const output =
        '(no branch, cherry-pick of abcdef1)|abc1234567890123456789012345678901234567890||*';
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(result, [], 'mid-cherry-pick parenthesized label must be filtered');
    });

    it('parseBranches-remote-head: remotes/<remote>/HEAD symref → filtered (matches git4idea)', () => {
      // `git branch -a --format` emits the per-remote HEAD pointer
      // `refs/remotes/origin/HEAD` (shown by `git branch -a` as
      // `origin/HEAD -> origin/main`). It is not a selectable branch; git4idea
      // strips it (GitBranchUtil.getBranchNamesAndRemoveHead, :126-129).
      const output = [
        'refs/heads/main|aaa4567890123456789012345678901234567890abc||*',
        'refs/remotes/origin/HEAD|aaa4567890123456789012345678901234567890abc||',
        'refs/remotes/origin/main|aaa4567890123456789012345678901234567890abc||',
      ].join('\n');
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(
        result.map((b) => b.name),
        ['main', 'origin/main'],
        'origin/HEAD symref must be excluded from the branch list'
      );
    });

    it('parseBranches-bare-head: a bare `HEAD` ref → filtered', () => {
      const output = [
        'HEAD|aaa4567890123456789012345678901234567890abc||',
        'refs/heads/main|aaa4567890123456789012345678901234567890abc||*',
      ].join('\n');
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(
        result.map((b) => b.name),
        ['main']
      );
    });

    it('parseBranches-head-substring: real branches merely CONTAINING "HEAD" survive', () => {
      // Only the exact HEAD pointers are stripped — not names containing HEAD.
      const output = [
        'refs/heads/HEADER|aaa4567890123456789012345678901234567890abc||*',
        'refs/remotes/origin/feature-HEAD|aaa4567890123456789012345678901234567890abc||',
      ].join('\n');
      const result = parseBranches(output, '|');
      assert.deepStrictEqual(
        result.map((b) => b.name),
        ['HEADER', 'origin/feature-HEAD'],
        'branches merely containing HEAD must NOT be filtered'
      );
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
      const result = parseBranches(output, '|');

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

  describe('parseContainingBranches', () => {
    // Output shape: `git branch -a --contains <hash> --format=%(refname)`,
    // one full refname per line. Mirrors git4idea GitBranchUtil.getBranches,
    // which lists BOTH local and remote branches that contain a commit and
    // returns them sorted alphabetically.
    it('parseContainingBranches-1: local + remote refnames → stripped, sorted names', () => {
      const output = ['refs/heads/main', 'refs/heads/feature/x', 'refs/remotes/origin/main'].join(
        '\n'
      );
      assert.deepStrictEqual(parseContainingBranches(output), ['feature/x', 'main', 'origin/main']);
    });

    it('parseContainingBranches-2: empty output → empty list', () => {
      assert.deepStrictEqual(parseContainingBranches(''), []);
    });

    it('parseContainingBranches-3: skips the remote HEAD symref', () => {
      const output = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'].join('\n');
      assert.deepStrictEqual(parseContainingBranches(output), ['origin/main']);
    });

    it('parseContainingBranches-4: filters git parenthesized pseudo-refs', () => {
      const output = ['(HEAD detached at 5eed84b)', 'refs/heads/main'].join('\n');
      assert.deepStrictEqual(parseContainingBranches(output), ['main']);
    });

    it('parseContainingBranches-5: deduplicates identical refnames', () => {
      const output = ['refs/heads/main', 'refs/heads/main'].join('\n');
      assert.deepStrictEqual(parseContainingBranches(output), ['main']);
    });

    it('parseContainingBranches-6: ignores blank/whitespace-only lines', () => {
      const output = ['refs/heads/main', '', '   ', 'refs/heads/dev'].join('\n');
      assert.deepStrictEqual(parseContainingBranches(output), ['dev', 'main']);
    });

    it('parseContainingBranches-7: sorts through compareRefNames, not code-unit order', () => {
      // Mixed case diverges from a bare .sort(): code-unit puts every
      // capitalised name first (Backup, Upstream, fork, upstream); the
      // Branches tree and the log filter both order this Backup, fork,
      // upstream, Upstream (locale tie-break: lowercase before uppercase
      // for an otherwise-equal name) — the commit-details panel must agree.
      const output = [
        'refs/heads/Backup',
        'refs/heads/fork',
        'refs/heads/Upstream',
        'refs/heads/upstream',
      ].join('\n');
      assert.deepStrictEqual(parseContainingBranches(output), [
        'Backup',
        'fork',
        'upstream',
        'Upstream',
      ]);
    });
  });

  describe('parseBlame', () => {
    // git blame --porcelain emits a commit's author/author-time/summary header
    // block ONLY on that commit's FIRST appearance in the stream. Later,
    // non-contiguous occurrences of the SAME commit carry just the
    // `<sha> <orig> <final>` line + the `\t<content>` line — NO headers, because
    // git expects the consumer to have cached the metadata by sha. A parser that
    // tracks metadata as flat running variables (rather than a per-sha map) will
    // mislabel every repeat line with whichever commit's headers were seen most
    // recently. This fixture reproduces that real-world layout.
    const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const realisticPorcelain = [
      // Line 1 — commit A, full header block (first sight of A).
      `${A} 1 1 1`,
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Alice',
      'committer-mail <alice@example.com>',
      'committer-time 1700000000',
      'committer-tz +0000',
      'summary Add greeting',
      'filename greeting.ts',
      '\tconst a = 1;',
      // Line 2 — commit B, full header block (first sight of B).
      `${B} 2 2 1`,
      'author Bob',
      'author-mail <bob@example.com>',
      'author-time 1800000000',
      'author-tz +0000',
      'committer Bob',
      'committer-mail <bob@example.com>',
      'committer-time 1800000000',
      'committer-tz +0000',
      'summary Tweak spacing',
      'filename greeting.ts',
      '\tconst b = 2;',
      // Line 3 — commit A AGAIN, NO header block (git already emitted A's once).
      `${A} 3 3 1`,
      '\tconst a3 = 3;',
    ].join('\n');

    it('attributes a repeated commit by its own metadata, not the last-seen commit', () => {
      const lines = parseBlame(realisticPorcelain);
      assert.strictEqual(lines.length, 3, 'all three content lines parsed');

      const [l1, l2, l3] = lines;

      // Line 1 — commit A.
      assert.strictEqual(l1.commit, A);
      assert.strictEqual(l1.author, 'Alice');
      assert.strictEqual(l1.message, 'Add greeting');

      // Line 2 — commit B.
      assert.strictEqual(l2.commit, B);
      assert.strictEqual(l2.author, 'Bob');
      assert.strictEqual(l2.message, 'Tweak spacing');

      // Line 3 — commit A again. The headerless repeat must still resolve to
      // ALICE / "Add greeting" (A's cached metadata), NOT Bob's (the most
      // recently-seen header block). This is the bug the flat-variable parser
      // had.
      assert.strictEqual(l3.commit, A, 'repeat line keeps the correct hash');
      assert.strictEqual(l3.author, 'Alice', 'repeat line must use A’s author, not B’s');
      assert.strictEqual(l3.message, 'Add greeting', 'repeat line must use A’s summary');
      assert.strictEqual(
        l3.date.getTime(),
        1700000000 * 1000,
        'repeat line must use A’s author-time, not B’s'
      );
    });

    it('maps each content line to its 1-indexed final line number', () => {
      const lines = parseBlame(realisticPorcelain);
      assert.deepStrictEqual(
        lines.map((l) => l.line),
        [1, 2, 3]
      );
    });

    it('returns an empty array for empty blame output', () => {
      assert.deepStrictEqual(parseBlame(''), []);
    });

    it('parses a 64-hex (SHA-256) commit line', () => {
      const sha256 = 'a'.repeat(64);
      const porcelain = [
        `${sha256} 1 1 1`,
        'author Alice',
        'author-mail <alice@example.com>',
        'author-time 1700000000',
        'summary first',
        '\tconst x = 1;',
      ].join('\n');
      const lines = parseBlame(porcelain);
      assert.strictEqual(lines.length, 1, 'a sha256 repo blame line must parse');
      assert.strictEqual(lines[0].commit, sha256);
      assert.strictEqual(lines[0].author, 'Alice');
    });
  });
});

describe('parseLineAttrPaths', () => {
  const z = (...fields: string[]): string => fields.join('\0') + '\0';

  it('collects paths whose text or crlf attribute is specified', () => {
    const out =
      z('a.ts', 'text', 'set', 'a.ts', 'crlf', 'unspecified') +
      z('b.ts', 'text', 'unspecified', 'b.ts', 'crlf', 'set');
    assert.deepStrictEqual([...parseLineAttrPaths(out)].sort(), ['a.ts', 'b.ts']);
  });

  it('ignores unspecified attributes', () => {
    const out = z('a.ts', 'text', 'unspecified', 'a.ts', 'crlf', 'unspecified');
    assert.deepStrictEqual([...parseLineAttrPaths(out)], []);
  });

  it('counts an explicitly unset attribute (-text) as specified', () => {
    // Reference GitCheckAttrParser skips only 'unspecified'; 'unset' means the
    // user wrote a rule for the file, so its line endings are deliberate.
    const out = z('a.ts', 'text', 'unset');
    assert.deepStrictEqual([...parseLineAttrPaths(out)], ['a.ts']);
  });

  it('handles paths containing colons and spaces, and valued attributes', () => {
    const out = z('dir with space/a:b.ts', 'text', 'auto');
    assert.deepStrictEqual([...parseLineAttrPaths(out)], ['dir with space/a:b.ts']);
  });

  it('returns empty for empty output', () => {
    assert.deepStrictEqual([...parseLineAttrPaths('')], []);
  });
});
