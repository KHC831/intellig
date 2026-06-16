/**
 * Match-mode flags for `git log --grep` (G2 parity with IntelliJ VCS-log).
 *
 * IntelliJ's text filter exposes two toggles (TextFilterModel.kt):
 *   - Match case  (default OFF → case-insensitive)
 *   - Use regex   (default OFF → plain text)
 *
 * git's `--grep` is case-sensitive POSIX-basic-regex by default, so:
 *   - case-insensitive (the UI default) ⇒ add `--regexp-ignore-case`
 *   - regex ON                          ⇒ add `-E` (Perl-extended)
 * The flags are only meaningful alongside a `--grep`, so they are gated on it.
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../git-core/ops/GitOpsContext';
import { IRepository } from '../../../git-core/interfaces/IGitService';

function makeOps(): { ops: StashTagHistoryOps; calls: string[][] } {
  const calls: string[][] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StashTagHistoryOps(ctx), calls };
}

const repo = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

describe('StashTagHistoryOps.getLog — match-mode flags (G2)', () => {
  it('adds -E when regex is true and a grep is present', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'fix.*bug', regex: true });
    assert.ok(calls[0].includes('-E'), '-E must be present for regex grep');
  });

  it('omits -E when regex is false', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'literal', regex: false });
    assert.ok(!calls[0].includes('-E'), '-E must be absent for plain grep');
  });

  it('adds --regexp-ignore-case when caseSensitive is false (the UI default)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'token', caseSensitive: false });
    assert.ok(
      calls[0].includes('--regexp-ignore-case'),
      '--regexp-ignore-case must be present for case-insensitive grep'
    );
  });

  it('adds --regexp-ignore-case when caseSensitive is unset (defaults to insensitive)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'token' });
    assert.ok(calls[0].includes('--regexp-ignore-case'));
  });

  it('omits --regexp-ignore-case when caseSensitive is true', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'Token', caseSensitive: true });
    assert.ok(
      !calls[0].includes('--regexp-ignore-case'),
      '--regexp-ignore-case must be absent for case-sensitive grep'
    );
  });

  it('adds no match-mode flags when there is no grep', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { regex: true, caseSensitive: false });
    assert.ok(!calls[0].includes('-E'), '-E must not appear without a grep');
    assert.ok(
      !calls[0].includes('--regexp-ignore-case'),
      '--regexp-ignore-case must not appear without a grep'
    );
  });
});

describe('StashTagHistoryOps.getLog — ref guard (G1)', () => {
  it('passes a valid branch ref as a positional arg', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { ref: 'main', all: false });
    assert.ok(calls[0].includes('main'), 'branch ref must be passed positionally');
    assert.ok(!calls[0].includes('--all'), '--all must be absent when scoped to a ref');
  });

  it('rejects a ref starting with a dash (flag injection)', async () => {
    const { ops } = makeOps();
    await assert.rejects(() => ops.getLog(repo, { ref: '--upload-pack=evil' }), /Invalid ref/);
  });

  it('rejects a ref starting with a dot (invalid refname)', async () => {
    const { ops } = makeOps();
    await assert.rejects(() => ops.getLog(repo, { ref: '.hidden' }), /Invalid ref/);
  });
});
