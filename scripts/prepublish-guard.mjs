#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// prepublish-guard.mjs — refuses to package a .vsix while any
// release-blocking placeholder is still in place.
//
// Maintenance contract (per ADR-007 §"Guard maintenance contract"):
//
// 1. Bug class
//    Pre-1.0 placeholders (fake LICENSE, placeholder icon,
//    YYYY-MM-DD CHANGELOG date, <EMAIL_PLACEHOLDER> SECURITY
//    contact, mismatch between top-dated CHANGELOG entry and
//    package.json `version`) accidentally shipping to the VS Code
//    Marketplace. Each placeholder has a known fingerprint; the
//    guard asserts the working tree no longer matches any.
//
// 2. Heuristic + how it scales
//    Per-placeholder fingerprints are DATA-DRIVEN via
//    `scripts/prerelease-state.json` (TL-93). Each entry declares
//    a `rule` and the guard dispatches one of:
//      - `minMarkers` — string-substring matchers; flag when ≥
//        `minMatches` distinct markers hit (LICENSE: ≥2 of 3 to
//        avoid false-positives on real EULAs containing one phrase).
//      - `sha256`     — SHA-256 equality against `placeholderHash`
//        (icon: ship a real icon → hash changes → guard passes).
//      - `regex`      — flag when `new RegExp(pattern, flags)`
//        matches (CHANGELOG date: catches `## [<anything>] - YYYY-MM-DD`).
//      - `literal`    — flag when `placeholder` substring appears
//        (SECURITY.md: `<EMAIL_PLACEHOLDER>` token).
//    Adding a 5th placeholder = adding a JSON entry. Replacing the
//    icon = updating `placeholderHash` in JSON. No code edit needed
//    for either case (this was the original L0 motivation for TL-93).
//
//    The CHANGELOG version-coherence check (top dated section's
//    version literal must equal `package.json.version`) stays
//    INLINE because it is a cross-file invariant, not a per-asset
//    placeholder fingerprint, and short-circuits when the
//    placeholder-date check already flagged the section.
//
// 3. Known false-positive cases
//    - LICENSE: a real EULA could contain "evaluation" or
//      "PLACEHOLDER" in a clause. The ≥2-marker rule mitigates;
//      if a future real LICENSE legitimately matches ≥2, suppress
//      by either trimming the markers list in
//      `prerelease-state.json` or rewriting the LICENSE clause.
//    - SECURITY.md: literal `<EMAIL_PLACEHOLDER>` token is unique
//      enough to avoid collisions in any real disclosure policy.
//      No FP suppression needed.
//
// 4. Known false-negative cases
//    - Icon hash: any bit-tweak to the placeholder PNG (recompress,
//      resave) flips the hash and the guard passes despite content
//      still being a placeholder. Mitigated by the dual constraint
//      that the user MUST update `placeholderHash` in
//      prerelease-state.json when replacing the icon — they can't
//      silently swap an equally-bad image without noticing.
//    - LICENSE: a brand-new placeholder phrasing not in the marker
//      list ("temp text", "draft", etc.) would pass. Future
//      reviewers should add new markers to prerelease-state.json
//      when new placeholders ship.
//    - Bypass: triple-gated (INTELLIG_ALLOW_PLACEHOLDERS=1 +
//      INTELLIG_DOGFOOD_BUILD=1 + INTELLIG_DOGFOOD_INVOCATION=1).
//      All three required; missing any fails closed. The third
//      gate uses a custom env-var name (not npm_lifecycle_event)
//      because npm reassigns that field on each nested `npm run`
//      invocation; `vsce package` runs `npm run vscode:prepublish`
//      internally, which would clobber the lifecycle event before
//      our guard reads it. The custom env name is set ONLY by the
//      `package:dogfood` npm script and propagates to children
//      via process inheritance.
//      Residual risk: a maintainer who exports all three flags
//      into their shell profile permanently disables the guard.
//      Mitigation: the noisy "BYPASSED" line in vsce stdout, plus
//      the documented coupling to the `package:dogfood` script
//      name. Automated defence needs Marketplace-side attestation.
//      The dogfood path also writes `*-dogfood.vsix` (TL-95) so the
//      output filename itself signals "do not publish."
//    - INTELLIG_INTERNAL_PREPUBLISH_DRYRUN bypass: similarly stale-
//      export-able. Mitigation is the narrow name + the
//      [check:vsix-clean] script being the only documented user.
//
// 5. Retirement criteria
//    Retire when ALL of: (a) no placeholder ships in the repo any
//    more, (b) at least one full release cycle has gone by without
//    the guard catching anything, AND (c) a stricter mechanism
//    (Marketplace pre-publish hook, attestation flow, etc.) makes
//    the bug class architecturally unreachable. Replace with a
//    simpler README note. Until retirement, the JSON state file is
//    the single source of truth for placeholder fingerprints.
// ============================================================

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two bypass paths, each scoped narrowly:
//
// (A) Internal structural-guard bypass:
//     INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1
//     Used by `scripts/check-vsix-clean.sh` to invoke `vsce ls`
//     without packaging — the listing is the audit target, not
//     the placeholder content. Single-flag because the surface
//     is intra-process: only our own scripts set it, and a
//     maintainer who exports it has explicitly opted into a
//     dryrun-only mode.
//
// (B) Dogfood bypass (H5 + tech-lead-R3-M1) — triple-gated:
//       1. INTELLIG_ALLOW_PLACEHOLDERS=1
//       2. INTELLIG_DOGFOOD_BUILD=1
//       3. INTELLIG_DOGFOOD_INVOCATION=1 (set ONLY by
//          `npm run package:dogfood`; npm doesn't overwrite this
//          custom env name across nested script invocations).
//     Missing any → fails closed. See header §4 for rationale.
const internalDryrun = process.env.INTELLIG_INTERNAL_PREPUBLISH_DRYRUN === '1';
if (internalDryrun) {
  console.warn(
    '[prepublish-guard] BYPASSED for INTERNAL DRYRUN ' +
      '(INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1). This path is ' +
      'reserved for structural-guard scripts that need `vsce ls` ' +
      'output without packaging. The resulting .vsix (if any) MUST ' +
      'NOT be uploaded to the Marketplace.'
  );
  process.exit(0);
}

