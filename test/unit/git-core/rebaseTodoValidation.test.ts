/**
 * Validation hardening for the rebase-todo transform.
 *
 * The interactive-rebase plan flows webview → host → env → the rebase
 * sequence editor, which writes git's todo file and per-commit message-override
 * files. Two attacker-controllable fields must be constrained before they reach
 * those sinks:
 *   - `action` is emitted verbatim as a todo command (`<action> <hash> …`), so
 *     a forged action such as `exec rm -rf ~` injects an arbitrary exec line.
 *   - `hash` is interpolated into a `.git/<file>` path by
 *     messageOverrideFileName, so a traversal hash (`x/../../../tmp/pwned`)
 *     escapes the git dir and writes attacker content to an arbitrary file —
 *     and that write happens BEFORE the todo transform runs.
 */

import '../../setup';
import * as assert from 'assert';
import {
  isRebaseAction,
  isValidRebaseHash,
  messageOverrideFileName,
  transformRebaseTodo,
  REBASE_ACTIONS,
} from '../../../src/git-core/rebaseTodo';
import { IRebaseAction } from '../../../src/git-core/interfaces/IRebaseService';

describe('rebase-todo validation', () => {
  describe('isRebaseAction', () => {
    it('accepts exactly the six rebase commands', () => {
      for (const a of ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']) {
        assert.ok(isRebaseAction(a), `${a} should be a valid action`);
      }
      assert.deepStrictEqual([...REBASE_ACTIONS].sort(), [
        'drop',
        'edit',
        'fixup',
        'pick',
        'reword',
        'squash',
      ]);
    });

    it('rejects injection payloads and non-actions', () => {
      for (const bad of ['exec rm -rf ~', 'PICK', 'pick\nexec evil', '', 'x', 'label']) {
        assert.ok(!isRebaseAction(bad), `${JSON.stringify(bad)} must be rejected`);
      }
      assert.ok(!isRebaseAction(undefined));
      assert.ok(!isRebaseAction(42));
    });
  });

  describe('isValidRebaseHash', () => {
    it('accepts 4-64 hex characters', () => {
      assert.ok(isValidRebaseHash('aaaa'));
      assert.ok(isValidRebaseHash('deadBEEF'));
      assert.ok(isValidRebaseHash('a'.repeat(40)));
      assert.ok(isValidRebaseHash('a'.repeat(64)));
    });

    it('rejects traversal, separators, and out-of-range lengths', () => {
      for (const bad of [
        'x/../../../tmp/pwned',
        '../etc',
        'abc/def',
        'g1234567',
        'abc',
        'a'.repeat(65),
        '',
      ]) {
        assert.ok(!isValidRebaseHash(bad), `${JSON.stringify(bad)} must be rejected`);
      }
    });
  });

  describe('messageOverrideFileName', () => {
    it('builds a flat .git-relative name for a valid hash', () => {
      assert.strictEqual(messageOverrideFileName('abc123'), '.intellig-reword-abc123.txt');
    });

    it('throws on a path-traversal hash instead of escaping the git dir', () => {
      assert.throws(() => messageOverrideFileName('x/../../../../tmp/pwned'));
      assert.throws(() => messageOverrideFileName('../escape'));
      assert.throws(() => messageOverrideFileName(''));
    });
  });

  describe('transformRebaseTodo', () => {
    const todo = 'pick aaaaaaa First subject\n';

    it('throws on an injected action even when the hash matches a real todo line', () => {
      const plan = [{ hash: 'aaaaaaa', action: 'exec rm -rf ~' }] as unknown as IRebaseAction[];
      assert.throws(() => transformRebaseTodo(todo, plan, '/tmp/gitdir'));
    });

    it('throws on a non-hex (traversal) plan hash', () => {
      const plan = [{ hash: 'x/../../../tmp/pwned', action: 'pick' }] as unknown as IRebaseAction[];
      assert.throws(() => transformRebaseTodo(todo, plan, '/tmp/gitdir'));
    });

    it('still transforms a legitimate plan', () => {
      const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'drop' }];
      const out = transformRebaseTodo(todo, plan, '/tmp/gitdir');
      assert.ok(out.includes('drop aaaaaaa'), `expected drop line, got: ${out}`);
    });
  });

  describe('transformRebaseTodo squash-group message overrides', () => {
    // A squash/fixup run folds into ONE commit, which carries ONE message; a
    // second typed override in the same fold group would silently clobber the
    // first (each override amends the same resulting commit, last write wins).
    const todo = 'pick aaaaaaa A\npick bbbbbbb B\npick ccccccc C\npick ddddddd D\n';

    it('throws when two squash rows in one fold group both carry a typed message', () => {
      const plan: IRebaseAction[] = [
        { hash: 'aaaaaaa', action: 'pick' },
        { hash: 'bbbbbbb', action: 'squash', newMessage: 'first combined' },
        { hash: 'ccccccc', action: 'squash', newMessage: 'second combined' },
        { hash: 'ddddddd', action: 'pick' },
      ];
      assert.throws(() => transformRebaseTodo(todo, plan, '/tmp/gitdir'), /one .*message/i);
    });

    it('throws when the overrides are separated by a fixup in the same group', () => {
      const plan: IRebaseAction[] = [
        { hash: 'aaaaaaa', action: 'pick' },
        { hash: 'bbbbbbb', action: 'squash', newMessage: 'first combined' },
        { hash: 'ccccccc', action: 'fixup' },
        { hash: 'ddddddd', action: 'squash', newMessage: 'second combined' },
      ];
      assert.throws(() => transformRebaseTodo(todo, plan, '/tmp/gitdir'), /one .*message/i);
    });

    it('allows one typed override alongside classic squashes in the same group', () => {
      const plan: IRebaseAction[] = [
        { hash: 'aaaaaaa', action: 'pick' },
        { hash: 'bbbbbbb', action: 'squash', newMessage: 'the combined message' },
        { hash: 'ccccccc', action: 'squash' },
        { hash: 'ddddddd', action: 'pick' },
      ];
      const out = transformRebaseTodo(todo, plan, '/tmp/gitdir');
      assert.ok(out.includes('fixup bbbbbbb'), `expected override fixup line, got: ${out}`);
      assert.ok(out.includes('squash ccccccc'), `expected classic squash line, got: ${out}`);
    });

    it('allows typed overrides in different fold groups', () => {
      const plan: IRebaseAction[] = [
        { hash: 'aaaaaaa', action: 'pick' },
        { hash: 'bbbbbbb', action: 'squash', newMessage: 'first group message' },
        { hash: 'ccccccc', action: 'pick' },
        { hash: 'ddddddd', action: 'squash', newMessage: 'second group message' },
      ];
      const out = transformRebaseTodo(todo, plan, '/tmp/gitdir');
      assert.ok(out.includes('fixup bbbbbbb'));
      assert.ok(out.includes('fixup ddddddd'));
    });
  });
});
