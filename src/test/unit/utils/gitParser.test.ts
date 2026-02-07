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
  });
});