const dogfoodAllow = process.env.INTELLIG_ALLOW_PLACEHOLDERS === '1';
const dogfoodBuild = process.env.INTELLIG_DOGFOOD_BUILD === '1';
const dogfoodInvocation = process.env.INTELLIG_DOGFOOD_INVOCATION === '1';
const dogfoodGates = [dogfoodAllow, dogfoodBuild, dogfoodInvocation];
const dogfoodGateCount = dogfoodGates.filter(Boolean).length;
if (dogfoodGateCount === 3) {
  console.warn(
    '[prepublish-guard] BYPASSED via INTELLIG_ALLOW_PLACEHOLDERS=1, ' +
      'INTELLIG_DOGFOOD_BUILD=1, AND INTELLIG_DOGFOOD_INVOCATION=1. ' +
      'This is for local dogfood packaging only. The resulting ' +
      '.vsix must NOT be uploaded to the Marketplace.'
  );
  process.exit(0);
}
if (dogfoodGateCount > 0 && dogfoodGateCount < 3) {
  console.error(
    '[prepublish-guard] FAIL: dogfood bypass requires ALL THREE of ' +
      'INTELLIG_ALLOW_PLACEHOLDERS=1 + INTELLIG_DOGFOOD_BUILD=1 + ' +
      'INTELLIG_DOGFOOD_INVOCATION=1. Saw ' +
      `${dogfoodGateCount}/3. Use \`npm run package:dogfood\` rather ` +
      'than exporting env vars by hand.'
  );
  process.exit(1);
}

// ----- load fingerprint config (TL-93) -----
// `INTELLIG_PREPUBLISH_STATE_PATH` is an explicit test seam — when
// set, the guard reads its fingerprint config from that path instead
// of `scripts/prerelease-state.json`. Used by the unit-test suite
// to drive each rule-type dispatch with controlled fixtures
// (minMarkers / sha256 / regex / literal). Mirrors the
// `INTELLIG_100_GATE_PACKAGE_JSON` test seam in check-100-gate.sh.
const STATE_PATH =
  process.env.INTELLIG_PREPUBLISH_STATE_PATH ||
  join(__dirname, 'prerelease-state.json');
