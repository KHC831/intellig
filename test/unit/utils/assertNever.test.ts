/**
 * Spec for src/utils/assertNever.ts — the compile-time exhaustiveness guard.
 *
 * Pins: it throws at runtime (the unreachable default arm), embeds the offending
 * value, and — at the type level — only accepts a `never` argument, so a switch
 * that leaves a union variant unhandled fails to compile at the assertNever call.
 */
import * as assert from 'assert';
import { assertNever } from '../../../src/utils/assertNever';

type Shape = { kind: 'a' } | { kind: 'b' };

/** Exhaustively handled switch: the default arm's argument is `never`, compiles. */
function handleExhaustive(s: Shape): string {
  switch (s.kind) {
    case 'a':
      return 'A';
    case 'b':
      return 'B';
    default:
      return assertNever(s);
  }
}

describe('assertNever', () => {
  it('is unreachable for a fully-handled union (compiles, never called)', () => {
    assert.strictEqual(handleExhaustive({ kind: 'a' }), 'A');
    assert.strictEqual(handleExhaustive({ kind: 'b' }), 'B');
  });

  it('throws with the offending value embedded when reached at runtime', () => {
    // A rogue value that slipped past the type system (cast) reaches the arm.
    const rogue = { kind: 'c' } as unknown as never;
    assert.throws(() => assertNever(rogue), /c/);
  });

  it('rejects a non-never argument at compile time', () => {
    // @ts-expect-error a plain string is not `never` — passing it must not compile
    assert.throws(() => assertNever('not-never'));
  });
});
