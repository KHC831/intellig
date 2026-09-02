#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// check-doc-citations.mjs — docs/** must cite src/test/scripts paths that exist.
//
// Maintenance contract (per ADR-007 section "Guard maintenance contract"):
//
// 1. Bug class
//    A doc (ADR, testing.md, ...) points a reader at a file by path, and
//    that path no longer exists — usually because the file moved in a later
//    restructure (ADR-012) and the citing doc was never updated. The reader
//    follows the path, finds nothing, and has to reverse-engineer the real
//    location by name search.
//
// 2. Heuristic + how it scales
//    Scan every docs/**/*.md file for a `(src|test|scripts)/…` path ending in
//    .ts/.mjs/.sh/.json (backtick-wrapped or bare), anchored so neither a
//    directory prefix (`vendor/src/x.ts` is not a citation of `src/x.ts`) nor
//    a longer real extension (`src/x.tsx` is not a citation of `src/x.ts`)
//    can slip past the boundary. For each one found, resolve it relative to
//    the repo root and require the file to exist. The scan is purely
//    textual: it does not parse markdown, HTML comments, or code fences —
//    every path-shaped token matching the pattern is a citation, wherever it
//    appears on the page. Scales for free: a doc added later is covered with
//    no per-file edit, and a path that goes stale in a future move is caught
//    the next time the guard runs — same shape as check-dead-exports.mjs but
//    for prose instead of imports.
//
// 3. Known false-positive cases
//    A citation to a path that is CORRECT as historical narrative — prose
//    describing what a file was called before a since-completed move, a
//    listing of files that were deliberately retired and removed, or a path
//    shown as illustrative text inside an HTML comment or a code fence
//    (the scan does not distinguish prose from markup, so these read as
//    ordinary citations). These are NOT marked inline, because free-text
//    parsing of an inline marker's reason string cannot be made to match a
//    path exactly without also being able to match a substring of it, and
//    parsing comment/fence syntax to exempt them automatically has
//    repeatedly reintroduced the very bug class this guard exists to catch
//    (a parser bug silently widening or narrowing what counts as dead).
//    Exemptions instead live in a separate allowlist,
//    scripts/doc-citation-exemptions.json: an array of exact
//    `{ doc, citedPath, reason }` triples. A citation is exempt iff its
//    (doc, citedPath) pair matches an entry EXACTLY — no substring test, no
//    line adjacency, nothing parsed out of prose. `reason` is documentation
//    only, read by humans, never matched against anything.
//
// 4. Known false-negative cases
//    A citation to a path that DOES exist but no longer contains what the
//    prose claims (a renamed export, a moved function) is invisible — this
//    guard checks path existence only, never content. A citation split
//    across a markdown line-wrap so the regex never sees it whole is also
//    invisible; today's docs don't wrap mid-path. A file extension outside
//    the four this guard knows (.ts/.mjs/.sh/.json) — a cited .md, .html, or
//    package.json-adjacent path — is out of scope.
//
// 5. Retirement criteria
//    Retire if docs/** citations move to a machine-checked format (e.g.
//    generated API links) that can't go stale by construction.
//
// 6. Anti-vacuity
//    The real docs/ tree carries well over 100 citations, so a real-mode run
//    finding fewer than MIN_CITATIONS means the regex itself broke (a
//    path-shape edit, a doc-format change) rather than that the docs went
//    citation-free — the "scanned zero docs" arm alone would not catch this,
//    since the docs are all still there. The floor is UNCONDITIONAL in real
//    mode: it is not skipped by argument presence. Fixture mode is a
//    separate, explicit `--fixture` entry point (see Modes below), not an
//    argument-count inference, so a future real invocation with extra flags
//    cannot accidentally disable the floor.
//
//    A second anti-vacuity arm covers the allowlist itself: every entry's
//    `doc` must exist and must still cite `citedPath` somewhere (a citation
//    the doc no longer makes is a dead allowlist entry, not a live
//    exemption), and `citedPath` must still NOT exist on disk (an entry for
//    a path that now exists again is stale and should be deleted, not left
//    to silently exempt nothing). Both are structural CI failures, not
//    warnings — an allowlist that can rot silently is the same bug class
//    this guard exists to catch, one level up.
//
// Modes:
//   DEFAULT (no args): real mode. docsDir=docs, repoRoot=., exemptions=
//     scripts/doc-citation-exemptions.json, floor=DEFAULT_MIN_CITATIONS,
//     ALWAYS applied.
//   FIXTURE (companion spec only): `node check-doc-citations.mjs --fixture
//     <docsDir> <repoRoot> [minCitations] [exemptionsPath]` — floor defaults
//     to 0 (off) unless minCitations is given; exemptionsPath defaults to a
//     nonexistent path (empty allowlist) unless given.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_EXEMPTIONS_PATH = path.join(REPO_ROOT, 'scripts', 'doc-citation-exemptions.json');

