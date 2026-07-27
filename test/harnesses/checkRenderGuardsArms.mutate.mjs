// Mutation harness for check-render-guards.mjs: break one arm at a time and
// confirm the companion spec notices. An arm no probe kills is decoration.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PATH = 'scripts/check-render-guards.mjs';
const original = readFileSync(PATH, 'utf8');

const mutations = [
  [
    'header anchored on ) and { (the naive mapping the design warns about)',
    "\\s*(?:<[^>]*>)?\\s*\\(/;",
    "\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::[^{;]+)?\\{\\s*$/;",
  ],
  [
    'entry-point set narrowed to _render only',
    'this\\.(?:_render|_renderForGesture|_renderOnResolve|_renderSidebarPlaceholder|updateWebview)\\s*\\(',
    'this\\._render\\s*\\(',
  ],
  ['annotation read from the code view instead of comments', 'commentLines.slice', 'codeLines.slice'],
  ['nested-callback detection disabled', 'if (site.nested) {', 'if (false) {'],
  ['method-shorthand arm removed (arrow arm kept)', 'if (shorthand && !NOT_A_NAME.test(shorthand[1])) {', 'if (false) {'],
  ['NOT_A_NAME dropped from the shorthand arm', '!NOT_A_NAME.test(shorthand[1])', 'true'],
  ['missing-target check disabled', 'if (!existsSync(target)) {', 'if (false) {'],
  ['zero-site floor removed', 'if (sites.length === 0) {', 'if (false) {'],
];

for (const [label, find, replace] of mutations) {
  if (!original.includes(find)) {
    console.log(`- ${label}\n    PATTERN NOT FOUND — harness broken, not the fence`);
    continue;
  }
  writeFileSync(PATH, original.replace(find, replace));
  let raw;
  try {
    raw = execSync('npx mocha --require ts-node/register test/unit/scripts/checkRenderGuards.test.ts', {
      encoding: 'utf8',
    });
  } catch (e) {
    raw = `${e.stdout}${e.stderr}`;
  }
  // Positive evidence the probes actually RAN. This file is a .mjs, so the
  // hazard is not tsc but a syntactically broken script: the probes would then
  // fail to load and the non-zero exit reads exactly like a caught violation.
  // Same shape as the tsc bail that produced two false verdicts in the
  // idempotence harness, wearing a different mechanism.
  const ran = /\d+ passing|\d+ failing/.test(raw);
  const m = /(\d+) failing/.exec(raw);
  const verdict = !ran
    ? 'INCONCLUSIVE — the probes did not execute under this mutation'
    : m
      ? `killed by ${m[1]} probe(s)`
      : 'SURVIVED — no probe covers this arm';
  console.log(`- ${label}\n    ${verdict}`);
}

writeFileSync(PATH, original);
console.log('\nrestored byte-identical:', readFileSync(PATH, 'utf8') === original);
