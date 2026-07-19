/**
 * The mailbox-envelope notion PatchService splits and subsets mailboxes with.
 *
 * `isMailboxEnvelopeLine` ports git's `is_from_line()` (builtin/mailsplit.c);
 * the cases below are the ones `git mailsplit` itself accepts and rejects.
 * The final suite is the structural fence: the preamble probe and the
 * per-commit boundary split must agree on every candidate, because a boundary
 * notion narrower than the preamble notion silently stops splitting a mailbox
 * and attaches one commit's message to another commit's changes.
 */

import '../../setup';
import * as assert from 'assert';
import {
  extractMailboxPreamble,
  isMailboxEnvelopeLine,
  splitMailboxByCommit,
} from '../../../src/patches/PatchService';

/** Envelope lines `git mailsplit` treats as opening a message. */
const ENVELOPES = [
  'From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001',
  `From ${'2'.repeat(64)} Mon Sep 17 00:00:00 2001`,
  'From mboxrd@z Thu Jan  1 00:00:00 1970',
  'From someone@example.com Mon Sep 17 00:00:00 2001',
  'From 2222 Mon Sep 17 00:00:00 2001',
];

/** Lines that merely start with `From ` — body prose, not envelopes. */
const NON_ENVELOPES = [
  'From foo bar',
  'From the beginning of time we knew',
  'From: not-an-envelope <x@y.z>',
  // Year 90 or below is rejected by git's own check.
  'From x Mon Sep 17 00:00:00 0089',
  'diff --git a/x b/x',
  '',
];

const DIFF = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';

/** A one-commit mailbox opening with `line`. */
function mailbox(line: string): string {
  return `${line}\nFrom: A <a@b.c>\nSubject: [PATCH] s\n\nbody\n\n${DIFF}`;
}

describe('isMailboxEnvelopeLine', () => {
  for (const line of ENVELOPES) {
    it(`accepts ${JSON.stringify(line)}`, () => {
      assert.strictEqual(isMailboxEnvelopeLine(line), true);
    });
  }
  for (const line of NON_ENVELOPES) {
    it(`rejects ${JSON.stringify(line)}`, () => {
      assert.strictEqual(isMailboxEnvelopeLine(line), false);
    });
  }
});

describe('splitMailboxByCommit', () => {
  it('splits on every envelope form, not just 40-hex object names', () => {
    for (const line of ENVELOPES) {
      const two = mailbox(line) + mailbox(line);
      const sections = splitMailboxByCommit(two);
      assert.strictEqual(sections?.length, 2, `two sections for ${line}`);
    }
  });

  it('does not split on a "From " line inside a commit message body', () => {
    const withBody = `${ENVELOPES[0]}\nFrom: A <a@b.c>\nSubject: [PATCH] s\n\nFrom foo bar\n\n${DIFF}`;
    const sections = splitMailboxByCommit(withBody);
    assert.strictEqual(sections?.length, 1);
    assert.strictEqual(sections?.[0], withBody, 'the section is the whole mailbox, verbatim');
  });

  it('returns undefined for a plain unified diff', () => {
    assert.strictEqual(splitMailboxByCommit(DIFF), undefined);
  });

  it('sections concatenate back to the input', () => {
    const three = ENVELOPES.slice(0, 3).map(mailbox).join('');
    assert.strictEqual(splitMailboxByCommit(three)?.join(''), three);
  });
});

describe('mailbox envelope seams agree (structural fence)', () => {
  /**
   * `extractMailboxPreamble` decides whether a section carries an envelope
   * worth preserving; `splitMailboxByCommit` decides where sections begin.
   * Both must read one notion of "envelope" — when the boundary side is the
   * narrower of the two, a mailbox it fails to split gets subsetted as a
   * single section and the first commit's envelope is stamped onto every
   * kept block.
   */
  for (const line of [...ENVELOPES, ...NON_ENVELOPES]) {
    it(`both seams agree on ${JSON.stringify(line)}`, () => {
      const single = mailbox(line);
      const splitsHere = splitMailboxByCommit(single) !== undefined;
      const hasPreamble = extractMailboxPreamble(single) !== undefined;
      assert.strictEqual(
        splitsHere,
        hasPreamble,
        'the boundary split and the preamble probe must classify a line identically'
      );
      assert.strictEqual(splitsHere, isMailboxEnvelopeLine(line), 'both derive from the predicate');
    });
  }
});
