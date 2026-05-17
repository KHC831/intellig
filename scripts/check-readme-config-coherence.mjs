#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-readme-config-coherence.mjs — README ↔ package.json
// schema drift guard.
//
// Maintenance contract (per ADR-007 §"Guard maintenance contract"):
//
// 1. Bug class
//    A README config table claims a default that does not match
//    the actual `contributes.configuration.properties.<key>.default`
//    in package.json — users following the README get behavior
//    contradicting their settings UI. Multiple R0 drifts (4 stale
//    defaults + 2 duplicate rows) motivated this guard. Direction
//    enforced: every README row → schema must agree.
//
// 2. Heuristic + how it scales
//    Parse README with a Markdown table-row regex (`| \`intellig.X\`
//    | \`default\` | … |`). For each captured pair, look up
//    `package.json.contributes.configuration.properties[X].default`
//    and JSON-normalize both sides for comparison (handles
//    surrounding backticks, whitespace, array literals). Adding new
//    config keys to the README is a free no-op for this guard;
//    adding new normalization shapes is a localized change in
//    `normalize()` / the JSON-parse fallback. Scales linearly with
//    README row count (currently ~29 rows; <1ms total).
//
// 3. Known false-positive cases
//    - Enum values, descriptions, deprecation flags are out of
//      scope by design — only `default` is checked.
//    - Multi-default rendering edge case: a schema with `default: ""`
//      vs README `\`""\`` matches via JSON normalize. A schema with
//      a complex object default would need a normalization rule.
//      None today.
//
// 4. Known false-negative cases
//    - schema → README direction NOT enforced as failure UNTIL the
//      undocumented count exceeds UNDOCUMENTED_FAIL_THRESHOLD (5).
//      A schema key that is not documented in the README will
//      surface as a SOFT WARN below the threshold; at-or-above
//      threshold the guard escalates to FAIL with the same
//      message. This makes "schema-grew-but-README-didn't" fail
//      noisy at scale while tolerating one or two pending docs.
//    - Per-key `description` text drift is not checked. If a
//      description gets stale, the README still passes.
//    - Markdown-table heuristic: a README that documents config in
//      bullet form rather than table rows would not be parsed; the
//      guard would silently report 0 rows. Future contributors
//      should keep the table format.
//
// 5. Retirement criteria
//    Retire when README config tables are auto-generated from
//    schema (e.g. via a JSON-Schema-to-Markdown step in
//    `vscode:prepublish`). At that point drift is unreachable by
//    construction. Until then, the guard earns its keep.
// ============================================================

import { readFileSync } from 'node:fs';

// At-or-above this many schema keys missing from the README, the
// SOFT WARN escalates to a hard FAIL. Tuned for the current ~29-key
// schema; raise as the schema grows if a one-off batch of pending
// docs is acceptable.
const UNDOCUMENTED_FAIL_THRESHOLD = 5;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const props = pkg.contributes?.configuration?.properties ?? {};
const readme = readFileSync('README.md', 'utf8');

// Match Markdown table rows shaped:
//   | `intellig.foo` | `value` | … |
// or escaped backticks. Capture key + rendered-default cell.
const ROW_RE =
  /^\|\s*`(intellig\.[a-zA-Z0-9_.]+)`\s*\|\s*(.*?)\s*\|.*\|\s*$/gm;

// Sentinels — used to distinguish "cell was empty" vs "schema has no
// default" vs a literal value. Wrapped in {sentinel: ...} so the
// FAIL site can render a readable user-facing message (L5 fix).
const EMPTY_CELL = { sentinel: 'EMPTY_CELL', display: '<empty>' };
const NO_DEFAULT = { sentinel: 'NO_DEFAULT', display: '<no default>' };

// Normalize a README cell to a comparable form. Strips wrapping
// backticks, leading/trailing whitespace.
function normalize(cell) {
  let v = cell.trim();
  v = v.replace(/^`+|`+$/g, '');
  v = v.trim();
  if (v === '') return EMPTY_CELL;
  return v;
}

