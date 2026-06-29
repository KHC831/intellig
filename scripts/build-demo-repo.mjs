#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// build-demo-repo.mjs — generate a screenshot-friendly demo repo.
//
// Builds a self-contained git repo (plus a bare "remote") with a rich, varied
// history so every IntelliG feature has good content to photograph:
//   - a branchy graph: main + merged feature branch + an in-progress branch,
//     release tags, and multiple authors (for color variety),
//   - a file renamed mid-history (for the File History rename-follow view),
//   - the current branch one commit BEHIND its upstream (for the Incoming tab),
//   - a stash entry (for Shelf/Stash),
//   - staged + unstaged + untracked working changes (for the Commit dialog /
//     Local Changes / changelists).
//
// Usage:   node scripts/build-demo-repo.mjs [targetDir]
//          (default targetDir: ~/intellig-demo)
//
// Then open <targetDir>/intellig-demo in VS Code with IntelliG installed and
// capture the shots listed at the end of this script's output.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

// Default the demo next to the IntelliG repo (a sibling dir), NOT in $HOME — so
// `node scripts/build-demo-repo.mjs` with no arg lands in the workspace where
// the project lives. Pass an explicit dir as argv[2] to override.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // <repo>/scripts → <repo>
const defaultTarget = path.join(path.dirname(repoRoot), 'intellig-demo');
const target = path.resolve(process.argv[2] || defaultTarget);
const work = path.join(target, 'intellig-demo');
const remote = path.join(target, 'intellig-demo-remote.git');

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true });
}
fs.mkdirSync(work, { recursive: true });

const AUTHORS = {
  ada: { name: 'Ada Lovelace', email: 'ada@example.com' },
  linus: { name: 'Linus Bauer', email: 'linus@example.com' },
  grace: { name: 'Grace Okafor', email: 'grace@example.com' },
};

function git(cwd, args, author) {
  const a = author ?? AUTHORS.ada;
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_COMMITTER_NAME: a.name,
      GIT_COMMITTER_EMAIL: a.email,
      GIT_AUTHOR_DATE: nextDate(),
      GIT_COMMITTER_DATE: lastDate,
    },
  });
}

// March commit dates forward a few hours each so the log reads naturally.
let clock = new Date('2026-03-02T09:00:00Z').getTime();
let lastDate = new Date(clock).toISOString();
function nextDate() {
  clock += (3 + Math.floor(Math.random() * 5)) * 3600 * 1000;
  lastDate = new Date(clock).toISOString();
  return lastDate;
}

