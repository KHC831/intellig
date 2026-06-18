/**
 * H1 — inline reword message pre-set via newMessage in transformRebaseTodo.
 *
 * When IRebaseAction.newMessage is provided for a 'reword' entry,
 * transformRebaseTodo emits `pick` + `exec git commit --amend -F ...`
 * so git never pauses for user input.  When newMessage is absent, the
 * classic `reword` command is emitted (git pauses as before).
 */

import '../../setup';
import * as assert from 'assert';
import { transformRebaseTodo } from '../../../git-core/rebaseTodo';
import type { IRebaseAction } from '../../../git-core/interfaces/IRebaseService';

describe('transformRebaseTodo — reword + newMessage (H1)', () => {
  const SINGLE_LINE_TODO = 'pick aaaaaaa first commit\npick bbbbbbb second commit\n';

  it('emits classic reword when newMessage is absent', () => {
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'reword' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];
    const result = transformRebaseTodo(SINGLE_LINE_TODO, plan);
    assert.match(result, /^reword aaaaaaa first commit\n/);
    assert.match(result, /pick bbbbbbb second commit\n$/);
  });

  it('emits pick + exec amend when newMessage is provided', () => {
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'reword', newMessage: 'Updated message' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];
    const result = transformRebaseTodo(SINGLE_LINE_TODO, plan);
    const lines = result.trimEnd().split('\n');
    assert.strictEqual(lines[0], 'pick aaaaaaa first commit');
    assert.match(
      lines[1],
      /^exec git commit --amend -F .*intellig-reword-aaaaaaa.*\.txt --no-edit$/
    );
    assert.strictEqual(lines[2], 'pick bbbbbbb second commit');
  });

  it('exec line keys the message file by the FULL plan hash (collision-safe)', () => {
    const todo = 'pick abc12345def first\n';
    const plan: IRebaseAction[] = [
      { hash: 'abc12345def', action: 'reword', newMessage: 'new msg' },
    ];
    const result = transformRebaseTodo(todo, plan);
    assert.match(result, /intellig-reword-abc12345def\.txt/);
  });

  it('keeps two commits with a shared short prefix on distinct message files', () => {
    // Two hashes sharing their first 8 chars must NOT collide onto one file —
    // a full-hash key keeps the per-commit messages independent.
    const todo = 'pick abc12345aaa first\npick abc12345bbb second\n';
    const plan: IRebaseAction[] = [
      { hash: 'abc12345aaa', action: 'reword', newMessage: 'msg A' },
      { hash: 'abc12345bbb', action: 'reword', newMessage: 'msg B' },
    ];
    const result = transformRebaseTodo(todo, plan);
    assert.match(result, /intellig-reword-abc12345aaa\.txt/);
    assert.match(result, /intellig-reword-abc12345bbb\.txt/);
  });

  it('preserves update-ref trailing lines after a reword+newMessage commit', () => {
    const todo = 'pick aaaaaaa feat\nupdate-ref refs/heads/topic\npick bbbbbbb follow\n';
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'reword', newMessage: 'new subject' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];
    const result = transformRebaseTodo(todo, plan);
    const lines = result.trimEnd().split('\n');
    assert.strictEqual(lines[0], 'pick aaaaaaa feat');
    assert.match(lines[1], /exec git commit --amend/);
    assert.strictEqual(lines[2], 'update-ref refs/heads/topic');
    assert.strictEqual(lines[3], 'pick bbbbbbb follow');
  });

  it('second reword commit also uses exec path with its own hash slice', () => {
    const todo = 'pick aaaaaaa first\npick bbbbbbb second\n';
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'reword', newMessage: 'msg A' },
      { hash: 'bbbbbbb', action: 'reword', newMessage: 'msg B' },
    ];
    const result = transformRebaseTodo(todo, plan);
    assert.match(result, /intellig-reword-aaaaaaa/);
    assert.match(result, /intellig-reword-bbbbbbb/);
  });

  // An empty (or whitespace-only) newMessage must NOT take the exec path:
  // `git commit --amend -F <empty-file>` aborts ("empty commit message"),
  // which would break the rebase mid-flight. Treat it like an absent override
  // and fall back to the classic interactive reword — matching the textarea's
  // own "leave blank to edit interactively" placeholder.
  it('emits classic reword when newMessage is an empty string', () => {
    const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'reword', newMessage: '' }];
    const result = transformRebaseTodo('pick aaaaaaa first commit\n', plan);
    assert.match(result, /^reword aaaaaaa first commit\n/);
    assert.doesNotMatch(result, /exec git commit --amend/);
    assert.doesNotMatch(result, /intellig-reword/);
  });

  it('emits classic reword when newMessage is whitespace only', () => {
    const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'reword', newMessage: '   \n\t ' }];
    const result = transformRebaseTodo('pick aaaaaaa first commit\n', plan);
    assert.match(result, /^reword aaaaaaa first commit\n/);
    assert.doesNotMatch(result, /exec git commit --amend/);
    assert.doesNotMatch(result, /intellig-reword/);
  });
});

// H1 inline squash editing extends the reword-override mechanism to squash.
// git4idea collects the combined message up front (GitRebaseTodoModelConverter
// unites the squash entry into the previous commit and stores
// GitSquashedCommitsMessage.squash(old, entry) on the root as a Reword). Lacking
// a persistent message-step editor, we mirror that end-state non-interactively:
// emit `fixup` for the squashed commit (no pause, drops its own message) then
// `exec git commit --amend -F <file>` to set the user's combined message.
describe('transformRebaseTodo — squash + newMessage (H1)', () => {
  const SQUASH_TODO = 'pick aaaaaaa base commit\npick bbbbbbb to squash\n';

  it('emits classic squash when newMessage is absent', () => {
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'squash' },
    ];
    const result = transformRebaseTodo(SQUASH_TODO, plan);
    assert.match(result, /^pick aaaaaaa base commit\n/);
    assert.match(result, /squash bbbbbbb to squash\n$/);
    assert.doesNotMatch(result, /exec git commit --amend/);
  });

  it('emits fixup + exec amend when a squash newMessage is provided', () => {
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'squash', newMessage: 'Combined message' },
    ];
    const result = transformRebaseTodo(SQUASH_TODO, plan);
    const lines = result.trimEnd().split('\n');
    assert.strictEqual(lines[0], 'pick aaaaaaa base commit');
    assert.strictEqual(lines[1], 'fixup bbbbbbb to squash');
    assert.match(
      lines[2],
      /^exec git commit --amend -F .*intellig-reword-bbbbbbb.*\.txt --no-edit$/
    );
  });

  // A blank combined message must NOT write an empty -F file (it would abort the
  // amend mid-rebase). Fall back to the classic interactive squash, exactly as
  // the reword override guards a blank message.
  it('emits classic squash when the squash newMessage is empty', () => {
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'squash', newMessage: '' },
    ];
    const result = transformRebaseTodo(SQUASH_TODO, plan);
    assert.match(result, /squash bbbbbbb to squash\n$/);
    assert.doesNotMatch(result, /exec git commit --amend/);
    assert.doesNotMatch(result, /fixup bbbbbbb/);
  });

  it('emits classic squash when the squash newMessage is whitespace only', () => {
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'squash', newMessage: '   \n\t ' },
    ];
    const result = transformRebaseTodo(SQUASH_TODO, plan);
    assert.match(result, /squash bbbbbbb to squash\n$/);
    assert.doesNotMatch(result, /exec git commit --amend/);
    assert.doesNotMatch(result, /fixup bbbbbbb/);
  });
});
