import * as assert from 'assert';

/**
 * Sample unit test to verify test framework setup.
 */
describe('Sample Unit Tests', () => {
  describe('Basic assertions', () => {
    it('should pass a simple equality test', () => {
      assert.strictEqual(1 + 1, 2);
    });

    it('should pass a string comparison test', () => {
      assert.strictEqual('hello', 'hello');
    });

    it('should pass an array comparison test', () => {
      assert.deepStrictEqual([1, 2, 3], [1, 2, 3]);
    });
  });
});
