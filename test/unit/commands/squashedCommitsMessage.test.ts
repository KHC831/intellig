/**
 * Unit tests for the squashed-commits message rules, ported from git4idea's
 * GitSquashedCommitsMessageTest.kt (plugins/git4idea/tests/git4idea/rebase/)
 * so the combination rules match the reference exactly: messages join with a
 * blank-line separator ("\n\n\n"), duplicates collapse, and fixup!/squash!/
 * amend! marker subjects are trimmed only when their target commit is part of
 * the combination.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  combineAutosquashMessages,
  prettySquash,
  squashMessages,
  trimAutosquashSubject,
} from '../../../src/commits/squashedCommitsMessage';

describe('squashedCommitsMessage', () => {
  describe('squashMessages', () => {
    it('joins two messages with the rebase squash separator', () => {
      assert.strictEqual(
        squashMessages('A subject\n\nA body', 'B subject\n\nB body'),
        'A subject\n\nA body\n\n\nB subject\n\nB body'
      );
    });
  });

  describe('trimAutosquashSubject', () => {
    it('drops a squash! subject line and keeps the body', () => {
      assert.strictEqual(trimAutosquashSubject('squash! target\n\nextra body'), 'extra body');
    });

    it('drops fixup! and amend! subjects the same way', () => {
      assert.strictEqual(trimAutosquashSubject('fixup! target\n\nbody'), 'body');
      assert.strictEqual(trimAutosquashSubject('amend! target\n\nbody'), 'body');
    });

    it('returns a non-autosquash message unchanged', () => {
      assert.strictEqual(trimAutosquashSubject('plain subject\n\nbody'), 'plain subject\n\nbody');
    });

    it('trims a bodyless autosquash message to empty', () => {
      assert.strictEqual(trimAutosquashSubject('fixup! target'), '');
    });
  });

  describe('prettySquash (reference cases)', () => {
    it("squashed message doesn't contain duplicates", () => {
      assert.strictEqual(prettySquash(['fix', 'fix', 'fix!!!', 'fix']), 'fix\n\n\nfix!!!');
    });

    it('autosquash subjects are removed', () => {
      const messages = [
        'amend! test commit\n\namend message',
        'squash! test commit\n\nsquash message',
        'fixup! test commit',
        'test commit',
      ];
      assert.strictEqual(
        prettySquash(messages),
        'amend message\n\n\nsquash message\n\n\ntest commit'
      );
    });

    it('autosquash 2 fixup commits', () => {
      assert.strictEqual(prettySquash(['fixup! msg', 'fixup! msg']), 'fixup! msg');
    });

    it('autosquash 2 fixup commits and real commit', () => {
      assert.strictEqual(prettySquash(['fixup! msg', 'fixup! msg', 'msg']), 'msg');
    });

    it('autosquash subjects is not removed if target commit is missing', () => {
      assert.strictEqual(prettySquash(['???', 'fixup! msg']), '???\n\n\nfixup! msg');
    });
  });

  describe('combineAutosquashMessages', () => {
    it('appends the squash! body to the target message', () => {
      assert.strictEqual(
        combineAutosquashMessages('A subject\n\nA body', 'squash! A subject\n\nextra note'),
        'A subject\n\nA body\n\n\nextra note'
      );
    });

    it('returns undefined for a bodyless squash! commit (nothing to add)', () => {
      assert.strictEqual(
        combineAutosquashMessages('A subject\n\nA body', 'squash! A subject'),
        undefined
      );
    });

    it('appends a non-autosquash message whole', () => {
      assert.strictEqual(
        combineAutosquashMessages('A subject', 'a hand-written message'),
        'A subject\n\n\na hand-written message'
      );
    });
  });

  describe('call-site wiring', () => {
    // The rules live in this module; the surfaces must actually route through
    // it. A silent inline reimplementation would drift from the reference.
    const src = (rel: string): string =>
      fs.readFileSync(path.join(process.cwd(), 'src', 'commits', rel), 'utf8');

    it('the squash-commits seed goes through prettySquash', () => {
      assert.ok(
        /prettySquash\(/.test(src('commitSquashActions.ts')),
        'commitSquashActions must build the seed with prettySquash'
      );
    });

    it('the autosquash rebase combine goes through combineAutosquashMessages', () => {
      assert.ok(
        /combineAutosquashMessages\(/.test(src('commitInteractiveRebaseActions.ts')),
        'runAutosquashNow must combine messages with combineAutosquashMessages'
      );
    });
  });
});
