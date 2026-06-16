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

  it('exec line uses first 8 chars of the plan hash in the filename', () => {
    const todo = 'pick abc12345def first\n';
    const plan: IRebaseAction[] = [
      { hash: 'abc12345def', action: 'reword', newMessage: 'new msg' },
    ];
    const result = transformRebaseTodo(todo, plan);
    assert.match(result, /intellig-reword-abc12345/);
    assert.doesNotMatch(result, /intellig-reword-abc12345def/);
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
});