let STATE;
try {
  STATE = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
} catch (e) {
  console.error(
    '[prepublish-guard] FAIL: cannot read placeholder-fingerprint ' +
      `config at ${STATE_PATH}: ${e && e.message ? e.message : e}. ` +
      'This file is the single source of truth for placeholder ' +
      'checks; restore it before packaging.'
  );
  process.exit(1);
}

const failures = [];

function fail(msg) {
  failures.push(msg);
}

// Tracks every `tag` value associated with a fingerprint that fired,
// so downstream cross-file checks can short-circuit when a related
// per-file fingerprint already flagged the same surface (avoids
// confusing cascade errors pointing at the wrong section).
//
// (R1 senior-M1 fix.) Originally only the regex `case` set the
// `placeholderDateFailed` boolean. That coupled the cascade short-
// circuit to a single rule type — a future maintainer migrating the
// CHANGELOG fingerprint from `regex` to `literal` / `minMarkers`
// would silently lose the short-circuit. The fix is rule-type-
// agnostic: every rule's `flagFingerprint(entry, msg)` helper records
// the entry's `tag` into `failedTags` when the fingerprint trips.
const failedTags = new Set();

/**
 * Record a failure for an entry that just tripped its fingerprint.
 * In addition to pushing the message onto `failures`, this remembers
 * the entry's `tag` (when set) into `failedTags` so cross-file
 * downstream checks (e.g. CHANGELOG version-coherence) can detect
 * "the per-file fingerprint already fired on this surface" and
 * short-circuit cleanly.
 */
function flagFingerprint(entry, msg) {
  fail(msg);
  if (entry && typeof entry.tag === 'string' && entry.tag.length > 0) {
    failedTags.add(entry.tag);
  }
}

/**
 * Apply one fingerprint entry from prerelease-state.json. Dispatches
 * by `rule`. Each rule is intentionally simple: read file, evaluate
 * predicate, push a failure with the entry's `failMessage` (or a
 * sensible default) when it matches.
 *
 * @param {string} key — top-level key in the state file (for diagnostics)
 * @param {object} entry — { path, rule, ...rule-specific fields, failMessage?, tag? }
 */
function runFingerprint(key, entry) {
  // Belt-and-braces: skip JSON-Schema metadata (`$schema`) and
  // comment fields (`_comment`) here in addition to the call-site
  // skip (R1 senior-L2). If a future caller forgets the call-site
  // filter, the fingerprint dispatcher still does the right thing
  // for documentation-only keys.
  if (key.startsWith('$') || key.startsWith('_')) {
    return;
  }
  if (!entry || typeof entry !== 'object') {
    fail(`prerelease-state.json entry "${key}" is malformed (not an object).`);
    return;
  }
  const { path, rule } = entry;
  if (!path || typeof path !== 'string') {
    fail(`prerelease-state.json entry "${key}" is missing a string \`path\`.`);
    return;
  }
  if (!existsSync(path)) {
    fail(`${path} is missing (referenced by prerelease-state.json:${key}).`);
    return;
  }

  switch (rule) {
    case 'minMarkers': {
      const markers = Array.isArray(entry.markers) ? entry.markers : [];
      const minMatches =
        typeof entry.minMatches === 'number' && entry.minMatches > 0
          ? entry.minMatches
          : 2;
      if (markers.length === 0) {
        fail(
          `prerelease-state.json entry "${key}" rule=minMarkers has no markers.`
        );
        return;
      }
      const text = readFileSync(path, 'utf8');
      const hits = markers.filter((m) =>
        new RegExp(escapeForRegex(m), 'i').test(text)
      );
      if (hits.length >= minMatches) {
        const base =
          entry.failMessage ||
          `${path} still matches ${hits.length} placeholder marker(s).`;
        flagFingerprint(entry, `${base} (matched: ${hits.join(', ')})`);
      }
      return;
    }
    case 'sha256': {
      const expected = entry.placeholderHash;
      if (typeof expected !== 'string' || expected.length === 0) {
        fail(
          `prerelease-state.json entry "${key}" rule=sha256 is missing \`placeholderHash\`.`
        );
        return;
      }
      const buf = readFileSync(path);
      const hash = createHash('sha256').update(buf).digest('hex');
      if (hash === expected) {
        const base =
          entry.failMessage || `${path} is still the placeholder.`;
        flagFingerprint(entry, `${base} (sha256=${hash})`);
      }
      return;
    }
    case 'regex': {
      const pattern = entry.pattern;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        fail(
          `prerelease-state.json entry "${key}" rule=regex is missing \`pattern\`.`
        );
        return;
      }
      const flags = typeof entry.flags === 'string' ? entry.flags : '';
      let re;
      try {
        re = new RegExp(pattern, flags);
      } catch (e) {
        fail(
          `prerelease-state.json entry "${key}" has an invalid regex ` +
            `pattern: ${e && e.message ? e.message : e}`
        );
        return;
      }
      const text = readFileSync(path, 'utf8');
      if (re.test(text)) {
        const base =
          entry.failMessage ||
          `${path} matches placeholder pattern /${pattern}/${flags}.`;
        flagFingerprint(entry, base);
      }
      return;
    }
    case 'literal': {
      const needle = entry.placeholder;
      if (typeof needle !== 'string' || needle.length === 0) {
        fail(
          `prerelease-state.json entry "${key}" rule=literal is missing \`placeholder\`.`
        );
        return;
      }
      const text = readFileSync(path, 'utf8');
      if (text.includes(needle)) {
        const base =
          entry.failMessage ||
          `${path} still contains placeholder literal "${needle}".`;
        flagFingerprint(entry, base);
      }
      return;
    }
    default:
      fail(
        `prerelease-state.json entry "${key}" has unknown rule "${rule}". ` +
          'Supported: minMarkers, sha256, regex, literal.'
      );
  }
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run every fingerprint entry from the JSON config. Iteration order
// is `Object.keys`, which preserves declaration order in the JSON
// file (V8 / spec-defined for string keys). Stable order keeps
// failure output deterministic for CI diffs.
for (const key of Object.keys(STATE)) {
  if (key.startsWith('$') || key.startsWith('_')) {
    // Skip JSON Schema metadata (`$schema`) and comment fields
    // (`_comment`). These are documentation, not fingerprint entries.
    continue;
  }
  runFingerprint(key, STATE[key]);
}

