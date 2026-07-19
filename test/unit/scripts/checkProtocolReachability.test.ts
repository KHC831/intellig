/**
 * Companion spec for scripts/check-protocol-reachability.mjs.
 *
 * The guard's whole value is catching a message type that compiles, type-checks
 * and reads as a shipped feature while nothing can ever send or receive it.
 * These drive it over fixtures pinning both directions (inbound with no sender,
 * outbound with no handler) plus the passing shape and the allowlist path.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-protocol-reachability.mjs');

/** Fixture: one protocol file plus a webview dir, as the script expects. */
function makeFixture(protocolSource: string, webviewSource: string): string {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'reachability-'));
  fs.writeFileSync(path.join(root, 'demo.protocol.ts'), protocolSource);
  fs.mkdirSync(path.join(root, 'webview'));
  fs.writeFileSync(path.join(root, 'webview', 'main.ts'), webviewSource);
  return root;
}

function runGuard(root: string): { code: number; output: string } {
  try {
    return { code: 0, output: execFileSync('node', [SCRIPT, root], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const PROTOCOL = `
export type DemoInbound = { type: 'save' } | { type: 'cancel' };
export type DemoOutbound = { type: 'loaded'; value: string };
`;

describe('check-protocol-reachability guard', () => {
  it('passes when the webview mentions every declared type', () => {
    const root = makeFixture(
      PROTOCOL,
      `post({ type: 'save' });\npost({ type: 'cancel' });\nif (msg.type === 'loaded') {}\n`
    );

    assert.strictEqual(runGuard(root).code, 0);
  });

  it('fails an inbound type the webview never posts', () => {
    const root = makeFixture(PROTOCOL, `post({ type: 'save' });\nif (msg.type === 'loaded') {}\n`);

    const result = runGuard(root);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /'cancel'/);
    assert.match(result.output, /never appears/);
  });

  it('fails an outbound type the webview never handles', () => {
    const root = makeFixture(PROTOCOL, `post({ type: 'save' });\npost({ type: 'cancel' });\n`);

    const result = runGuard(root);

    assert.strictEqual(result.code, 1);
    assert.match(result.output, /'loaded'/);
  });

  it('names the protocol so the fix site is obvious', () => {
    const root = makeFixture(PROTOCOL, '');

    assert.match(runGuard(root).output, /demo:/);
  });

  it('reports every unreachable type, not just the first', () => {
    const result = runGuard(makeFixture(PROTOCOL, ''));

    for (const type of ['save', 'cancel', 'loaded']) {
      assert.match(result.output, new RegExp(`'${type}'`), `expected ${type} to be reported`);
    }
  });
});

describe('check-protocol-reachability guard — the real tree', () => {
  it('passes on the shipped protocols (allowlist applied)', () => {
    assert.match(execFileSync('node', [SCRIPT], { encoding: 'utf8' }), /OK/);
  });

  it('keeps the allowlist justified — every entry carries a comment', () => {
    const allowlist = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/protocol-reachability-allowlist.txt'),
      'utf8'
    );
    const entries = allowlist
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const unjustified = entries.filter((entry) => !entry.includes('#'));
    assert.deepStrictEqual(unjustified, [], 'every allowlist entry needs a justification comment');
  });
});
