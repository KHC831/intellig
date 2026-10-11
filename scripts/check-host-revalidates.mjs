#!/usr/bin/env node
/*
 * check-host-revalidates.mjs — a validator a webview entry uses must also run on the host.
 *
 * ADR-007 section "Guard maintenance contract" five-section header:
 *
 * 1. Bug class caught: input validation that lives ONLY in a webview entry.
 *    A webview is a separate scripting context; its `postMessage` payload is
 *    attacker-shaped as far as the host is concerned, and our inbound type
 *    guards check `type` and cast the rest. When the host then hands those
 *    values to git, the webview's validation is a UX affordance being trusted
 *    as a security boundary. The live instance: DefineRemoteDialog took a
 *    submitted remote name/url straight to `git remote add`, while
 *    validateRemoteName/validateRemoteUrl ran only in the webview entry — this
 *    despite remoteValidation.ts documenting itself as "shared by the
 *    Configure Remotes flow (host) and the webview entry". Given the
 *    buildGitArgs argv-injection posture, host re-validation is table stakes.
 *
 * 2. Heuristic + how it scales: for each `src/**\/webview/*.ts` entry, read its
 *    relative imports. Any imported module whose basename matches
 *    /validation|validator/i is a validator module — as is one that EXPORTS a
 *    `validate*` function, so renaming the module does not hide it. Find the entry's host
 *    dialog — `<Name>Dialog.ts` in the parent directory, matched
 *    case-insensitively against the entry's basename — then require the host
 *    to mention at least one symbol EXPORTED by that validator module. Naming
 *    a symbol rather than the module path is deliberate: a host may reach the
 *    same validator through a re-export (ApplyPatchDialog validates
 *    stripLevel via PatchService's re-export of applyPatchValidation), and
 *    that is real validation, not an exception. A few file reads per entry;
 *    scales with the number of webview entries, which is small. A scan that
 *    finds no webview entry at all fails, so a path-shape mismatch cannot
 *    pass it vacuously.
 *
 * 3. Known false-positive cases: validation that is genuinely presentational
 *    (a character counter, a live-preview formatter) with no host-side
 *    consequence; a host that delegates the check to a layer this guard cannot
 *    see (an ops-layer guard reached without naming a validator symbol); and a
 *    host that validates INLINE, re-implementing the checks rather than calling
 *    the shared module. Inline validation honours the trust boundary — the host
 *    really does re-validate — so failing it reaches past the class in section
 *    1. Sharing the validator module is preferred, because duplicated checks
 *    drift, but this guard does not require it.
 *
 *    In every case annotate the host file with
 *    `// host-validated-elsewhere: <reason>` naming where the check actually
 *    runs. Investigate before annotating: the whole point is that the host is
 *    the trust boundary.
 *
 * 4. Known false-negative cases, stated in full:
 *    (a) a host that CALLS the validator and then ignores the returned reason
 *        still passes — proving the result gates the submit path is the unit
 *        specs' job (test/unit/sync/defineRemoteDialogHostValidation.test.ts).
 *    (b) only the `<Name>Dialog.ts` pairing convention is understood; a webview
 *        whose host is named otherwise is not checked at all.
 *    (c) barrel re-exports are followed ONE level from the entry; a deeper
 *        chain is not.
 *    (d) a regex literal is lexed as its own context and its body masked (see
 *        scripts/lib/source-scan.mjs), but one written directly after `)`, as
 *        in `if (x) /re/.test(y)`, is read as division and its body left as
 *        code. That over-scans rather than blanking real code, so the worst it
 *        can cost is a false positive, never a missed violation.
 *    NOT gaps — all covered and pinned in
 *    test/unit/scripts/checkHostRevalidates.test.ts: line- and block-comment
 *    mentions, a mention inside a string literal, a validator module renamed
 *    off the naming convention, an arrow-const validator export, an entry-side
 *    barrel re-export, an escape hatch inside a string literal, and a
 *    validator-named module exporting nothing recognisable (which FAILS rather
 *    than being skipped in silence). The inline-validating host of section 3 is
 *    pinned there too, both its failure and its annotated remedy. The lexer
 *    invariants this guard rests on are pinned directly in
 *    test/unit/scripts/sourceScan.test.ts.
 *
 * 5. Retirement criteria: retire when inbound protocol guards validate payload
 *    VALUES rather than just the `type` discriminant (a parsed/branded inbound
 *    type), so an unvalidated value cannot reach a git argument at all.
 *
 *    Re-proving this guard: target the revision that actually CONTAINS the bug,
 *    i.e. the commit BEFORE "Re-validate the submitted remote name and URL on
 *    the host" — NOT the ancestor used for the panel guard, which already has
 *    this fix and therefore reads a false OK. Extract the offending file with
 *    `git show <rev>:<path>` into a fixture root; never reach for the working
 *    tree or the stash.
 *
 * Usage:
 *   node scripts/check-host-revalidates.mjs
 *     — real mode: scans src/.
 *   node scripts/check-host-revalidates.mjs <srcRoot>
 *     — fixture mode (companion spec): scans an arbitrary root.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { posixRelative } from './lib/posix-path.mjs';
import { scanSource } from './lib/source-scan.mjs';

const SRC_ROOT = process.argv[2] ?? 'src';
const ESCAPE_HATCH = 'host-validated-elsewhere:';
const VALIDATOR_RE = /validation|validator/i;
const VALIDATOR_EXPORT_RE = /^(validate|assertValid)[A-Z]/;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function read(path) {
  const source = readFileSync(path, 'utf8');
  return { source, ...scanSource(source) };
}

/** Exported validator names: `export function`, `export const`, and re-exports. */
function exportedFunctionNames(code) {
  const names = [];
  const patterns = [
    /export\s+function\s+([A-Za-z0-9_]+)/g,
    /export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b)/g,
    /export\s+class\s+[A-Za-z0-9_]+[^{]*\{[\s\S]*?static\s+([A-Za-z0-9_]+)\s*=/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(code)) !== null) {
      names.push(match[1]);
    }
  }
  // `export { validateX } from './x'` / `export { validateX }`
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/)[0].trim();
      if (name) {
        names.push(name);
      }
    }
  }
  return [...new Set(names)];
}

