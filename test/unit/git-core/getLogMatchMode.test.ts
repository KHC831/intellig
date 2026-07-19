/**
 * Match-mode flags for `git log --grep` (G2 parity with IntelliJ VCS-log).
 *
 * IntelliJ's text filter exposes two toggles (TextFilterModel.kt):
 *   - Match case  (default OFF → case-insensitive)
 *   - Use regex   (default OFF → plain text)
 *
 * git's `--grep` is case-sensitive POSIX-basic-regex by default, so:
 *   - case-insensitive (the UI default) ⇒ add `--regexp-ignore-case`
 *   - regex ON  ⇒ add `--extended-regexp`
 *   - regex OFF ⇒ add `--fixed-strings` — the search text is LITERAL, exactly
 *     IntelliJ's contract (GitLogProvider.kt appends `--fixed-strings` when the
 *     text filter is not a regex). Without it git treats `foo.bar` as a basic
 *     regex and matches `fooxbar`.
 * `--fixed-strings`/`--extended-regexp` apply to every pattern filter in the
 * same invocation, so the author filter participates: literal in
 * fixed-strings mode (including author-only queries), regex-escaped when the
 * text regex toggle is ON (mirrors IntelliJ's UserNameRegex escaping).
 */

import '../../setup';
import * as assert from 'assert';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

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
  it('adds --extended-regexp when regex is true and a grep is present', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'fix.*bug', regex: true });
    assert.ok(
      calls[0].includes('--extended-regexp'),
      '--extended-regexp must be present for regex grep'
    );
    assert.ok(!calls[0].includes('--fixed-strings'), 'the two modes are exclusive');
  });

  it('adds --fixed-strings when regex is false (literal search, the UI default)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'foo.bar', regex: false });
    assert.ok(
      calls[0].includes('--fixed-strings'),
      'a non-regex search must be literal — without --fixed-strings git treats foo.bar as a basic regex'
    );
    assert.ok(!calls[0].includes('--extended-regexp'), 'the two modes are exclusive');
  });

  it('adds --fixed-strings when regex is unset', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'a[b' });
    assert.ok(
      calls[0].includes('--fixed-strings'),
      'an unbalanced bracket must be searchable literally, not a regex error'
    );
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

  it('adds no match-mode flags when there is no grep and no author', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { regex: true, caseSensitive: false });
    assert.ok(!calls[0].includes('--extended-regexp'));
    assert.ok(!calls[0].includes('--fixed-strings'));
    assert.ok(
      !calls[0].includes('--regexp-ignore-case'),
      '--regexp-ignore-case must not appear without a grep'
    );
  });
});

describe('StashTagHistoryOps.getLog — author filter matching (G2 corollary)', () => {
  it('matches an author literally when there is no regex toggle in play', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { author: 'John (Corp) <j.d@x.com>' });
    assert.ok(
      calls[0].includes('--author=John (Corp) <j.d@x.com>'),
      'the author value must pass through unmodified'
    );
    assert.ok(
      calls[0].includes('--fixed-strings'),
      'author-only filtering must be literal — an unescaped ( is a regex error otherwise'
    );
  });

  it('author-only filtering honors the Match case default (adds --regexp-ignore-case)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { author: 'john' });
    assert.ok(
      calls[0].includes('--regexp-ignore-case'),
      'the Match case toggle governs every pattern filter, author included'
    );
  });

  it('author-only filtering is case-sensitive when Match case is on', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { author: 'john', caseSensitive: true });
    assert.ok(!calls[0].includes('--regexp-ignore-case'));
  });

  it('multiple selected authors produce one --author per value (patterns OR)', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { authors: ['Jane <j@x.com>', 'Bob <b@x.com>'] });
    const authorArgs = calls[0].filter((a) => a.startsWith('--author='));
    assert.deepStrictEqual(authorArgs, ['--author=Jane <j@x.com>', '--author=Bob <b@x.com>']);
    assert.ok(calls[0].includes('--fixed-strings'), 'literal matching without the regex toggle');
  });

  it('regex-escapes every selected author when the text search is in regex mode', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'fix.*', regex: true, authors: ['A (X)', 'B (Y)'] });
    const authorArgs = calls[0].filter((a) => a.startsWith('--author='));
    assert.deepStrictEqual(authorArgs, ['--author=A \\(X\\)', '--author=B \\(Y\\)']);
  });

  it('regex-escapes the author when the text search is in regex mode', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: 'fix.*', regex: true, author: 'John (Corp)' });
    assert.ok(calls[0].includes('--extended-regexp'));
    assert.ok(
      calls[0].includes('--author=John \\(Corp\\)'),
      `author metacharacters must be escaped in regex mode; got ${calls[0].join(' ')}`
    );
  });
});