function fmtSchemaDefault(d) {
  if (d === undefined) return NO_DEFAULT;
  // Strings render with quotes in the README; arrays/booleans/numbers
  // render verbatim. JSON.stringify covers all primitives + arrays.
  return JSON.stringify(d);
}

// Render a value for human-readable failure messages.
function display(v) {
  if (v && typeof v === 'object' && v.sentinel) return v.display;
  return String(v);
}

// JSON-normalize both sides for comparison; falls back to literal
// when the rendered cell is not parseable JSON.
function canonical(v) {
  if (v && typeof v === 'object' && v.sentinel) return v.sentinel;
  try {
    return JSON.stringify(JSON.parse(v));
  } catch {
    return v;
  }
}

const failures = [];
const seen = new Set();

let m;
while ((m = ROW_RE.exec(readme)) !== null) {
  const key = m[1];
  const rendered = normalize(m[2]);
  if (seen.has(key)) {
    failures.push(
      `README lists ${key} more than once. Pick a single canonical row.`
    );
    continue;
  }
  seen.add(key);

  if (!(key in props)) {
    failures.push(
      `README documents ${key} but it does not exist in package.json ` +
        `contributes.configuration.properties. Either add it to the ` +
        `schema or remove the README row.`
    );
    continue;
  }
  const schemaDefault = fmtSchemaDefault(props[key].default);

  if (canonical(rendered) !== canonical(schemaDefault)) {
    failures.push(
      `README default for ${key} is ${display(rendered)} but schema ` +
        `default is ${display(schemaDefault)}. Update the README row to ` +
        `match the schema (or vice versa).`
    );
  }
}

// (M8 + tech-lead-R3-M3) Schema → README undocumented-key check.
// Below the threshold, SOFT WARN (non-fatal) — reviewers can audit
// and decide. At-or-above the threshold, escalates to FAIL.
const undocumented = Object.keys(props)
  .filter((k) => !seen.has(k))
  .sort();

const undocumentedHardFail =
  undocumented.length >= UNDOCUMENTED_FAIL_THRESHOLD;

if (undocumentedHardFail) {
  failures.push(
    `${undocumented.length} schema key(s) lack README documentation ` +
      `(>= UNDOCUMENTED_FAIL_THRESHOLD=${UNDOCUMENTED_FAIL_THRESHOLD}). ` +
      `Document them in the appropriate Configuration reference table ` +
      `OR opt them out by removing from the schema. Pending: ` +
      undocumented.join(', ') +
      '.'
  );
}

if (failures.length > 0) {
  console.error('[check:config-coherence] FAIL:');
  for (const f of failures) {
    console.error('  - ' + f);
  }
  console.error(
    `\n[check:config-coherence] ${failures.length} drift finding(s). ` +
      `README and package.json schema must agree on every documented ` +
      `intellig.* default.`
  );
  if (undocumented.length > 0 && !undocumentedHardFail) {
    console.error(
      `\n[check:config-coherence] WARN — ${undocumented.length} schema ` +
        `key(s) not documented in README (non-fatal, below threshold ` +
        `of ${UNDOCUMENTED_FAIL_THRESHOLD}):`
    );
    for (const k of undocumented) {
      console.error('  - ' + k);
    }
  }
  process.exit(1);
}

console.log(
  `[check:config-coherence] OK — verified ${seen.size} intellig.* row(s) ` +
    `in README against package.json schema.`
);
if (undocumented.length > 0) {
  console.warn(
    `[check:config-coherence] WARN — ${undocumented.length} schema ` +
      `key(s) not documented in README (non-fatal, below threshold ` +
      `of ${UNDOCUMENTED_FAIL_THRESHOLD}):`
  );
  for (const k of undocumented) {
    console.warn('  - ' + k);
  }
}
