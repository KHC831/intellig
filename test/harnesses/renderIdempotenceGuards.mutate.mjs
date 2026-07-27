// D4 bullet 4: per-method positive control. Break ONE method's guard and
// confirm exactly that method's generated it() goes red.
//
// The first version of this harness reported "SURVIVED" for a suite that never
// ran: a mutation orphaned a local, tsc rejected it, mocha bailed with "Cannot
// find module test/setup", and "no failing spec names in the output" read as
// "no spec noticed". So every verdict here now requires POSITIVE evidence that
// the suite executed. Mutations are also chosen to keep every local used, so a
// type error cannot masquerade as a result.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PATH = 'src/git-core/gitToolWindow/GitToolWindowProvider.ts';
const SPEC = 'test/unit/services/gitToolWindow/renderIdempotence.test.ts';
const original = readFileSync(PATH, 'utf8');

const mutations = [
  [
    'setAvailableRepositories',
    'this._repositoryDocumentState() !== previousDocumentState',
    "this._repositoryDocumentState() !== previousDocumentState + 'x'",
  ],
  ['clearConsole', 'if (this._consoleEntries.length === 0) {', 'if (this._consoleEntries.length < 0) {'],
  ['setHasRepository', 'const wasLoading = this._isLoading;', 'const wasLoading = !this._isLoading;'],
  ['updateLogState', 'this._lastLogFingerprint = fingerprint;', 'this._lastLogFingerprint = fingerprint + Math.random();'],
  [
    'setCherryPickedHashes',
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

for (const [name, find, replace] of mutations) {
  if (!original.includes(find)) {
    console.log(`${name}: PATTERN NOT FOUND — harness broken, not the guard`);
    continue;
  }
  writeFileSync(PATH, original.replace(find, replace));
  const { ran, failed } = run();
  writeFileSync(PATH, original);

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

writeFileSync(PATH, original);
console.log('\nrestored byte-identical:', readFileSync(PATH, 'utf8') === original);