// ----- inline cross-file checks (NOT placeholder fingerprints) -----
//
// CHANGELOG version coherence with package.json. The top dated
// section's version literal must equal package.json's `version`.
// Catches: landed work under [Unreleased] but forgot to rename to a
// versioned section before bumping. This is a cross-file invariant
// (CHANGELOG ↔ package.json), not a per-asset placeholder, so it
// stays inline rather than being modeled in prerelease-state.json.
//
// Short-circuits when the placeholder-date fingerprint already
// fired on the same file — the cascade error would otherwise point
// reviewers at the WRONG section.
const TOP_DATED_VERSION_PATTERN =
  /^## \[([^\]]+?)\] - (?!YYYY-MM-DD)\S+/m;

function checkChangelogVersionMatches() {
  if (failedTags.has('changelogDate')) {
    return;
  }
  if (!existsSync('CHANGELOG.md')) {
    return; // already flagged via the changelog fingerprint above
  }
  if (!existsSync('package.json')) {
    fail('package.json is missing');
    return;
  }
  const text = readFileSync('CHANGELOG.md', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const m = TOP_DATED_VERSION_PATTERN.exec(text);
  if (!m) {
    fail(
      'CHANGELOG.md has no dated release section (only [Unreleased]?). ' +
        `Add a \`## [${pkg.version}] - YYYY-MM-DD\` block above ` +
        '[Unreleased] before packaging, then fill in the date.'
    );
    return;
  }
  const topVersion = m[1];
  if (topVersion !== pkg.version) {
    fail(
      `CHANGELOG.md top dated entry is [${topVersion}] but package.json ` +
        `version is ${pkg.version}. Rename the [Unreleased] block to ` +
        `[${pkg.version}] (or sync the version field) before packaging.`
    );
  }
}

checkChangelogVersionMatches();

if (failures.length > 0) {
  console.error('[prepublish-guard] FAIL:');
  for (const f of failures) {
    console.error('  - ' + f);
  }
  console.error(
    '\n[prepublish-guard] ' +
      failures.length +
      ' placeholder check(s) failed. Refusing to package.'
  );
  process.exit(1);
}

console.log('[prepublish-guard] OK — no release-blocking placeholders detected.');
