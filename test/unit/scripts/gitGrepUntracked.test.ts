/**
 * Meta-guard: every `git grep` gate in scripts/ must carry `--untracked`.
 *
 * `git grep` without `--untracked` scans git-TRACKED files only, so a violation
 * in a NEW (untracked, not-yet-committed) file rides through a green gate until
 * it is committed — proven live when a section symbol in a freshly-added source
 * file passed the pre-commit gate and failed only post-commit. `--untracked`
 * puts new-but-uncommitted files in scope (gitignored scratch stays out, which
 * git grep never searches), closing the class. This test fences the flag so a
 * future guard can't reintroduce the tracked-only blind spot.
 *
 * Scope: executable (non-comment) shell lines invoking `git grep`. The fixture
 * branches of these guards use plain `grep` over explicit paths, not `git grep`,
 * so every `git grep` occurrence is a default-mode gate and must carry the flag.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

/** Every `.sh` under scripts/ (recursively), as absolute paths. */
function shellScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...shellScripts(full));
    } else if (entry.isFile() && entry.name.endsWith('.sh')) {
      out.push(full);
    }
  }
  return out;
}

interface GitGrepLine {
  file: string;
  lineNo: number;
  text: string;
}

/** Executable (non-comment) lines that invoke `git grep`. */
function gitGrepGateLines(): GitGrepLine[] {
  const hits: GitGrepLine[] = [];
  for (const file of shellScripts(SCRIPTS_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const stripped = text.trimStart();
      if (stripped.startsWith('#')) {
        return; // comment/prose line — not an invocation
      }
      if (/\bgit grep\b/.test(text)) {
        hits.push({ file: path.relative(process.cwd(), file), lineNo: i + 1, text });
      }
    });
  }
  return hits;
}

describe('meta-guard: git grep gates carry --untracked', () => {
  const lines = gitGrepGateLines();

  it('finds the git-grep gates it is meant to fence (guards against a vacuous pass)', () => {
    // If this ever drops to zero the scan broke (e.g. path moved); a green
    // "every line carries the flag" over an empty set would be a false pass.
    assert.ok(
      lines.length >= 10,
      `expected the known git-grep guards to be discovered; found ${lines.length}`
    );
  });

  it('every executable `git grep` line passes --untracked', () => {
    const offenders = lines.filter((l) => !/--untracked\b/.test(l.text));
    assert.deepStrictEqual(
      offenders.map((l) => `${l.file}:${l.lineNo}`),
      [],
      'these `git grep` gates lack --untracked (a new/untracked file could carry a ' +
        'violation through a green gate):\n' +
        offenders.map((l) => `  ${l.file}:${l.lineNo}: ${l.text.trim()}`).join('\n')
    );
  });
});
