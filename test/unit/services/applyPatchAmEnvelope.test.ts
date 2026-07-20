/**
 * `git am` needs a mailbox envelope; `git apply --3way --check` does not.
 *
 * The preview runs the apply strategy even when the user picked "Use git am",
 * so a plain unified diff previews all-green and then fails the real run with
 * "Patch format detection failed." (exit 128). These pin the gate that keeps
 * the two verdicts honest: the form refuses before the fact, and the service
 * refuses rather than spawning an `am` that cannot succeed.
 */
import * as assert from 'assert';
import { applyBlockedReason } from '../../../src/patches/applyPatchValidation';
import { extractMailboxPreamble } from '../../../src/patches/PatchService';

const PLAIN_DIFF =
  'diff --git a/plain.txt b/plain.txt\n' +
  'index 7898192..6178079 100644\n' +
  '--- a/plain.txt\n' +
  '+++ b/plain.txt\n' +
  '@@ -1 +1 @@\n' +
  '-d\n' +
  '+d2\n';

describe('applyBlockedReason — git am needs an envelope', () => {
  const base = { useClipboard: false, patchPath: '/tmp/x.patch', stripLevel: 1 };

  it('blocks Apply when git am is selected and the patch carries no envelope', () => {
    const reason = applyBlockedReason({ ...base, useAm: true, hasMailboxEnvelope: false });
    assert.ok(reason, 'a plain diff cannot be applied through git am');
    assert.match(reason, /mailbox|envelope|git am/i);
  });

  it('allows Apply when git am is selected and the patch carries an envelope', () => {
    assert.strictEqual(
      applyBlockedReason({ ...base, useAm: true, hasMailboxEnvelope: true }),
      undefined
    );
  });

  it('does not block a plain-diff patch on the git apply path', () => {
    assert.strictEqual(
      applyBlockedReason({ ...base, useAm: false, hasMailboxEnvelope: false }),
      undefined
    );
  });

  it('stays silent while the envelope fact is still unknown', () => {
    assert.strictEqual(applyBlockedReason({ ...base, useAm: true }), undefined);
  });

  it('still reports the pre-existing blockers first', () => {
    const reason = applyBlockedReason({
      useClipboard: false,
      stripLevel: 1,
      useAm: true,
      hasMailboxEnvelope: false,
    });
    assert.match(reason ?? '', /Choose a patch file/);
  });
});

describe('extractMailboxPreamble — what the gate reads', () => {
  it('reports no envelope for a plain unified diff', () => {
    assert.strictEqual(extractMailboxPreamble(PLAIN_DIFF), undefined);
  });

  it('reports an envelope for format-patch output', () => {
    const mbox =
      'From 1234567890123456789012345678901234567890 Mon Sep 17 00:00:00 2001\n' +
      'From: A <a@b.c>\n' +
      'Subject: [PATCH] x\n\n' +
      PLAIN_DIFF;
    assert.notStrictEqual(extractMailboxPreamble(mbox), undefined);
  });
});
