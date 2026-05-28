/**
 * Task 3.3 — unit test for the Logger surface (Requirement 1.1).
 *
 * Pins the public method shape exposed by `getLogger()` and by
 * `child(bindings)`:
 *
 *   trace(message, context?)
 *   debug(message, context?)
 *   info(message, context?)
 *   warn(message, context?)
 *   error(message, contextOrError?, errorArg?)
 *   child(bindings)
 *
 * Behaviour-level assertions (record contents, sink multicast,
 * sanitization, correlation-id propagation, lifecycle, etc.) live in
 * the other 3.x and 4.x tests. This test exists solely as a
 * structural pin so the Logger's public method names and arities
 * cannot drift silently.
 *
 * Per the task notes, every assertion runs against a freshly-reset
 * Logger via `__resetLoggerForTest()` so sibling tests cannot leak
 * sinks or cached resolver state into this one.
 *
 * _Validates: Requirement 1.1_
 */

import '../../../setup';
import * as assert from 'assert';
import { __resetLoggerForTest, getLogger, type Logger } from '../../../../utils/logger';

/**
 * The six method names the Logger surface MUST expose. The order
 * matches Requirement 1.1's enumeration so a reviewer reading the
 * requirement can read this list straight across.
 */
const LEVEL_METHODS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
const ALL_METHODS = [...LEVEL_METHODS, 'child'] as const;

/**
 * Type-level pin: assert the `Logger` interface's method names are
 * exactly the six we care about. If a future refactor renames or
 * drops one of them, this assignment fails to type-check.
 */
type LoggerMethodNames = keyof Logger;
const _surfacePin: LoggerMethodNames[] = ['trace', 'debug', 'info', 'warn', 'error', 'child'];
// Reference `_surfacePin` so the unused-binding lint does not fire.
void _surfacePin;

describe('Logger surface (Task 3.3 / Requirement 1.1)', () => {
  beforeEach(() => {
    __resetLoggerForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
  });

  describe('root Logger from getLogger()', () => {
    it('exposes trace, debug, info, warn, error, and child as functions', () => {
      const root = getLogger();

      for (const name of ALL_METHODS) {
        const method = (root as unknown as Record<string, unknown>)[name];
        assert.strictEqual(
          typeof method,
          'function',
          `getLogger().${name} must be a function (got ${typeof method})`
        );
      }
    });

    it('does not expose unexpected level methods', () => {
      const root = getLogger();

      // `fatal` is the most commonly-confused alternative name; pin its
      // absence so any future drift toward pino-style aliases is loud.
      assert.strictEqual(
        (root as unknown as Record<string, unknown>)['fatal'],
        undefined,
        'Logger surface must not expose a `fatal` method (Requirement 1.1)'
      );

      // `log` is another common shorthand that this surface intentionally
      // omits — callers must pick a level explicitly.
      assert.strictEqual(
        (root as unknown as Record<string, unknown>)['log'],
        undefined,
        'Logger surface must not expose a generic `log` method'
      );
    });

    it('level methods accept (message) and (message, context) without throwing', () => {
      const root = getLogger();

      // No sinks are registered (initLogger has not run), but the
      // resolver defaults to threshold "info" so the call paths still
      // exercise `_buildRecord` for info/warn/error. The point of this
      // test is purely arity / no-throw — assertions on emitted
      // records live elsewhere.
      for (const name of LEVEL_METHODS) {
        const method = (root as unknown as Record<string, (...args: unknown[]) => void>)[name];
        assert.doesNotThrow(
          () => method.call(root, 'message-only'),
          `Logger.${name}(message) must not throw`
        );
        assert.doesNotThrow(
          () => method.call(root, 'message-with-context', { key: 'value' }),
          `Logger.${name}(message, context) must not throw`
        );
      }
    });

    it('error() accepts the documented (message, Error) overload', () => {
      const root = getLogger();
      const err = new Error('shorthand');

      assert.doesNotThrow(
        () => root.error('failed', err),
        'Logger.error(message, Error) shorthand overload must not throw'
      );
      assert.doesNotThrow(
        () => root.error('failed', { repo: 'x' }, err),
        'Logger.error(message, context, Error) full form must not throw'
      );
    });

    it('child() declares one positional parameter (the bindings argument)', () => {
      const root = getLogger();
      assert.strictEqual(
        root.child.length,
        1,
        'Logger.child must declare one positional parameter (the bindings argument)'
      );
    });

    it('non-error level methods declare two positional parameters (message, context)', () => {
      const root = getLogger();
      // `Function.length` reports the number of parameters before the
      // first one with a runtime default value or a rest parameter.
      // TypeScript's `context?: Bindings` is purely a type-level
      // annotation; at runtime the method declares two positional
      // parameters with no defaults, so `Function.length` is 2. Pin
      // that so a future signature change (e.g. accidentally
      // collapsing to `(message)` or adding a rest param) is loud.
      const NON_ERROR = ['trace', 'debug', 'info', 'warn'] as const;
      for (const name of NON_ERROR) {
        const method = (root as unknown as Record<string, (...args: unknown[]) => void>)[name];
        assert.strictEqual(
          method.length,
          2,
          `Logger.${name} must declare two positional parameters (got ${method.length})`
        );
      }
    });

    it('error() declares three positional parameters (message, contextOrError, errorArg)', () => {
      const root = getLogger();
      // The `error` overload accepts an optional `Error` as either the
      // second or third positional argument (see `Logger` interface in
      // logger.ts), so the implementation declares three parameters.
      assert.strictEqual(
        root.error.length,
        3,
        `Logger.error must declare three positional parameters (got ${root.error.length})`
      );
    });
  });

  describe('child Logger from Logger.child(bindings)', () => {
    it('returns an object that re-exposes the full method surface', () => {
      const root = getLogger();
      const child = root.child({ component: 'TestComponent' });

      assert.strictEqual(typeof child, 'object', 'child() must return an object');
      assert.notStrictEqual(child, null, 'child() must not return null');

      for (const name of ALL_METHODS) {
        const method = (child as unknown as Record<string, unknown>)[name];
        assert.strictEqual(
          typeof method,
          'function',
          `child().${name} must be a function (got ${typeof method})`
        );
      }
    });

    it('returns a fresh instance distinct from its parent', () => {
      const root = getLogger();
      const child = root.child({ component: 'TestComponent' });

      assert.notStrictEqual(
        child,
        root,
        'child() must return a new Logger, not the parent reference'
      );
    });

    it('supports chained child() calls (each link returns a Logger)', () => {
      const root = getLogger();
      const a = root.child({ component: 'A' });
      const b = a.child({ component: 'B', extra: 1 });

      assert.strictEqual(typeof b.child, 'function', 'chained child().child must be callable');
      assert.notStrictEqual(b, a, 'each child() call returns a fresh Logger');
      assert.notStrictEqual(b, root, 'grandchild differs from root');
    });
  });
});
