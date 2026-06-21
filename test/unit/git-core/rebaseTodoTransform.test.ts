/**
 * P1 #4 — preserve structural rebase-todo lines (IntelliJ git4idea parity).
 *
 * git4idea (`GitInteractiveRebaseFile.load/save` + `GitRebaseEntry.kt`) parses
 * git's REAL todo: commit lines (pick/reword/edit/squash/fixup/drop) are
 * editable, every other command (`label`, `reset`, `merge`, `exec`,
 * `update-ref`, `noop`) is an `Action.Other` preserved verbatim; comment and
 * blank lines are dropped on save. Our old `generateTodoContent` rebuilt the
 * todo from the commit list alone, silently dropping all structural lines —
 * which corrupts `rebase.updateRefs` and `--rebase-merges` rebases.
 *
 * `transformRebaseTodo` transforms git's actual todo in place: it remaps and
 * reorders the commit lines per the plan while carrying every structural
 * command line through unchanged.
 */

import '../../setup';
import * as assert from 'assert';
import { transformRebaseTodo } from '../../../src/git-core/rebaseTodo';
import type { IRebaseAction } from '../../../src/git-core/interfaces/IRebaseService';

describe('transformRebaseTodo (#4 preserve structural todo lines)', () => {
  it('remaps actions in place and drops git’s comment/help block', () => {
    const original = [
      'pick aaaaaaa first commit',
      'pick bbbbbbb second commit',
      '',
      '# Rebase abc..def onto abc',
      '# Commands:',
      '#  p, pick = use commit',
    ].join('\n');

    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'reword', newMessage: 'reworded second' },
    ];

    const out = transformRebaseTodo(original, plan);
    assert.strictEqual(
      out,
      [
        'pick aaaaaaa first commit',
        'pick bbbbbbb second commit',
        'exec git commit --amend -F .git/.intellig-reword-bbbbbbb.txt --no-edit',
      ].join('\n') + '\n'
    );
  });

  it('preserves an update-ref line trailing its commit (rebase.updateRefs)', () => {
    const original = [
      'pick aaaaaaa first commit',
      'update-ref refs/heads/feature-a',
      'pick bbbbbbb second commit',
    ].join('\n');

    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];

    const out = transformRebaseTodo(original, plan);
    assert.strictEqual(
      out,
      [
        'pick aaaaaaa first commit',
        'update-ref refs/heads/feature-a',
        'pick bbbbbbb second commit',
      ].join('\n') + '\n'
    );
  });

  it('carries a commit’s trailing structural lines with it when reordered', () => {
    const original = [
      'pick aaaaaaa first commit',
      'update-ref refs/heads/feature-a',
      'pick bbbbbbb second commit',
    ].join('\n');

    // User reorders: second commit before first.
    const plan: IRebaseAction[] = [
      { hash: 'bbbbbbb', action: 'pick' },
      { hash: 'aaaaaaa', action: 'pick' },
    ];

    const out = transformRebaseTodo(original, plan);
    assert.strictEqual(
      out,
      [
        'pick bbbbbbb second commit',
        'pick aaaaaaa first commit',
        'update-ref refs/heads/feature-a',
      ].join('\n') + '\n'
    );
  });

  it('preserves label/reset/merge lines from a --rebase-merges todo', () => {
    const original = [
      'label onto',
      'reset onto',
      'pick aaaaaaa feature work',
      'label feature',
      'reset onto',
      'pick bbbbbbb main work',
      'merge -C ccccccc feature # Merge feature',
    ].join('\n');

    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'edit' },
    ];

    const out = transformRebaseTodo(original, plan);
    assert.strictEqual(
      out,
      [
        'label onto',
        'reset onto',
        'pick aaaaaaa feature work',
        'label feature',
        'reset onto',
        'edit bbbbbbb main work',
        'merge -C ccccccc feature # Merge feature',
      ].join('\n') + '\n'
    );
  });

  it('emits a drop line and keeps the dropped commit’s trailing update-ref', () => {
    const original = [
      'pick aaaaaaa keep this',
      'pick bbbbbbb remove this',
      'update-ref refs/heads/topic',
    ].join('\n');

    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'drop' },
    ];

    const out = transformRebaseTodo(original, plan);
    assert.strictEqual(
      out,
      ['pick aaaaaaa keep this', 'drop bbbbbbb remove this', 'update-ref refs/heads/topic'].join(
        '\n'
      ) + '\n'
    );
  });

  it('preserves an exec line that trails its commit', () => {
    const original = ['pick aaaaaaa first', 'exec make test', 'pick bbbbbbb second'].join('\n');

    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];

    assert.strictEqual(
      transformRebaseTodo(original, plan),
      ['pick aaaaaaa first', 'exec make test', 'pick bbbbbbb second'].join('\n') + '\n'
    );
  });

  it('matches commits by abbreviated-hash prefix (plan hash may be longer/shorter)', () => {
    const original = ['pick aaaaaaa1234 first commit'].join('\n');
    // Plan carries the short hash git showed our UI.
    const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'reword', newMessage: 'x' }];

    assert.strictEqual(
      transformRebaseTodo(original, plan),
      [
        'pick aaaaaaa1234 first commit',
        'exec git commit --amend -F .git/.intellig-reword-aaaaaaa.txt --no-edit',
      ].join('\n') + '\n'
    );
  });

  it('throws if the plan references a hash absent from git’s todo', () => {
    const original = 'pick aaaaaaa only commit';
    const plan: IRebaseAction[] = [{ hash: 'deadbee', action: 'pick' }];
    assert.throws(() => transformRebaseTodo(original, plan), /deadbee/);
  });

  it('throws a clear error when the first plan entry is a squash', () => {
    const original = ['pick aaaaaaa first', 'pick bbbbbbb second'].join('\n');
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'squash' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];
    assert.throws(
      () => transformRebaseTodo(original, plan),
      /Cannot squash the first commit in the plan/
    );
  });

  it('throws a clear error when the first plan entry is a fixup', () => {
    const original = ['pick aaaaaaa first', 'pick bbbbbbb second'].join('\n');
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'fixup' },
      { hash: 'bbbbbbb', action: 'pick' },
    ];
    assert.throws(
      () => transformRebaseTodo(original, plan),
      /Cannot fixup the first commit in the plan/
    );
  });

  it('preserves a leading structural line before the first commit', () => {
    const original = ['label base', 'pick aaaaaaa only'].join('\n');
    const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'pick' }];
    assert.strictEqual(
      transformRebaseTodo(original, plan),
      ['label base', 'pick aaaaaaa only'].join('\n') + '\n'
    );
  });

  // Real `git-rebase-todo` captured verbatim from git 2.50 with
  // `rebase -i --rebase-merges --root` and `rebase.updateRefs=true` (see
  // PROGRESS.md #4). Exercises the exact grammar git emits: a `label onto` /
  // blank / `reset [new root]` preamble, `# <oneline>` comment-style subjects,
  // an `update-ref` mid-list, and git's trailing help block — none of which
  // the synthetic fixtures above cover together.
  it('round-trips a real git 2.50 --rebase-merges + updateRefs todo, keeping every structural line', () => {
    const original = [
      'label onto',
      '',
      'reset [new root]',
      'pick 286e1ac # first',
      'pick 543fbab # second',
      'update-ref refs/heads/feature-a',
      '',
      'pick 3638bc5 # third',
      'pick ef6f5f3 # fourth',
      '',
      '# Rebase ef6f5f3 onto 9d43a9c (7 commands)',
      '#',
      '# Commands:',
      '# p, pick <commit> = use commit',
    ].join('\n');

    // User edits: drop "second", reword "fourth". Order otherwise unchanged.
    const plan: IRebaseAction[] = [
      { hash: '286e1ac', action: 'pick' },
      { hash: '543fbab', action: 'drop' },
      { hash: '3638bc5', action: 'pick' },
      { hash: 'ef6f5f3', action: 'reword', newMessage: 'fourth, reworded' },
    ];

    const out = transformRebaseTodo(original, plan);
    assert.strictEqual(
      out,
      [
        // Preamble preserved (blank line dropped — git regenerates it).
        'label onto',
        'reset [new root]',
        'pick 286e1ac # first',
        'drop 543fbab # second',
        // update-ref stayed anchored to its commit (the dropped "second").
        'update-ref refs/heads/feature-a',
        'pick 3638bc5 # third',
        // newMessage provided: emit pick then exec amend (no git pause).
        'pick ef6f5f3 # fourth',
        'exec git commit --amend -F .git/.intellig-reword-ef6f5f3.txt --no-edit',
      ].join('\n') + '\n'
    );
  });
});