/** Relative import specifiers, including re-export forms. */
function relativeImports(code) {
  const specifiers = [];
  const res = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"](\.[^'"]+)['"]/g,
  ];
  for (const re of res) {
    let match;
    while ((match = re.exec(code)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * Validator modules an entry depends on, following ONE level of barrel
 * re-export so `webview/x.ts -> ./barrel.ts -> ./thingValidation.ts` is seen.
 */
function validatorModulesFor(entryPath, entryCode) {
  const found = new Map();
  const consider = (fromDir, spec, depth) => {
    const modulePath = resolve(fromDir, `${spec}.ts`);
    if (!existsSync(modulePath) || found.has(modulePath)) {
      return;
    }
    const mod = read(modulePath);
    const named = VALIDATOR_RE.test(basename(spec));
    const exports = exportedFunctionNames(mod.code);
    if (named || exports.some((n) => VALIDATOR_EXPORT_RE.test(n))) {
      found.set(modulePath, { spec, named, exports });
      return;
    }
    if (depth > 0) {
      for (const next of relativeImports(mod.codeWithStrings)) {
        consider(dirname(modulePath), next, depth - 1);
      }
    }
  };
  for (const spec of relativeImports(entryCode)) {
    consider(dirname(entryPath), spec, 1);
  }
  return [...found.values()];
}

/** The host dialog paired with a webview entry, by the `<Name>Dialog.ts` convention. */
function hostDialogFor(entryPath) {
  const stem = basename(entryPath, '.ts').toLowerCase();
  const hostDir = dirname(dirname(entryPath));
  if (!existsSync(hostDir)) {
    return undefined;
  }
  for (const name of readdirSync(hostDir)) {
    if (name.endsWith('Dialog.ts') && basename(name, '.ts').toLowerCase() === stem) {
      return join(hostDir, name);
    }
  }
  return undefined;
}

const failures = [];
let entries = 0;

for (const entry of walk(SRC_ROOT)) {
  if (!/(^|\/)webview\/[^/]+\.ts$/.test(posixRelative(SRC_ROOT, entry))) {
    continue;
  }
  entries++;
  const entryFile = read(entry);
  const validators = validatorModulesFor(entry, entryFile.codeWithStrings);
  if (validators.length === 0) {
    continue;
  }

  const host = hostDialogFor(entry);
  if (!host) {
    continue;
  }
  const hostFile = read(host);
  // The escape hatch must be a real COMMENT, not a string literal.
  if (hostFile.comments.includes(ESCAPE_HATCH)) {
    continue;
  }

  for (const { spec, named, exports } of validators) {
    if (exports.length === 0) {
      // Named like a validator but nothing recognisable exported: refuse to
      // skip silently, which would let a renamed export shape disable the guard.
      failures.push(
        `${resolve(dirname(entry), spec)}.ts: looks like a validator module but exports no\n` +
          `    recognisable validator. Rename it or export a validate*/assertValid* function so\n` +
          `    the host contract stays checkable.`
      );
      continue;
    }
    // Require a CALL in the CODE view: a mention in a comment or a string
    // literal documents an intention, it does not validate anything.
    const validates = exports.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(hostFile.code));
    if (!validates) {
      failures.push(
        `${host}: never calls a validator from '${basename(spec)}', but its webview\n` +
          `    entry ${entry} does. Expected one of: ${exports.join(', ')}.\n` +
          `    The webview is a separate scripting context — re-validate on the host, or\n` +
          `    annotate the host with '// ${ESCAPE_HATCH} <reason>'.`
      );
    }
    void named;
  }
}

if (entries === 0) {
  console.error(`check-host-revalidates: found no webview entry under ${resolve(SRC_ROOT)}; the scan is vacuous`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error('check-host-revalidates: validator used only in a webview entry\n');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}

console.log(`check-host-revalidates: OK (scanned ${resolve(SRC_ROOT)})`);
