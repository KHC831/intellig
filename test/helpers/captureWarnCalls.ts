import { getLogger } from '../../src/utils/logger';

/** Reaches LoggerImpl's private `_component` field — see docs/testing.md
 * section 3, the TestSurface idiom for reaching private members. */
interface LoggerComponentTestSurface {
  _component: string;
}

/**
 * Every LoggerImpl instance shares one prototype (`getLogger().child(...)`
 * constructs a fresh instance per call), so patching `warn` on the prototype
 * of ANY instance intercepts every call. Sinks are unregistered in a
 * unit-test process (`initLogger` never runs), so this is the only seam that
 * observes an emission without a production-only test export.
 *
 * `component` is read off `this` inside the patched method: the calling
 * instance is whatever `getLogger().child({ component })` produced, so this
 * pins which component a warn was emitted under without a second seam — a
 * function under test that logs through two different `.child(...)` calls
 * (or a caller that renames one) cannot drift silently.
 */
export function captureWarnCalls(): {
  calls: Array<{ message: string; context: unknown; component: string }>;
  restore: () => void;
} {
  const probe = getLogger().child({ component: 'probe-for-test' });
  const proto = Object.getPrototypeOf(probe) as {
    warn: (message: string, context?: unknown) => void;
  };
  const original = proto.warn;
  const calls: Array<{ message: string; context: unknown; component: string }> = [];
  proto.warn = function (
    this: LoggerComponentTestSurface,
    message: string,
    context?: unknown
  ): void {
    calls.push({ message, context, component: this._component });
  };
  return {
    calls,
    restore: () => {
      proto.warn = original;
    },
  };
}