function write(rel, content) {
  const abs = path.join(work, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function commit(message, author) {
  git(work, ['add', '-A'], author);
  git(work, ['commit', '-m', message], author);
}

// ── history ─────────────────────────────────────────────────────────────────
git(work, ['init', '-q', '-b', 'main']);
git(work, ['config', 'commit.gpgsign', 'false']);

write('README.md', '# Acme App\n\nA small demo project.\n');
// A multi-line, long-lived file. It is created here, edited by several
// authors, and renamed later — so File History + multi-author Blame both have
// rich content to show.
write(
  'src/greeter.ts',
  [
    'export interface Greeter {',
    '  greet(name: string): string;',
    '}',
    '',
    'export function makeGreeter(prefix: string): Greeter {',
    '  return {',
    '    greet: (name) => `${prefix}, ${name}!`,',
    '  };',
    '}',
    '',
  ].join('\n')
);
commit('Initial project scaffold', AUTHORS.ada);

write('src/config.ts', 'export const config = { retries: 3 };\n');
write(
  'src/greeter.ts',
  [
    'import { config } from "./config";',
    '',
    'export interface Greeter {',
    '  greet(name: string): string;',
    '}',
    '',
    'export function makeGreeter(prefix: string): Greeter {',
    '  return {',
    '    greet: (name) => `${prefix}, ${name} (x${config.retries})`,',
    '  };',
    '}',
    '',
  ].join('\n')
);
commit('Add config loader and wire greeter', AUTHORS.linus);
git(work, ['tag', 'v0.1.0']);

// feature/login off main, two commits, then merged back with --no-ff.
git(work, ['checkout', '-q', '-b', 'feature/login']);
write('src/login.ts', 'export function login(user: string) {\n  return `hi ${user}`;\n}\n');
commit('Add login form', AUTHORS.grace);
write('src/login.ts', 'import { config } from "./config";\nexport function login(user: string) {\n  return `hi ${user} (${config.retries})`;\n}\n');
commit('Wire login to config service', AUTHORS.grace);

git(work, ['checkout', '-q', 'main']);
write('README.md', '# Acme App\n\nA small demo project with login.\n');
commit('Expand README', AUTHORS.ada);
git(work, ['merge', '--no-ff', '-m', 'Merge branch feature/login', 'feature/login'], AUTHORS.ada);
git(work, ['tag', 'v0.2.0']);

// PURE rename — no content change in this commit — so git records it as a
// rename (R100) and File History can follow across it. Changing content in the
// same commit can drop below git's 50% rename-similarity threshold and break
// the follow (which is exactly what produced a 2-commit history before).
git(work, ['mv', 'src/greeter.ts', 'src/greeting.ts']);
commit('Rename greeter.ts to greeting.ts', AUTHORS.linus);

// Grace rewrites the greeting line; Ada adds a farewell — they touch DIFFERENT
// lines, so Blame on greeting.ts shows three distinct authors (Ada/Linus/Grace).
write(
  'src/greeting.ts',
  [
    'import { config } from "./config";',
    '',
    'export interface Greeter {',
    '  greet(name: string): string;',
    '}',
    '',
    'export function makeGreeter(prefix: string): Greeter {',
    '  return {',
    '    greet: (name) => `Hello ${prefix} ${name}!`,',
    '  };',
    '}',
    '',
  ].join('\n')
);
commit('Polish greeting copy', AUTHORS.grace);

write(
  'src/greeting.ts',
  [
    'import { config } from "./config";',
    '',
    'export interface Greeter {',
    '  greet(name: string): string;',
    '  farewell(name: string): string;',
    '}',
    '',
    'export function makeGreeter(prefix: string): Greeter {',
    '  return {',
    '    greet: (name) => `Hello ${prefix} ${name}!`,',
    '    farewell: (name) => `Bye, ${name} (x${config.retries})`,',
    '  };',
    '}',
    '',
  ].join('\n')
);
commit('Add farewell to greeter', AUTHORS.ada);

// feature/graph: in-progress, NOT merged (shows an active side branch).
git(work, ['checkout', '-q', '-b', 'feature/graph', 'main']);
write('src/graph.ts', 'export function layout(nodes: number[]) {\n  return nodes.map((n, i) => ({ n, lane: i % 3 }));\n}\n');
commit('Sketch graph lane layout', AUTHORS.ada);
write('src/graph.ts', 'export function layout(nodes: number[]) {\n  // assign lanes by parent chain\n  return nodes.map((n, i) => ({ n, lane: i % 3 }));\n}\n');
commit('Comment lane assignment', AUTHORS.ada);

git(work, ['checkout', '-q', 'main']);
write('src/status.ts', 'export const bar = "ready";\n');
commit('Add status bar text', AUTHORS.linus);

// ── bare remote + put main one commit BEHIND its upstream (Incoming tab) ─────
execFileSync('git', ['init', '-q', '--bare', remote]);
git(work, ['remote', 'add', 'origin', remote]);
git(work, ['push', '-q', '-u', 'origin', 'main']);
git(work, ['push', '-q', 'origin', 'feature/graph']);
git(work, ['push', '-q', 'origin', 'v0.1.0', 'v0.2.0']);

const helper = path.join(target, 'helper-clone');
execFileSync('git', ['clone', '-q', remote, helper]);
fs.writeFileSync(path.join(helper, 'src', 'hotfix.ts'), 'export const patched = true;\n');
git(helper, ['add', '-A'], AUTHORS.grace);
git(helper, ['commit', '-m', 'Hotfix: patch flag (pushed by a teammate)'], AUTHORS.grace);
git(helper, ['push', '-q', 'origin', 'main']);
fs.rmSync(helper, { recursive: true, force: true });

git(work, ['fetch', '-q', 'origin']); // local main now 1 behind origin/main

// ── a stash entry (Shelf/Stash) ─────────────────────────────────────────────
write('src/config.ts', 'export const config = { retries: 5, timeout: 30 };\n');
git(work, ['stash', 'push', '-m', 'WIP: bump retries and add timeout']);

// ── leave dirty working tree (Commit dialog / Local Changes / changelists) ──
// Unstaged modify on the tracked greeting.ts (changes the greet line).
write(
  'src/greeting.ts',
  [
    'import { config } from "./config";',
    '',
    'export interface Greeter {',
    '  greet(name: string): string;',
    '  farewell(name: string): string;',
    '}',
    '',
    'export function makeGreeter(prefix: string): Greeter {',
    '  return {',
    '    greet: (name) => `Hey ${prefix} ${name}!`,',
    '    farewell: (name) => `Bye, ${name} (x${config.retries})`,',
    '  };',
    '}',
    '',
  ].join('\n')
);
write('src/feature-flags.ts', 'export const flags = { newGraph: true };\n');
git(work, ['add', 'src/feature-flags.ts']); // staged new file
write('NOTES.md', '- try the new graph layout\n- review login retries\n'); // untracked

// ── done ────────────────────────────────────────────────────────────────────
const log = execFileSync('git', ['-C', work, 'log', '--oneline', '--graph', '--all', '--decorate'], {
  encoding: 'utf8',
});
console.log('\nDemo repo built at:\n  ' + work + '\n');
console.log('Graph:\n' + log);
console.log(`Open it:  code "${work}"\n`);
console.log('Suggested screenshots (save into the IntelliG repo at images/):');
console.log(`
  images/graph.png       Git tool window — the Log/graph tab (branchy history + tags + the
                         "main is 1 behind origin/main" head). The headline shot.
  images/commit.png      Commit dialog / Local Changes — staged (feature-flags.ts),
                         unstaged (greeting.ts), untracked (NOTES.md).
  images/branches.png    Branch popup (local + remote branches, feature/graph, tags).
  images/file-history.png  File History on src/greeting.ts — shows pre-rename history (it
                         was greeter.ts). Right-click src/greeting.ts → Show History.
  images/blame.png       Blame on src/greeting.ts — three authors on different lines
                         (Ada / Linus / Grace). Crop OUT the "[Extension Development Host]"
                         title bar.
  images/incoming.png    Incoming tab — the teammate "Hotfix" commit shows as incoming.
  images/shelf.png       Shelf — NOTE: IntelliG's Shelf is its own patch store, NOT git
                         stash, so "Show Shelf List" won't show the demo's git stash. To
                         populate it: in the Commit view, right-click a changed file →
                         "Shelve Changes…", then run "Show Shelf List" and capture that.

Recommended: ~1600px wide PNGs, light or dark theme (be consistent), crop to the panel.
`);
