#!/usr/bin/env node
/**
 * Structural CI guard — every commit action that starts an interactive rebase
 * first checks the target is contained in the current branch.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    The history-rewriting commit actions (squash / drop / edit message /
 *    interactive rebase) all rebase `oldest^..HEAD` — i.e. the CHECKED-OUT
 *    branch. Running one on a commit that lives on ANOTHER branch (HEAD does
 *    not contain it) silently fast-forwards or transplants the current branch
 *    instead of touching the target's branch, with a success toast and no
 *    squash/drop performed. IntelliJ blocks this in
 *    GitCommitEditingActionBase.checkCommitsCanBeEdited (commit must be in
 *    HEAD). The uniform fix is a perform-time gate — the shared
 *    `_isOldestInCurrentBranch` helper — run BEFORE any stash/rebase. This
 *    guard stops a new (or refactored) rebase-starting handler from rejoining
 *    the class un-gated.
 *
 * 2. Heuristic + how it scales
 *    Scope: src/commits/CommitContextMenuCommands.ts. The file is split into
 *    class-member methods (2-space indent headers); any method whose body
 *    STARTS a rebase (`startInteractiveRebase(` or `._openRebaseEditor(`) must
 *    also invoke the shared containment guard (`_isOldestInCurrentBranch(`).
 *    A method that legitimately needs no gate marks itself with
 *    `rebase-containment-exempt: <reason>` in its body.
 *
 * 3. Known false-positive cases
 *    A helper that forwards to `startInteractiveRebase` for a non-rewriting
 *    purpose would trip this; annotate it `rebase-containment-exempt: <reason>`.
 *    None exist today.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'src', 'commits', 'CommitContextMenuCommands.ts');
const src = readFileSync(file, 'utf8');
const lines = src.split('\n');

// Class members are declared at exactly 2-space indent. A member header is an
// identifier (with optional modifiers) immediately followed by `(` — property
// declarations (`name: Type;`) and arrow-typed fields (`name?: (a) => b`) have
// a `:`/`?:` before any paren, so they don't match.
const HEADER = /^ {2}(?:public |private |protected |static |readonly |abstract |get |set |async )*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\(/;
const REBASE_START = /startInteractiveRebase\(|\._openRebaseEditor\(/;
const GUARD = /_isOldestInCurrentBranch\(/;
const EXEMPT = /rebase-containment-exempt:/;

// Collect method-header line indices.
const headerIdx = [];
for (let i = 0; i < lines.length; i++) {
  if (HEADER.test(lines[i])) {
    headerIdx.push(i);
  }
}

const offenders = [];
for (let h = 0; h < headerIdx.length; h++) {
  const start = headerIdx[h];
  const end = h + 1 < headerIdx.length ? headerIdx[h + 1] : lines.length;
  const body = lines.slice(start, end).join('\n');
  if (!REBASE_START.test(body)) {
    continue;
  }
  if (EXEMPT.test(body) || GUARD.test(body)) {
    continue;
  }
  const name = lines[start].trim().replace(/\s*\{?\s*$/, '');
  offenders.push({ line: start + 1, name });
}

if (offenders.length > 0) {
  console.error(
    'check-rebase-containment-guarded: a rebase-starting commit handler is missing'
  );
  console.error(
    'the HEAD-containment gate. Call `_isOldestInCurrentBranch(repo, <oldest>)`'
  );
  console.error(
    'before any stash/rebase (a squash/drop/edit on another branch silently'
  );
  console.error(
    'moves the checked-out branch), or annotate the method'
  );
  console.error('`rebase-containment-exempt: <reason>` if it truly needs no gate.');
  console.error('');
  for (const o of offenders) {
    console.error(`  ${file}:${o.line}  ${o.name}`);
  }
  process.exit(1);
}

console.log('check-rebase-containment-guarded: OK');