describe('StashTagHistoryOps.getLogCount — match-mode parity with getLog', () => {
  function makeCountOps(): { ops: StashTagHistoryOps; calls: string[][] } {
    const calls: string[][] = [];
    const gitCli = {
      exec: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: '0\n', stderr: '' };
      },
    };
    const ctx = {
      gitCli,
      invalidateCache: () => undefined,
      fireDidFetch: () => undefined,
    } as unknown as IGitOpsContext;
    return { ops: new StashTagHistoryOps(ctx), calls };
  }

  it('counts a non-regex search literally', async () => {
    const { ops, calls } = makeCountOps();
    await ops.getLogCount(repo, { grep: 'foo.bar', regex: false });
    assert.ok(
      calls[0].includes('--fixed-strings'),
      'the count query must match the log query mode or the pager total lies'
    );
  });

  it('counts a regex search with --extended-regexp and an escaped author', async () => {
    const { ops, calls } = makeCountOps();
    await ops.getLogCount(repo, { grep: 'fix.*', regex: true, author: 'a.b' });
    assert.ok(calls[0].includes('--extended-regexp'));
    assert.ok(calls[0].includes('--author=a\\.b'));
  });

  it('counts an author-only filter literally', async () => {
    const { ops, calls } = makeCountOps();
    await ops.getLogCount(repo, { author: 'John (Corp)' });
    assert.ok(calls[0].includes('--fixed-strings'));
    assert.ok(calls[0].includes('--author=John (Corp)'));
  });
});

describe('StashTagHistoryOps.getLog — ref guard (G1)', () => {
  it('passes a valid branch ref as a positional arg', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { ref: 'main', all: false });
    assert.ok(calls[0].includes('main'), 'branch ref must be passed positionally');
    assert.ok(!calls[0].includes('--all'), '--all must be absent when scoped to a ref');
  });

  it('errs on a ref starting with a dash (flag injection)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { ref: '--upload-pack=evil' });
    assert.ok(result.isErr());
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
  });

  it('errs on a ref starting with a dot (invalid refname)', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { ref: '.hidden' });
    assert.ok(result.isErr());
    assert.match(result._unsafeUnwrapErr().message, /Invalid ref/);
  });
});

describe('StashTagHistoryOps.getLog — hash filter (--no-walk)', () => {
  it('shows exactly the named commits with --no-walk and no ancestry/grep/all', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { hashes: ['1142593', 'deadbee'], all: true, grep: 'ignored' });
    const args = calls[0];
    assert.ok(args.includes('--no-walk'), '--no-walk must be present for a hash filter');
    assert.ok(
      args.includes('1142593') && args.includes('deadbee'),
      'each hash passed positionally'
    );
    assert.ok(!args.includes('--all'), 'a hash filter must not also walk --all');
    assert.ok(
      !args.some((a) => a.startsWith('--grep')),
      'a hash filter must not also grep the message'
    );
  });

  it('errs on a hash that could inject a flag', async () => {
    const { ops } = makeOps();
    const result = await ops.getLog(repo, { hashes: ['--upload-pack=evil'] });
    assert.ok(result.isErr());
    assert.match(result._unsafeUnwrapErr().message, /Invalid hash/);
  });
});

describe('StashTagHistoryOps.getLogCount — hash filter', () => {
  it('counts the named commits with rev-list --no-walk', async () => {
    const calls: string[][] = [];
    const gitCli = {
      exec: async (args: string[]) => {
        calls.push(args);
        return { exitCode: 0, stdout: '2\n', stderr: '' };
      },
    };
    const ctx = {
      gitCli,
      invalidateCache: () => undefined,
      fireDidFetch: () => undefined,
    } as unknown as IGitOpsContext;
    const ops = new StashTagHistoryOps(ctx);
    const result = await ops.getLogCount(repo, { hashes: ['1142593', 'deadbee'], all: true });
    assert.ok(result.isOk());
    assert.strictEqual(result._unsafeUnwrap(), 2);
    const args = calls[0];
    assert.strictEqual(args[0], 'rev-list');
    assert.ok(args.includes('--no-walk'), 'count must also use --no-walk');
    assert.ok(args.includes('--count'));
    assert.ok(args.includes('1142593') && args.includes('deadbee'));
    assert.ok(!args.includes('--all'), 'hash count must not walk --all');
  });
});

describe('StashTagHistoryOps.getLog — filter fields cannot inject a flag (safe argv position)', () => {
  it('threads a dash-leading author as a single =-bound token, not its own flag', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { author: '--output=/tmp/pwn' });
    const args = calls[0];
    assert.ok(
      args.includes('--author=--output=/tmp/pwn'),
      `author must be =-bound into one token; got ${args.join(' ')}`
    );
    assert.ok(
      !args.includes('--output=/tmp/pwn'),
      'the value must not appear as its own argv token'
    );
  });

  it('threads a dash-leading grep (searchText) as a single =-bound token, not its own flag', async () => {
    const { ops, calls } = makeOps();
    await ops.getLog(repo, { grep: '--output=/tmp/pwn' });
    const args = calls[0];
    assert.ok(
      args.includes('--grep=--output=/tmp/pwn'),
      `grep must be =-bound into one token; got ${args.join(' ')}`
    );
    assert.ok(
      !args.includes('--output=/tmp/pwn'),
      'the value must not appear as its own argv token'
    );
  });
});