// Anchored both ends: a lookbehind refuses a directory prefix
// (`vendor/src/x.ts` is not a citation of `src/x.ts`), a lookahead refuses a
// longer real extension (`src/x.tsx` is not a citation of `src/x.ts`).
const CITATION_RE =
  /`?(?<![\w/])((?:src|test|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|sh|json))(?!\w)`?/g;

const DEFAULT_MIN_CITATIONS = 100;

function listMarkdownFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name.endsWith('.md')) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * Every citation in `text`, as `{ lineNo, citedPath }`. Purely textual — no
 * comment or fence awareness — so a path-shaped token inside an HTML comment
 * or a code fence reads as a citation exactly like one in prose. See section
 * 3: that is a deliberate trade for a fixed set of allowlist entries over a
 * parser that has to correctly track markdown structure.
 */
function findCitations(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CITATION_RE)) {
      hits.push({ lineNo: i + 1, citedPath: m[1] });
    }
  });
  return hits;
}

/**
 * Load and validate the exemptions allowlist. Throws (fails the run) on a
 * malformed file, a missing field, or a duplicate (doc, citedPath) pair — a
 * duplicate is definitionally redundant and its presence means the file was
 * hand-edited without checking what was already there.
 */
function loadExemptions(exemptionsPath) {
  if (!fs.existsSync(exemptionsPath)) {
    return [];
  }
  const raw = fs.readFileSync(exemptionsPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${exemptionsPath} is not valid JSON: ${String(error.message ?? error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${exemptionsPath} must be a JSON array (got ${typeof parsed})`);
  }
  const seen = new Set();
  for (const entry of parsed) {
    for (const field of ['doc', 'citedPath', 'reason']) {
      if (typeof entry?.[field] !== 'string' || entry[field].length === 0) {
        throw new Error(
          `${exemptionsPath}: entry missing non-empty "${field}": ${JSON.stringify(entry)}`
        );
      }
    }
    const key = `${entry.doc} ${entry.citedPath}`;
    if (seen.has(key)) {
      throw new Error(
        `${exemptionsPath}: duplicate entry for (${entry.doc}, ${entry.citedPath})`
      );
    }
    seen.add(key);
  }
  return parsed;
}

/**
 * Which allowlist entries are stale: `doc` missing, `doc` no longer citing
 * `citedPath` anywhere, or `citedPath` now existing on disk (so the citation
 * it once excused is no longer dead). `citationsByDoc` maps each scanned
 * doc's absolute path to the Set of citedPaths found in it — passed in
 * rather than re-scanned, so this reuses exactly what the main pass already
 * read.
 */
function staleExemptions(exemptions, repoRoot, citationsByDoc) {
  const stale = [];
  for (const entry of exemptions) {
    const docAbs = path.join(repoRoot, entry.doc);
    if (!fs.existsSync(docAbs)) {
      stale.push({ entry, reason: `doc does not exist: ${entry.doc}` });
      continue;
    }
    if (fs.existsSync(path.join(repoRoot, entry.citedPath))) {
      stale.push({
        entry,
        reason: `citedPath now exists on disk, the citation it excused is no longer dead: ${entry.citedPath}`,
      });
      continue;
    }
    const cited = citationsByDoc.get(docAbs);
    if (!cited || !cited.has(entry.citedPath)) {
      stale.push({
        entry,
        reason: `doc no longer cites this path anywhere: ${entry.citedPath}`,
      });
    }
  }
  return stale;
}

/**
 * Turns argv into an invocation: real mode unless argv[2] is EXACTLY
 * `--fixture` — a stray positional argument (a natural
 * `node check-doc-citations.mjs docs .` invocation) stays in real mode
 * rather than being read as "an argument was passed, so relax the floor".
 * Real mode ignores every other argv slot: docsDir, repoRoot and the floor
 * are fixed at the real tree regardless of what follows.
 */
function resolveInvocation(argv) {
  const fixtureMode = argv[2] === '--fixture';
  if (!fixtureMode) {
    return {
      fixtureMode: false,
      docsDir: path.join(REPO_ROOT, 'docs'),
      repoRoot: REPO_ROOT,
      minCitations: DEFAULT_MIN_CITATIONS,
      exemptionsPath: REAL_EXEMPTIONS_PATH,
    };
  }
  const repoRoot = argv[4] ?? '.';
  return {
    fixtureMode: true,
    docsDir: argv[3] ?? 'docs',
    repoRoot,
    minCitations: Number(argv[5] ?? 0),
    exemptionsPath: argv[6] ?? path.join(repoRoot, '__no-exemptions-file-in-fixture-mode__'),
  };
}

function main() {
  const { docsDir, repoRoot, minCitations, exemptionsPath } = resolveInvocation(process.argv);

  const files = listMarkdownFiles(docsDir);
  if (files.length === 0) {
    console.error(
      'check-doc-citations FAILED — scanned zero docs. The scan is vacuous; the docs layout changed.'
    );
    process.exit(1);
  }

  let exemptions;
  try {
    exemptions = loadExemptions(exemptionsPath);
  } catch (error) {
    console.error(`check-doc-citations FAILED — ${String(error.message ?? error)}`);
    process.exit(1);
  }
  const exemptionSet = new Set(exemptions.map((e) => `${e.doc} ${e.citedPath}`));

  const dead = [];
  const citationsByDoc = new Map();
  let citations = 0;
  let exempt = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const hits = findCitations(text);
    citationsByDoc.set(f, new Set(hits.map((h) => h.citedPath)));
    for (const { lineNo, citedPath } of hits) {
      citations++;
      if (fs.existsSync(path.join(repoRoot, citedPath))) {
        continue;
      }
      const docKey = path.relative(repoRoot, f).split(path.sep).join('/');
      if (exemptionSet.has(`${docKey} ${citedPath}`)) {
        exempt++;
        continue;
      }
      dead.push({ file: f, lineNo, citedPath });
    }
  }

  if (citations < minCitations) {
    console.error(
      `check-doc-citations FAILED — only ${citations} citation(s) found across ${files.length} doc(s), ` +
        `expected at least ${minCitations}. CITATION_RE probably stopped matching (a path-shape or doc-format ` +
        'change); this run cannot prove anything about staleness.'
    );
    process.exit(1);
  }

  const stale = staleExemptions(exemptions, repoRoot, citationsByDoc);
  if (stale.length > 0) {
    console.error(`check-doc-citations FAILED — ${stale.length} stale allowlist entr(y/ies):`);
    for (const s of stale) {
      console.error(`  (${s.entry.doc}, ${s.entry.citedPath}) — ${s.reason}`);
    }
    console.error('Remove the stale entry from the allowlist.');
    process.exit(1);
  }

  if (dead.length > 0) {
    console.error(`check-doc-citations FAILED — ${dead.length} dead citation(s):`);
    for (const d of dead) {
      console.error(`  ${d.file}:${d.lineNo}  ${d.citedPath}`);
    }
    console.error(
      'Repoint the citation at the file\'s current path, or if the citation is deliberately ' +
        'historical, add { doc, citedPath, reason } to the allowlist.'
    );
    process.exit(1);
  }

  console.log(
    `check-doc-citations OK — ${files.length} doc(s) scanned, ${citations} citation(s), 0 dead (${exempt} exempt).`
  );
}

// Comparing a raw `file://` string against argv[1] fails on any path with a
// space, `#`, `%`, or non-ASCII character: import.meta.url percent-encodes,
// argv[1] does not. Resolving both to plain filesystem paths fixes that, but
// import.meta.url is also canonicalized against symlinks and path.resolve is
// not — realpath argv[1] too, so a symlinked script or directory still runs.
const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]));
if (isMain) {
  main();
}

export {
  CITATION_RE,
  DEFAULT_MIN_CITATIONS,
  findCitations,
  listMarkdownFiles,
  loadExemptions,
  resolveInvocation,
  staleExemptions,
};
