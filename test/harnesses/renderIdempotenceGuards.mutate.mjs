// D4 bullet 4: per-method positive control. Break ONE method's guard and
// confirm exactly that method's generated it() goes red.
//
// The first version of this harness reported "SURVIVED" for a suite that never
// ran: a mutation orphaned a local, tsc rejected it, mocha bailed with "Cannot
// find module test/setup", and "no failing spec names in the output" read as
// "no spec noticed". So every verdict here now requires POSITIVE evidence that
// the suite executed. Mutations are also chosen to keep every local used, so a
// type error cannot masquerade as a result.
//
// Each mutation names the file its guard lives in: setAvailableRepositories'
// render gate moved into RepoScopeModel with the repo-scope cluster; the rest
// remain on the provider class.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PROVIDER = 'src/git-core/gitToolWindow/GitToolWindowProvider.ts';
const REPO_SCOPE = 'src/git-core/gitToolWindow/provider/RepoScopeModel.ts';
const SPEC = 'test/unit/services/gitToolWindow/renderIdempotence.test.ts';

const originals = new Map([PROVIDER, REPO_SCOPE].map((p) => [p, readFileSync(p, 'utf8')]));
const restoreAll = () => {
  for (const [p, src] of originals) {
    writeFileSync(p, src);
  }
};

const mutations = [
  [
    'setAvailableRepositories',
    REPO_SCOPE,
    'this._repositoryDocumentState() !== previousDocumentState',
    "this._repositoryDocumentState() !== previousDocumentState + 'x'",
  ],
  [
    'clearConsole',
    PROVIDER,
    'if (this._consoleEntries.length === 0) {',
    'if (this._consoleEntries.length < 0) {',
  ],
  [
    'setHasRepository',
    PROVIDER,
    'const wasLoading = this._isLoading;',
    'const wasLoading = !this._isLoading;',
  ],
  [
    'updateLogState',
    PROVIDER,
    'this.log.commitFingerprint(fingerprint);',
    'this.log.commitFingerprint(fingerprint + Math.random());',
  ],
  [
    'setCherryPickedHashes',
    PROVIDER,
    'const prev = this._extendedLogState.cherryPickedHashes;',
    'const prev = new Set([...(this._extendedLogState.cherryPickedHashes ?? []), Math.random().toString()]);',
  ],
];

function run() {
  let raw;
  let ran;
  try {
    raw = execSync(`npx mocha --require ts-node/register ${SPEC}`, { encoding: 'utf8' });
  } catch (e) {
    raw = `${e.stdout}${e.stderr}`;
  }
  // Positive evidence the suite executed at all.
  ran = /\d+ passing|\d+ failing/.test(raw);
  const failed = [...raw.matchAll(/\d+\)\s+(\w+) does not rebuild/g)].map((m) => m[1]);
  return { ran, failed, raw };
}

const baseline = run();
console.log(
  `baseline (unmutated): ran=${baseline.ran} failing=[${baseline.failed.join(', ') || 'none'}]\n`
);

for (const [name, path, find, replace] of mutations) {
  const original = originals.get(path);
  if (!original.includes(find)) {
    console.log(`${name}: PATTERN NOT FOUND — harness broken, not the guard`);
    continue;
  }
  writeFileSync(path, original.replace(find, replace));
  const { ran, failed } = run();
  restoreAll();

  if (!ran) {
    console.log(`${name}: INCONCLUSIVE — the suite did not execute under this mutation`);
    continue;
  }
  if (failed.length === 0) {
    console.log(`${name}: SURVIVED — the table entry asserts nothing`);
    continue;
  }
  const only = failed.length === 1 && failed[0] === name;
  console.log(`${name}: red for [${failed.join(', ')}]${only ? ' — exactly this one' : ''}`);
}

restoreAll();
console.log(
  '\nrestored byte-identical:',
  [PROVIDER, REPO_SCOPE].every((p) => readFileSync(p, 'utf8') === originals.get(p))
);
