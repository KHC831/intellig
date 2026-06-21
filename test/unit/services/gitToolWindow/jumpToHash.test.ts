/**
 * Unit tests for the Jump-to-Hash helper.
 *
 * All tests exercise the pure `findCommitByQuery` (and `classifyQuery` /
 * `isHexString`) helpers from
 * `src/services/gitToolWindow/jumpToHash.ts`. These are the heart of the
 * feature; the extension-side command is a thin wrapper that takes user
 * input, calls this helper, and posts a webview message.
 */

import '../../../setup';
import * as assert from 'assert';
import type { IBranch, ICommit, ITag } from '../../../../src/git-core/interfaces/IGitService';
import {
  MIN_SHA_PREFIX_LENGTH,
  classifyQuery,
  findCommitByQuery,
  isHexString,
} from '../../../../src/git-core/gitToolWindow/jumpToHash';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function mkCommit(hash: string, message = 'subject'): ICommit {
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message,
    author: { name: 'Test', email: 't@example.com' },
    committer: { name: 'Test', email: 't@example.com' },
    parents: [],
    authorDate: new Date('2020-01-01'),
    commitDate: new Date('2020-01-01'),
  };
}

function mkBranch(name: string, commit: string, type: 'local' | 'remote' = 'local'): IBranch {
  return { name, type, commit, isHead: false };
}

function mkTag(name: string, commit: string): ITag {
  return { name, commit, isAnnotated: false };
}

const commitA = mkCommit('abc1234567890abcdef1234567890abcdef12345');
const commitB = mkCommit('fedcba0987654321fedcba0987654321fedcba09');
const commitC = mkCommit('abcdef0000000000abcdef0000000000abcdef00');

// ─── isHexString ─────────────────────────────────────────────────────────────

describe('jumpToHash — isHexString', () => {
  it('accepts all-lowercase hex digits', () => {
    assert.strictEqual(isHexString('abc1234'), true);
  });
  it('accepts mixed-case hex digits', () => {
    assert.strictEqual(isHexString('AbC1234'), true);
  });
  it('accepts all-uppercase hex digits', () => {
    assert.strictEqual(isHexString('ABC1234'), true);
  });
  it('rejects non-hex characters', () => {
    assert.strictEqual(isHexString('xyz'), false);
    assert.strictEqual(isHexString('abc/def'), false);
    assert.strictEqual(isHexString('abc 123'), false);
  });
  it('rejects the empty string', () => {
    assert.strictEqual(isHexString(''), false);
  });
});

// ─── findCommitByQuery — SHA prefix ──────────────────────────────────────────

describe('jumpToHash — findCommitByQuery SHA prefix', () => {
  it('matches a 7-char SHA prefix', () => {
    const result = findCommitByQuery('abc1234', [commitA, commitB], [], []);
    assert.strictEqual(result, commitA.hash);
  });

  it(`requires at least ${MIN_SHA_PREFIX_LENGTH} characters`, () => {
    // 3 chars should NOT match even though 'abc' is a prefix of commitA.
    const tooShort = findCommitByQuery('abc', [commitA, commitB], [], []);
    assert.strictEqual(tooShort, undefined);
    // 4 chars should match.
    const exactly4 = findCommitByQuery('abc1', [commitA, commitB], [], []);
    assert.strictEqual(exactly4, commitA.hash);
  });

  it('is case-insensitive', () => {
    const lower = findCommitByQuery('abc1234', [commitA], [], []);
    const upper = findCommitByQuery('ABC1234', [commitA], [], []);
    const mixed = findCommitByQuery('AbC1234', [commitA], [], []);
    assert.strictEqual(lower, commitA.hash);
    assert.strictEqual(upper, commitA.hash);
    assert.strictEqual(mixed, commitA.hash);
  });

  it('returns the first matching commit when multiple commits share a prefix', () => {
    // commitA starts with 'abc1234', commitC starts with 'abcdef00'
    // — query 'abc' isn't long enough (3 chars), so try 'abcdef' which only
    // matches commitC:
    const uniqueMatch = findCommitByQuery('abcdef', [commitA, commitC], [], []);
    assert.strictEqual(uniqueMatch, commitC.hash);

    // Now query something both commits share: 4 chars of prefix 'abc1'
    // matches only A; 'abcd' matches only C. Construct a true multi-match:
    const shared = mkCommit('abcdef1111111111abcdef1111111111abcdef11');
    const result = findCommitByQuery('abcdef', [commitC, shared], [], []);
    assert.strictEqual(result, commitC.hash, 'first commit in list wins on multi-match');
  });
});

