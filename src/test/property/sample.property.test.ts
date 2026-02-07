import * as fc from 'fast-check';
import * as assert from 'assert';

/**
 * Sample property-based tests to verify fast-check setup.
 * Feature: intellij-git-vscode
 */
describe('Sample Property Tests', () => {
  describe('Array operations', () => {
    it('Property: Array reverse is involutory (reversing twice returns original)', () => {
      fc.assert(
        fc.property(fc.array(fc.integer()), (arr) => {
          const reversed = [...arr].reverse();
          const doubleReversed = [...reversed].reverse();
          assert.deepStrictEqual(doubleReversed, arr);
        }),
        { numRuns: 100 }
      );
    });

    it('Property: Array length is preserved after map operation', () => {
      fc.assert(
        fc.property(fc.array(fc.integer()), (arr) => {
          const mapped = arr.map((x) => x * 2);
          assert.strictEqual(mapped.length, arr.length);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('String operations', () => {
    it('Property: String concatenation length equals sum of lengths', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (a, b) => {
          assert.strictEqual((a + b).length, a.length + b.length);
        }),
        { numRuns: 100 }
      );
    });
  });
});
