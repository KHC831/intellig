/**
 * Spec for scripts/lib/grep-hit.sh: `split_grep_hit` splits a `grep -n`
 * output line into file, line and text, including a Windows path whose drive
 * letter carries a colon of its own (Git Bash prints `D:\a\x.ts:12:text`).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const LIB = path.join(process.cwd(), 'scripts/lib/grep-hit.sh');

function split(hit: string): string[] {
  const r = spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; split_grep_hit "$2"; printf "%s\\n" "$HIT_FILE" "$HIT_LINE" "$HIT_TEXT"',
      'bash',
      LIB,
      hit,
    ],
    { encoding: 'utf8' }
  );
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.split('\n').slice(0, 3);
}

describe('split_grep_hit (scripts/lib/grep-hit.sh)', () => {
  it('splits a POSIX hit', () => {
    assert.deepStrictEqual(split('src/a.ts:12:const x = 1;'), ['src/a.ts', '12', 'const x = 1;']);
  });

  it('keeps colons in the matched text', () => {
    assert.deepStrictEqual(split('src/a.ts:3:a ? b : c'), ['src/a.ts', '3', 'a ? b : c']);
  });

  it('keeps a Windows drive letter with the file', () => {
    assert.deepStrictEqual(split('D:\\a\\repo\\src/a.ts:7:x = { y: 1 }'), [
      'D:\\a\\repo\\src/a.ts',
      '7',
      'x = { y: 1 }',
    ]);
    assert.deepStrictEqual(split('c:/work/b.ts:1:z'), ['c:/work/b.ts', '1', 'z']);
  });

  it('does not take a one-letter relative file for a drive', () => {
    assert.deepStrictEqual(split('a:5:text'), ['a', '5', 'text']);
  });

  // A directory literally named `D:` makes grep print the Windows hit shape on
  // a POSIX host; Windows cannot create one, and prints that shape natively.
  (process.platform === 'win32' ? it.skip : it)(
    'lets a guard scanning a drive-lettered root name the offending file',
    () => {
      const cwd = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'grep-hit-drive-'));
      const src = path.join(cwd, 'D:', 'src');
      fs.mkdirSync(path.join(src, 'webview-common'), { recursive: true });
      fs.writeFileSync(
        path.join(src, 'webview-common', 'placeNearPointer.ts'),
        'const w = window.innerWidth;\nconst h = window.innerHeight;\n'
      );
      fs.writeFileSync(
        path.join(src, 'menu.ts'),
        'const x = Math.min(a, view.innerWidth - w);\nconst y = Math.min(b, view.innerHeight - h);\n'
      );
      const r = spawnSync(
        'bash',
        [path.join(process.cwd(), 'scripts/check-popup-placement-shared.sh'), 'D:/src'],
        { cwd, encoding: 'utf8' }
      );
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /D:\/src\/menu\.ts:1/);
      assert.doesNotMatch(r.stderr, /No such file|syntax error/);
    }
  );
});
