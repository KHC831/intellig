/**
 * Unit tests for `openRevisionDiff` — the single seam every imperative
 * `vscode.diff` is routed through.
 *
 * Covers:
 *   - happy path forwards left/right URIs + title verbatim to `vscode.diff`.
 *   - failure WITH `failureMessage` → caught here, sanitised toast, no throw.
 *   - failure WITHOUT `failureMessage` → re-thrown (caller owns the fallback).
 *   - the toast string is byte-identical to the legacy
 *     `${prefix}: ${sanitizeGitError(message)}` shape, incl. credential
 *     redaction.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { openRevisionDiff } from '../../../src/git-core/diff/openRevisionDiff';
import { Uri } from '../../mocks/vscode';

interface DiffCall {
  command: string;
  args: unknown[];
}

function stubVscode(opts: { failWith?: Error } = {}): {
  diffCalls: DiffCall[];
  errorToasts: string[];
  restore: () => void;
} {
  const diffCalls: DiffCall[] = [];
  const errorToasts: string[] = [];

  const originalExecute = vscode.commands.executeCommand;
  const originalError = vscode.window.showErrorMessage;

  (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (
    command: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    diffCalls.push({ command, args });
    if (opts.failWith) {
      throw opts.failWith;
    }
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    message: string
  ): Promise<undefined> => {
    errorToasts.push(message);
    return undefined;
  };

  return {
    diffCalls,
    errorToasts,
    restore: () => {
      (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = originalExecute;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = originalError;
    },
  };
}

describe('openRevisionDiff', () => {
  it('forwards left/right URIs and title to vscode.diff', async () => {
    const h = stubVscode();
    try {
      const left = Uri.parse('intellig-git:src/a.ts?HEAD~1');
      const right = Uri.parse('intellig-git:src/a.ts?HEAD');
      await openRevisionDiff({ leftUri: left, rightUri: right, title: 'a.ts (HEAD~1 ↔ HEAD)' });

      assert.strictEqual(h.diffCalls.length, 1);
      assert.strictEqual(h.diffCalls[0].command, 'vscode.diff');
      assert.deepStrictEqual(h.diffCalls[0].args, [left, right, 'a.ts (HEAD~1 ↔ HEAD)']);
      assert.strictEqual(h.errorToasts.length, 0);
    } finally {
      h.restore();
    }
  });

  it('catches a failure and shows a sanitised toast when failureMessage is given', async () => {
    const h = stubVscode({ failWith: new Error('boom at https://user:secret@host/repo.git') });
    try {
      await openRevisionDiff(
        {
          leftUri: Uri.parse('intellig-git:src/a.ts?HEAD'),
          rightUri: Uri.file('/repo/src/a.ts'),
          title: 't',
        },
        'Failed to compare with local'
      );

      assert.strictEqual(h.errorToasts.length, 1);
      assert.ok(h.errorToasts[0].startsWith('Failed to compare with local: '), h.errorToasts[0]);
      assert.ok(!h.errorToasts[0].includes('secret'), `credential leaked: ${h.errorToasts[0]}`);
    } finally {
      h.restore();
    }
  });

  it('re-throws on failure when no failureMessage is given (caller owns fallback)', async () => {
    const err = new Error('kaput');
    const h = stubVscode({ failWith: err });
    try {
      await assert.rejects(
        () =>
          openRevisionDiff({
            leftUri: Uri.parse('intellig-git:src/a.ts?HEAD'),
            rightUri: Uri.file('/repo/src/a.ts'),
            title: 't',
          }),
        /kaput/
      );
      assert.strictEqual(h.errorToasts.length, 0);
    } finally {
      h.restore();
    }
  });

  it('substitutes "Unknown error" for a non-Error throw', async () => {
    const h = stubVscode({ failWith: 'a string' as unknown as Error });
    try {
      await openRevisionDiff(
        {
          leftUri: Uri.parse('intellig-git:src/a.ts?HEAD'),
          rightUri: Uri.file('/repo/src/a.ts'),
          title: 't',
        },
        'Failed to show diff'
      );
      assert.strictEqual(h.errorToasts[0], 'Failed to show diff: Unknown error');
    } finally {
      h.restore();
    }
  });
});
