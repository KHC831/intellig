/**
 * Unit tests for `scripts/prepublish-guard.mjs` — TL-93 data-driven
 * placeholder-fingerprint dispatch.
 *
 * Each fingerprint rule type (`minMarkers`, `sha256`, `regex`,
 * `literal`) is exercised via a controlled `prerelease-state.json`
 * fixture written into a tmp dir, with the fixture path injected
 * through the `INTELLIG_PREPUBLISH_STATE_PATH` test seam. The guard
 * is invoked as a child process (it's an .mjs entry-point script)
 * and we assert exit code + stderr against the rule's expected
 * fail message.
 *
 * RED→GREEN evidence: each spec was first added with the production
 * guard still on the old hardcoded-constants implementation; the
 * dispatch on entry.rule did not exist, so the tests failed (RED).
 * Adding the JSON-driven `runFingerprint(...)` dispatcher turned
 * them GREEN.
 *
 * Why subprocess (not import): the guard is an executable script
 * with side effects (`process.exit`). Importing it would terminate
 * the test process. `spawnSync` keeps each invocation hermetic.
 */

import '../../setup';
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'prepublish-guard.mjs');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGuard(opts: {
  statePath: string;
  cwd: string;
  env?: Record<string, string>;
}): RunResult {
  const result = spawnSync('node', [GUARD_SCRIPT], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      INTELLIG_PREPUBLISH_STATE_PATH: opts.statePath,
      // Make sure no stray bypass envs leak from the runner.
      INTELLIG_INTERNAL_PREPUBLISH_DRYRUN: '',
      INTELLIG_ALLOW_PLACEHOLDERS: '',
      INTELLIG_DOGFOOD_BUILD: '',
      INTELLIG_DOGFOOD_INVOCATION: '',
      ...(opts.env ?? {}),
    },
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build a self-contained fixture workspace with: package.json,
 * CHANGELOG.md (already version-coherent so the inline coherence
 * check doesn't false-trigger), and any caller-supplied fixture
 * files. Returns the workspace dir.
 */
function makeFixtureWorkspace(extra: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepublish-guard-'));
  // Minimum scaffolding so the inline cross-file CHANGELOG version-
  // coherence check doesn't fire spuriously: version 0.1.0 in
  // package.json + a matching dated CHANGELOG entry.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.1.0' }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    '# Changelog\n\n## [0.1.0] - 2026-01-01\n\nReal release.\n',
    'utf8'
  );
  for (const [rel, content] of Object.entries(extra)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof content === 'string') {
      fs.writeFileSync(p, content, 'utf8');
    } else {
      fs.writeFileSync(p, content);
    }
  }
  return dir;
}

function writeState(workspace: string, state: unknown): string {
  const p = path.join(workspace, 'prerelease-state.json');
  fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  return p;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort; tmp dirs go away on reboot.
  }
}

