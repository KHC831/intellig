import '../../setup';
import * as assert from 'assert';
import { buildSquashRebasePlan } from '../../../src/commits/squashPlan';
import type { IRebaseCommit } from '../../../src/git-core/interfaces/IRebaseService';

describe('buildSquashRebasePlan', () => {
  const session: IRebaseCommit[] = [
    { hash: 'aaaa', message: 'A', action: 'pick' },
    { hash: 'bbbb', message: 'B', action: 'pick' },
    { hash: 'cccc', message: 'C', action: 'pick' },
  ];

  it('rewords the oldest selected commit with the combined message (squash)', () => {
    const plan = buildSquashRebasePlan(
      session,
      new Set(['bbbb', 'cccc']),
      'bbbb',
      'my combined message'
    );
    const byHash = new Map(plan.map((p) => [p.hash, p]));
    assert.strictEqual(byHash.get('bbbb')?.action, 'reword');
    assert.strictEqual(byHash.get('bbbb')?.newMessage, 'my combined message');
  });

  it('fixups every selected commit that is not the target (squash)', () => {
    const plan = buildSquashRebasePlan(session, new Set(['bbbb', 'cccc']), 'bbbb', 'msg');
    const byHash = new Map(plan.map((p) => [p.hash, p]));
    assert.strictEqual(byHash.get('cccc')?.action, 'fixup');
    assert.strictEqual(byHash.get('cccc')?.newMessage, undefined);
  });

  it('leaves non-selected commits untouched (keeps their action)', () => {
    const plan = buildSquashRebasePlan(session, new Set(['bbbb', 'cccc']), 'bbbb', 'msg');
    const byHash = new Map(plan.map((p) => [p.hash, p]));
    assert.strictEqual(byHash.get('aaaa')?.action, 'pick');
    assert.strictEqual(byHash.get('aaaa')?.newMessage, undefined);
  });

  it('keeps the target as pick when no combined message is given (fixup)', () => {
    // Fixup omits the combined message entirely — the target keeps its own.
    const plan = buildSquashRebasePlan(session, new Set(['bbbb', 'cccc']), 'bbbb');
    const byHash = new Map(plan.map((p) => [p.hash, p]));
    assert.strictEqual(byHash.get('bbbb')?.action, 'pick', 'fixup target reuses its own message');
    assert.strictEqual(byHash.get('bbbb')?.newMessage, undefined);
    assert.strictEqual(byHash.get('cccc')?.action, 'fixup');
  });

  it('never emits a classic squash action (squash would not pause under GIT_EDITOR=true)', () => {
    const plan = buildSquashRebasePlan(session, new Set(['bbbb', 'cccc']), 'bbbb', 'msg');
    assert.ok(
      plan.every((p) => p.action !== 'squash'),
      'the plan must deliver the message via a reword override, never a classic squash'
    );
  });
});