// ─── findCommitByQuery — branch name ─────────────────────────────────────────

describe('jumpToHash — findCommitByQuery branch name', () => {
  it('matches an exact branch name and returns the branch commit', () => {
    const branches = [mkBranch('main', commitA.hash), mkBranch('develop', commitB.hash)];
    const result = findCommitByQuery('develop', [], branches, []);
    assert.strictEqual(result, commitB.hash);
  });

  it('matches remote-qualified branch names verbatim', () => {
    const branches = [mkBranch('origin/main', commitA.hash, 'remote')];
    const result = findCommitByQuery('origin/main', [], branches, []);
    assert.strictEqual(result, commitA.hash);
  });

  it('is case-sensitive (branch names in git are case-sensitive)', () => {
    const branches = [mkBranch('main', commitA.hash)];
    const result = findCommitByQuery('MAIN', [], branches, []);
    assert.strictEqual(result, undefined);
  });
});

// ─── findCommitByQuery — tag name ────────────────────────────────────────────

describe('jumpToHash — findCommitByQuery tag name', () => {
  it('matches an exact tag name and returns the tag commit', () => {
    const tags = [mkTag('v1.0.0', commitA.hash), mkTag('v1.1.0', commitB.hash)];
    const result = findCommitByQuery('v1.0.0', [], [], tags);
    assert.strictEqual(result, commitA.hash);
  });
});

// ─── findCommitByQuery — priority and no-match ───────────────────────────────

describe('jumpToHash — findCommitByQuery priority + misses', () => {
  it('prefers SHA match over branch match when query is a valid hex prefix', () => {
    // A branch happens to be named "abc1234" — pathological but possible.
    const branches = [mkBranch('abc1234', commitB.hash)];
    const result = findCommitByQuery('abc1234', [commitA], branches, []);
    // SHA match wins → commitA, not commitB.
    assert.strictEqual(result, commitA.hash);
  });

  it('falls back to branch/tag when query is not a hex string', () => {
    // Non-hex query — skip SHA branch.
    const branches = [mkBranch('feature/xyz', commitA.hash)];
    const result = findCommitByQuery('feature/xyz', [], branches, []);
    assert.strictEqual(result, commitA.hash);
  });

  it('returns undefined when no match anywhere', () => {
    const result = findCommitByQuery('no-such-thing', [commitA], [], []);
    assert.strictEqual(result, undefined);
  });

  it('returns undefined for an empty / whitespace-only query', () => {
    assert.strictEqual(findCommitByQuery('', [commitA], [], []), undefined);
    assert.strictEqual(findCommitByQuery('   ', [commitA], [], []), undefined);
  });

  it('returns undefined when loadedCommits is empty and query is a SHA', () => {
    // Per spec: only operates on currently-loaded commits. No auto-page.
    const result = findCommitByQuery('abc1234', [], [], []);
    assert.strictEqual(result, undefined);
  });

  it('trims surrounding whitespace from the query before matching', () => {
    const result = findCommitByQuery('  abc1234  ', [commitA], [], []);
    assert.strictEqual(result, commitA.hash);
  });
});

// ─── classifyQuery ───────────────────────────────────────────────────────────

describe('jumpToHash — classifyQuery', () => {
  it('returns "sha" for a matching SHA prefix', () => {
    assert.strictEqual(classifyQuery('abc1234', [commitA], [], []), 'sha');
  });

  it('returns "branch" for an exact branch name', () => {
    assert.strictEqual(classifyQuery('main', [], [mkBranch('main', commitA.hash)], []), 'branch');
  });

  it('returns "tag" for an exact tag name', () => {
    assert.strictEqual(classifyQuery('v1', [], [], [mkTag('v1', commitA.hash)]), 'tag');
  });

  it('returns undefined for an unmatched query', () => {
    assert.strictEqual(classifyQuery('mystery', [commitA], [], []), undefined);
  });

  it('returns undefined for empty / whitespace-only query', () => {
    assert.strictEqual(classifyQuery('', [], [], []), undefined);
    assert.strictEqual(classifyQuery('  ', [], [], []), undefined);
  });
});
