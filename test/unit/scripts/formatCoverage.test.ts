/**
 * Coherence spec for the commit path's fix pass.
 *
 * The pre-commit hook is verify-only (`prettier --check`), so a file it rejects
 * has no in-hook rewrite: the developer must format it first with `npm run
 * fix`. That only holds if `npm run format` (which `fix` runs) actually writes
 * every file type the hook checks. If lint-staged `--check`s an extension that
 * `format` does not write, a commit touching such a file hard-fails with no
 * wired remedy — the exact trap this pins shut.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface PackageJson {
  scripts: Record<string, string>;
  'lint-staged': Record<string, unknown>;
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
) as PackageJson;

/** Extensions named by a `*.ext` or `*.{a,b,c}` glob fragment. */
function extsFromGlob(fragment: string): string[] {
  const brace = fragment.match(/\*\.\{([^}]+)\}/);
  if (brace) {
    return brace[1].split(',').map((e) => e.trim());
  }
  const single = fragment.match(/\*\.([A-Za-z0-9]+)/);
  return single ? [single[1]] : [];
}

function extSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\*\.(?:\{[^}]+\}|[A-Za-z0-9]+)/g)) {
    for (const e of extsFromGlob(m[0])) {
      out.add(e);
    }
  }
  return out;
}

describe('format script covers what the commit hook checks', () => {
  it('every extension lint-staged verifies is writable by `npm run format`', () => {
    const checked = new Set<string>();
    for (const key of Object.keys(pkg['lint-staged'])) {
      for (const e of extsFromGlob(key)) {
        checked.add(e);
      }
    }

    const written = extSet(String(pkg.scripts.format));
    const uncovered = [...checked].filter((e) => !written.has(e));

    assert.deepStrictEqual(
      uncovered,
      [],
      `lint-staged --checks these at commit but \`npm run format\` does not write them: ` +
        `${uncovered.join(', ')}. A commit touching such a file hard-fails with no wired fix.`
    );
  });
});