describe('scripts/prepublish-guard.mjs — TL-93 data-driven dispatch', () => {
  describe('rule: minMarkers', () => {
    it('flags when ≥ minMatches markers hit (case-insensitive)', () => {
      const ws = makeFixtureWorkspace({
        'LICENSE.txt': 'License pending\nThis is for evaluation purposes only.\n',
      });
      try {
        const statePath = writeState(ws, {
          mylicense: {
            path: 'LICENSE.txt',
            rule: 'minMarkers',
            markers: ['License pending', 'PLACEHOLDER', 'evaluation purposes only'],
            minMatches: 2,
            failMessage: 'LICENSE has placeholders.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1, `expected fail; got status=${r.status}\n${r.stderr}`);
        assert.match(r.stderr, /LICENSE has placeholders\./);
        assert.match(r.stderr, /matched: License pending, evaluation purposes only/);
      } finally {
        cleanup(ws);
      }
    });

    it('passes when only 1 of minMatches=2 markers hit', () => {
      const ws = makeFixtureWorkspace({
        'LICENSE.txt': 'A real license that mentions evaluation in passing.\n',
      });
      try {
        const statePath = writeState(ws, {
          mylicense: {
            path: 'LICENSE.txt',
            rule: 'minMarkers',
            markers: ['License pending', 'PLACEHOLDER', 'evaluation purposes only'],
            minMatches: 2,
            failMessage: 'LICENSE has placeholders.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 0, `expected pass; got status=${r.status}\n${r.stderr}`);
      } finally {
        cleanup(ws);
      }
    });
  });

  describe('rule: sha256', () => {
    it('flags when file hash equals placeholderHash', () => {
      const ws = makeFixtureWorkspace({});
      try {
        const buf = Buffer.from('placeholder-icon-bytes', 'utf8');
        const filePath = path.join(ws, 'icon.png');
        fs.writeFileSync(filePath, buf);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const statePath = writeState(ws, {
          icon: {
            path: 'icon.png',
            rule: 'sha256',
            placeholderHash: hash,
            failMessage: 'icon is placeholder.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1, `expected fail; got status=${r.status}\n${r.stderr}`);
        assert.match(r.stderr, /icon is placeholder\./);
        assert.match(r.stderr, new RegExp(`sha256=${hash}`));
      } finally {
        cleanup(ws);
      }
    });

    it('passes when file hash differs from placeholderHash', () => {
      const ws = makeFixtureWorkspace({});
      try {
        fs.writeFileSync(path.join(ws, 'icon.png'), Buffer.from('different-bytes'));
        const statePath = writeState(ws, {
          icon: {
            path: 'icon.png',
            rule: 'sha256',
            // hash of the literal string 'placeholder-icon-bytes', not 'different-bytes'
            placeholderHash: crypto
              .createHash('sha256')
              .update('placeholder-icon-bytes')
              .digest('hex'),
            failMessage: 'icon is placeholder.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 0, `expected pass; got status=${r.status}\n${r.stderr}`);
      } finally {
        cleanup(ws);
      }
    });
  });

  describe('rule: regex', () => {
    it('flags when text matches pattern with given flags', () => {
      const ws = makeFixtureWorkspace({
        'NOTES.md': 'header\n## [1.0.0] - YYYY-MM-DD\nbody\n',
      });
      try {
        const statePath = writeState(ws, {
          notes: {
            path: 'NOTES.md',
            rule: 'regex',
            pattern: '^## \\[[^\\]]+\\] - YYYY-MM-DD',
            flags: 'm',
            failMessage: 'NOTES has placeholder date.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1, `expected fail; got status=${r.status}\n${r.stderr}`);
        assert.match(r.stderr, /NOTES has placeholder date\./);
      } finally {
        cleanup(ws);
      }
    });

    it('passes when text does not match pattern', () => {
      const ws = makeFixtureWorkspace({
        'NOTES.md': 'header\n## [1.0.0] - 2026-05-01\nbody\n',
      });
      try {
        const statePath = writeState(ws, {
          notes: {
            path: 'NOTES.md',
            rule: 'regex',
            pattern: '^## \\[[^\\]]+\\] - YYYY-MM-DD',
            flags: 'm',
            failMessage: 'NOTES has placeholder date.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 0, `expected pass; got status=${r.status}\n${r.stderr}`);
      } finally {
        cleanup(ws);
      }
    });
  });

  describe('rule: literal', () => {
    it('flags when placeholder substring appears', () => {
      const ws = makeFixtureWorkspace({
        'CONTACT.md': 'Email <EMAIL_PLACEHOLDER> for security reports.\n',
      });
      try {
        const statePath = writeState(ws, {
          contact: {
            path: 'CONTACT.md',
            rule: 'literal',
            placeholder: '<EMAIL_PLACEHOLDER>',
            failMessage: 'CONTACT has email placeholder.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1, `expected fail; got status=${r.status}\n${r.stderr}`);
        assert.match(r.stderr, /CONTACT has email placeholder\./);
      } finally {
        cleanup(ws);
      }
    });

    it('passes when placeholder substring is absent', () => {
      const ws = makeFixtureWorkspace({
        'CONTACT.md': 'Email security@example.com for security reports.\n',
      });
      try {
        const statePath = writeState(ws, {
          contact: {
            path: 'CONTACT.md',
            rule: 'literal',
            placeholder: '<EMAIL_PLACEHOLDER>',
            failMessage: 'CONTACT has email placeholder.',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 0, `expected pass; got status=${r.status}\n${r.stderr}`);
      } finally {
        cleanup(ws);
      }
    });
  });

  describe('config-error surfaces', () => {
    it('reports unknown rule with supported-rules hint', () => {
      const ws = makeFixtureWorkspace({ 'F.txt': 'x' });
      try {
        const statePath = writeState(ws, {
          bad: { path: 'F.txt', rule: 'banana' },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1, `expected fail; got ${r.status}\n${r.stderr}`);
        assert.match(r.stderr, /unknown rule "banana"/);
        assert.match(r.stderr, /Supported: minMarkers, sha256, regex, literal\./);
      } finally {
        cleanup(ws);
      }
    });

    it('reports missing referenced file', () => {
      const ws = makeFixtureWorkspace({});
      try {
        const statePath = writeState(ws, {
          gone: {
            path: 'does-not-exist.txt',
            rule: 'literal',
            placeholder: 'x',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1, `expected fail; got ${r.status}\n${r.stderr}`);
        assert.match(r.stderr, /does-not-exist\.txt is missing/);
      } finally {
        cleanup(ws);
      }
    });

    it('skips $schema and _comment metadata keys', () => {
      const ws = makeFixtureWorkspace({});
      try {
        const statePath = writeState(ws, {
          $schema: 'https://example/schema.json',
          _comment: 'documentation only',
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(
          r.status,
          0,
          `expected pass when only metadata keys present; got ${r.status}\n${r.stderr}`
        );
      } finally {
        cleanup(ws);
      }
    });
  });

  describe('changelogDate tag → version-coherence cascade short-circuit (R1 senior-M1)', () => {
    // The inline `checkChangelogVersionMatches()` short-circuits when the
    // placeholder-date fingerprint already fired on the same file (otherwise
    // the cascade error points at the WRONG section). The short-circuit
    // listens for `tag === 'changelogDate'`. The bug class M1 catches: if
    // a future maintainer migrates the changelog placeholder from `regex`
    // to `literal` / `minMarkers`, the tag-handling silently breaks unless
    // it's lifted out of the regex case. These specs pin tag handling
    // across the rule types most likely to host a changelog migration.

    function buildWorkspaceWithMismatchedChangelog(): string {
      // CHANGELOG with a *placeholder* date AND a stale top-dated section
      // pointing at version 0.0.9. package.json says 0.1.0. With the
      // short-circuit working: only the placeholder-date fingerprint
      // fires. With it broken: the cascade error ALSO fires (wrong
      // section), which we surface by counting failure lines.
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'prepublish-cascade-'));
      fs.writeFileSync(
        path.join(ws, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.1.0' }, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(ws, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.1.0] - YYYY-MM-DD\n\nNew.\n\n## [0.0.9] - 2025-01-01\n\nOld.\n',
        'utf8'
      );
      return ws;
    }

    it('regex rule with tag=changelogDate suppresses the version-coherence cascade', () => {
      const ws = buildWorkspaceWithMismatchedChangelog();
      try {
        const statePath = writeState(ws, {
          changelog: {
            path: 'CHANGELOG.md',
            rule: 'regex',
            pattern: '^## \\[[^\\]]+\\] - YYYY-MM-DD',
            flags: 'm',
            failMessage: 'placeholder date in CHANGELOG.',
            tag: 'changelogDate',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1);
        assert.match(r.stderr, /placeholder date in CHANGELOG\./);
        // With short-circuit working, the version-coherence error MUST NOT fire.
        assert.doesNotMatch(
          r.stderr,
          /top dated entry is \[0\.0\.9\]/,
          `version-coherence cascade leaked through; stderr:\n${r.stderr}`
        );
      } finally {
        cleanup(ws);
      }
    });

    it('literal rule with tag=changelogDate ALSO suppresses the cascade (rule-type-agnostic)', () => {
      // This is the M1 bug class: today the tag handling is wired only in
      // the `regex` case. A future maintainer who migrates the changelog
      // placeholder to `literal` (because YYYY-MM-DD is a fine literal)
      // would silently lose the short-circuit unless tag handling is
      // shared. RED on the pre-fix code path.
      const ws = buildWorkspaceWithMismatchedChangelog();
      try {
        const statePath = writeState(ws, {
          changelog: {
            path: 'CHANGELOG.md',
            rule: 'literal',
            placeholder: '- YYYY-MM-DD',
            failMessage: 'literal placeholder date.',
            tag: 'changelogDate',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1);
        assert.match(r.stderr, /literal placeholder date\./);
        assert.doesNotMatch(
          r.stderr,
          /top dated entry is \[0\.0\.9\]/,
          `version-coherence cascade leaked through under literal rule; stderr:\n${r.stderr}`
        );
      } finally {
        cleanup(ws);
      }
    });

    it('minMarkers rule with tag=changelogDate ALSO suppresses the cascade', () => {
      const ws = buildWorkspaceWithMismatchedChangelog();
      try {
        const statePath = writeState(ws, {
          changelog: {
            path: 'CHANGELOG.md',
            rule: 'minMarkers',
            markers: ['YYYY-MM-DD', 'YYYY'],
            minMatches: 2,
            failMessage: 'minMarkers placeholder date.',
            tag: 'changelogDate',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 1);
        assert.match(r.stderr, /minMarkers placeholder date\./);
        assert.doesNotMatch(
          r.stderr,
          /top dated entry is \[0\.0\.9\]/,
          `cascade leaked through under minMarkers rule; stderr:\n${r.stderr}`
        );
      } finally {
        cleanup(ws);
      }
    });
  });

  describe('all rules pass scenario', () => {
    it('exits 0 with success message when no fingerprint matches', () => {
      const ws = makeFixtureWorkspace({
        'L.txt': 'Real license, no markers.',
        'I.bin': Buffer.from('different-bytes'),
        'C.md': 'No placeholder dates here.\n',
        'S.md': 'Real email security@example.com.\n',
      });
      try {
        const statePath = writeState(ws, {
          l: {
            path: 'L.txt',
            rule: 'minMarkers',
            markers: ['License pending', 'PLACEHOLDER'],
            minMatches: 2,
          },
          i: {
            path: 'I.bin',
            rule: 'sha256',
            placeholderHash: 'deadbeef'.repeat(8),
          },
          c: {
            path: 'C.md',
            rule: 'regex',
            pattern: 'YYYY-MM-DD',
            flags: '',
          },
          s: {
            path: 'S.md',
            rule: 'literal',
            placeholder: '<EMAIL_PLACEHOLDER>',
          },
        });
        const r = runGuard({ statePath, cwd: ws });
        assert.strictEqual(r.status, 0, `expected pass; got ${r.status}\n${r.stderr}`);
        assert.match(r.stdout, /OK — no release-blocking placeholders detected\./);
      } finally {
        cleanup(ws);
      }
    });
  });
});

describe('scripts/prerelease-state.json (the real, shipped config)', () => {
  it('has the four real-world placeholder entries (license/icon/changelog/security) wired through valid rule types', () => {
    // Characterization test: pins the shape of the production state
    // file. Adding a 5th placeholder = adding a JSON entry, and that
    // change should land with this test asserting the new entry is
    // typed against one of the four supported rules.
    const realStatePath = path.join(REPO_ROOT, 'scripts', 'prerelease-state.json');
    const real = JSON.parse(fs.readFileSync(realStatePath, 'utf8')) as Record<string, unknown>;
    const validRules = new Set(['minMarkers', 'sha256', 'regex', 'literal']);
    const fingerprintKeys = Object.keys(real).filter(
      (k) => !k.startsWith('$') && !k.startsWith('_')
    );
    assert.ok(
      fingerprintKeys.length >= 4,
      `expected at least 4 fingerprint entries (license / icon / changelog / security); got ${fingerprintKeys.length}: ${fingerprintKeys.join(', ')}`
    );
    for (const k of fingerprintKeys) {
      const entry = real[k] as { path?: string; rule?: string };
      assert.ok(
        typeof entry.path === 'string' && entry.path.length > 0,
        `entry "${k}" must have a non-empty string \`path\``
      );
      assert.ok(
        typeof entry.rule === 'string' && validRules.has(entry.rule),
        `entry "${k}" rule="${String(entry.rule)}" must be one of ${Array.from(validRules).join(', ')}`
      );
    }
  });
});
