/**
 * Disposal-ownership guard for `deactivate()`.
 *
 * A service must have exactly one disposal owner. Services that are pushed onto
 * `context.subscriptions` (in registerViews) are disposed by VS Code's own
 * subscription teardown AFTER `deactivate()` returns — so `deactivate()` must
 * NOT also call `.dispose()` on them, or each runs twice. A non-idempotent
 * dispose then throws during host shutdown. `deactivate()` still nulls the
 * module ref so a later `activate()` builds a fresh instance.
 *
 * Services that are NOT pushed as disposables (their webview *registration* is
 * pushed, not the instance) keep their manual `deactivate()` disposal — that is
 * their only owner.
 *
 * This is a source-structural characterization guard: `deactivate()` operates on
 * module-level singletons set up by `activate()`, which can't be driven from a
 * unit test without a host. The ext-host smoke (05.deactivate) covers the
 * runtime "no throw + idempotent" path; this guard pins the single-owner
 * invariant so a future edit can't silently re-introduce a double-dispose.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

function repoRoot(): string {
  return path.resolve(__dirname, '../../..');
}

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot(), rel), 'utf-8');
}

/** Extract the body of a top-level `export function <name>(...) { ... }`. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// Services whose instance is `context.subscriptions.push`-ed in registerViews →
// VS Code owns their disposal; deactivate() must only null them.
const CONTEXT_OWNED = [
  'statusBarService',
  'stashView',
  'shelfView',
  'gutterBlameProvider',
  'branchComparisonView',
  'rebaseProgressView',
  'keymapService',
] as const;

// Services NOT pushed as disposables → deactivate() is their only owner.
const MANUAL_OWNED = [
  'mergeView',
  'rebaseEditor',
  'inlineBlameProvider',
  'commitDialog',
  'commitToolWindow',
  'branchPopup',
  'gitToolWindowProvider',
] as const;

describe('deactivate() disposal ownership', () => {
  const deactivateBody = functionBody(read('src/extension.ts'), 'deactivate');
  // Registration is spread across a few modules as registerViews is split up.
  // Read them as one corpus so this audit asserts "registered SOMEWHERE at
  // activation", which is the actual invariant — pinning it to one filename
  // makes the audit fail on a pure move, and worse, silently stop checking if
  // the grep is later relaxed to match.
  const registerViews = [
    read('src/registration/registerViews.ts'),
    read('src/registration/registerEditorProviders.ts'),
  ].join('\n');
  // StashView/ShelfView are created (and disposal-registered) by the
  // singleton factory, not inline in registerViews.
  const viewSingletons = read('src/shelf/viewSingletons.ts');

  describe('context-owned services (pushed onto context.subscriptions)', () => {
    for (const svc of CONTEXT_OWNED) {
      it(`${svc} is registered on context.subscriptions (VS Code owns disposal)`, () => {
        const viaFactory = svc === 'stashView' || svc === 'shelfView';
        const source = viaFactory ? viewSingletons : registerViews;
        const pattern = viaFactory
          ? `subscriptions.push(host.${svc})`
          : `subscriptions.push(ctx.${svc})`;
        assert.ok(source.includes(pattern), `${svc} must be pushed onto context.subscriptions`);
      });

      it(`deactivate() does NOT manually dispose ${svc} (avoids double-dispose)`, () => {
        assert.ok(
          !deactivateBody.includes(`${svc}.dispose()`),
          `${svc} is context-owned; deactivate() must not also call ${svc}.dispose()`
        );
      });

      it(`deactivate() still nulls ${svc} so re-activation builds a fresh instance`, () => {
        assert.ok(
          deactivateBody.includes(`${svc} = undefined`),
          `deactivate() must release the ${svc} module ref`
        );
      });
    }
  });

  describe('manual-owned services (not pushed as disposables)', () => {
    for (const svc of MANUAL_OWNED) {
      it(`${svc} is NOT pushed as a disposable (deactivate is the sole owner)`, () => {
        assert.ok(
          !registerViews.includes(`subscriptions.push(ctx.${svc})`),
          `${svc} must not be a context.subscriptions disposable`
        );
      });

      it(`deactivate() manually disposes ${svc}`, () => {
        assert.ok(
          deactivateBody.includes(`${svc}.dispose()`),
          `${svc} has no other owner; deactivate() must dispose it`
        );
      });
    }
  });

  // General guard (enumeration-free): catches ANY future service that is both
  // pushed onto context.subscriptions AND manually disposed in deactivate(),
  // even one not listed above. Extracts every `subscriptions.push(ctx.<x>)`
  // module ref from registerViews and every `<x>.dispose()` from deactivate()
  // and asserts the intersection is empty.
  describe('no module ref is both context-owned and manually disposed', () => {
    function matchAll(source: string, re: RegExp): string[] {
      const names = new Set<string>();
      for (const m of source.matchAll(re)) {
        names.add(m[1]);
      }
      return [...names];
    }

    it('the pushed-as-disposable set and the deactivate-disposed set are disjoint', () => {
      const pushed = new Set(matchAll(registerViews, /subscriptions\.push\(ctx\.(\w+)\)/g));
      const disposed = matchAll(deactivateBody, /(?:^|[^.\w])(\w+)\.dispose\(\)/g);
      const doubleOwned = disposed.filter((name) => pushed.has(name));
      assert.deepStrictEqual(
        doubleOwned,
        [],
        `each service must have one disposal owner; double-owned (pushed AND disposed): ${doubleOwned.join(', ')}`
      );
    });
  });
});
