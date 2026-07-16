/**
 * `intellig.showHistory` target resolution — the explicit file-Uri argument
 * (CTW Local-Changes rows pass the clicked row's Uri) must win over the
 * active editor, so Show History opens history for the CLICKED file, not
 * whatever editor happens to be focused.
 */

import '../../setup';
import * as assert from 'assert';
import { resolveShowHistoryTargetFsPath } from '../../../src/commands/registration/commitRepoCoreCommands';
import { Uri } from '../../mocks/vscode';

describe('resolveShowHistoryTargetFsPath', () => {
  it('prefers an explicit file-Uri argument over the active editor', () => {
    const clicked = Uri.file('/repo/src/clicked.ts');
    assert.strictEqual(
      resolveShowHistoryTargetFsPath(clicked, '/repo/src/focused.ts'),
      clicked.fsPath
    );
  });

  it('falls back to the active editor for the bare palette invocation', () => {
    assert.strictEqual(
      resolveShowHistoryTargetFsPath(undefined, '/repo/src/focused.ts'),
      '/repo/src/focused.ts'
    );
  });

  it('treats a non-Uri object argument (e.g. {startRef}) as no target', () => {
    assert.strictEqual(
      resolveShowHistoryTargetFsPath({ startRef: 'abc123' }, '/repo/src/focused.ts'),
      '/repo/src/focused.ts'
    );
  });

  it('returns undefined with no argument and no editor (repo-level history)', () => {
    assert.strictEqual(resolveShowHistoryTargetFsPath(undefined, undefined), undefined);
  });
});
