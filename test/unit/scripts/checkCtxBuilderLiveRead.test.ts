/**
 * Companion spec for scripts/check-ctx-builder-live-read.mjs.
 *
 * Proves the guard (a) passes against the real tree, and has teeth on each arm:
 * (b) a setter-wired field snapshotted in a _*Context() builder fails; (c) the
 * same field exposed as a call-time lambda passes; (d) a snapshot of a NON-setter
 * (constructor-only) field passes; (e) a snapshot annotated live-read-exempt
 * passes.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const SCRIPT = path.join(process.cwd(), 'scripts/check-ctx-builder-live-read.mjs');
const TMP_ROOT = SCRATCH_ROOT;

function runFixture(source: string): { status: number | null; stderr: string } {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'ctx-live-'));
  try {
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'sample.ts'), source, 'utf8');
    const r = spawnSync('node', [SCRIPT, srcDir], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SNAPSHOT = `class Foo {
  private _svc?: { x(): void };
  setSvc(s: { x(): void }): void {
    this._svc = s;
  }
  private _fooContext() {
    return {
      svc: this._svc,
    };
  }
}
`;

const LAMBDA = `class Foo {
  private _svc?: { x(): void };
  setSvc(s: { x(): void }): void {
    this._svc = s;
  }
  private _fooContext() {
    return {
      svc: () => this._svc,
    };
  }
}
`;

const NON_SETTER = `class Foo {
  private _dep: { x(): void };
  constructor(dep: { x(): void }) {
    this._dep = dep;
  }
  private _fooContext() {
    return {
      dep: this._dep,
    };
  }
}
`;

const EXEMPT = `class Foo {
  private _svc?: { x(): void };
  setSvc(s: { x(): void }): void {
    this._svc = s;
  }
  private _fooContext() {
    return {
      svc: this._svc, // live-read-exempt: read before the first await, snapshot == live
    };
  }
}
`;

describe('check-ctx-builder-live-read guard', () => {
  it('passes against the real tree', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    assert.strictEqual(
      r.status,
      0,
      `guard should pass on the real tree; stderr:\n${r.stderr ?? ''}`
    );
  });

  it('fails a setter-wired field snapshotted in a ctx builder (violation arm has teeth)', () => {
    const { status, stderr } = runFixture(SNAPSHOT);
    assert.strictEqual(status, 1, `a snapshotted setter-wired field must fail; ${stderr}`);
    assert.ok(stderr.includes('_svc') && stderr.includes('call-time lambda'));
  });

  it('passes the same field exposed as a call-time lambda (compliant arm)', () => {
    const { status, stderr } = runFixture(LAMBDA);
    assert.strictEqual(status, 0, `a call-time lambda must pass; ${stderr}`);
  });

  it('passes a snapshot of a NON-setter (constructor-only) field', () => {
    const { status, stderr } = runFixture(NON_SETTER);
    assert.strictEqual(status, 0, `a constructor-stable snapshot is fine; ${stderr}`);
  });

  it('passes a snapshot annotated live-read-exempt (escape hatch)', () => {
    const { status, stderr } = runFixture(EXEMPT);
    assert.strictEqual(status, 0, `the justification escape hatch must pass; ${stderr}`);
  });
});
