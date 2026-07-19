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
  buildJumpQuickPickItems,
  resolveJumpAccept,
  verbatimJumpItem,
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

  it('prefix-matches a branch name (jumpToRefOrHash startsWith contract)', () => {
    const branches = [mkBranch('dev/foo', commitA.hash)];
    const result = findCommitByQuery('dev', [], branches, []);
    assert.strictEqual(result, commitA.hash);
  });

  it('prefers the exact name over a longer prefix match', () => {
    const branches = [mkBranch('dev/foo', commitB.hash), mkBranch('dev', commitA.hash)];
    const result = findCommitByQuery('dev', [], branches, []);
    assert.strictEqual(result, commitA.hash, 'exact ref beats a longer prefix match');
  });

  it('prefers a local branch over a remote branch and a tag on the same prefix', () => {
    const result = findCommitByQuery(
      'rel',
      [],
      [mkBranch('release-remote', commitB.hash, 'remote'), mkBranch('release', commitA.hash)],
      [mkTag('rel-tag', commitC.hash)]
    );
    assert.strictEqual(result, commitA.hash, 'local branch wins the ref comparator');
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
  it('prefers a REF match over a SHA match on an all-hex query (jumpToRefOrHash order)', () => {
    // A branch happens to be named "abc1234" — the reference matches refs
    // FIRST and falls back to hash resolution only when no ref matches
    // (VcsLogNavigationUtil.kt jumpToRefOrHash).
    const branches = [mkBranch('abc1234', commitB.hash)];
    const result = findCommitByQuery('abc1234', [commitA], branches, []);
    assert.strictEqual(result, commitB.hash, 'ref resolution precedes hash resolution');
  });

  it('trims shell-quote characters around a hash query (reference trim set)', () => {
    const result = findCommitByQuery('"abc1234"', [commitA], [], []);
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
    // The pure helper matches only the inputs it is given; the COMMAND layer
    // grows the log window and retries on a miss (reference: tryJumpTo
    // retries as data packs load until the pack is full).
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

describe('buildJumpQuickPickItems', () => {
  it('seeds locals, then remotes, then tags (label-order rank)', () => {
    const items = buildJumpQuickPickItems(
      [mkBranch('origin/dev', 'c1', 'remote'), mkBranch('main', 'c2', 'local')],
      [mkTag('v1.0.0', 'c3')]
    );
    assert.deepStrictEqual(
      items.map((i) => i.label),
      ['main', 'origin/dev', 'v1.0.0']
    );
  });

  it('labels each item with its ref kind so the popup reads like a completion list', () => {
    const items = buildJumpQuickPickItems([mkBranch('main', 'c')], [mkTag('v1', 'c')]);
    assert.strictEqual(items[0].description, 'branch');
    assert.strictEqual(items[1].description, 'tag');
  });
});

/**
 * Accepting the Jump-to-Commit picker.
 *
 * A QuickPick keeps a fuzzy-matched item ACTIVE as soon as the typed text
 * loosely matches any ref, so `selectedItems[0]?.label ?? value` silently
 * swapped a typed SHA for that ref's tip — the user asked for one commit and
 * landed on another. A leading verbatim row makes the raw input reachable.
 */
describe('Jump to Commit — accept resolution', () => {
  it('resolves the raw text when the verbatim row is accepted', () => {
    const typed = 'abc1234';

    const resolved = resolveJumpAccept(verbatimJumpItem(typed), typed);

    assert.strictEqual(resolved, typed, 'the typed SHA survives, not a fuzzy-matched ref');
  });

  it('does not hand back the row LABEL, which is prose', () => {
    const item = verbatimJumpItem('deadbeef');

    assert.match(item.label, /deadbeef/, 'the row shows what will be jumped to');
    assert.notStrictEqual(resolveJumpAccept(item, 'deadbeef'), item.label);
  });

  it('resolves a picked ref to its name', () => {
    const resolved = resolveJumpAccept({ label: 'feature/x', description: 'branch' }, 'feat');

    assert.strictEqual(resolved, 'feature/x');
  });

  it('falls back to the typed text when nothing is active', () => {
    assert.strictEqual(resolveJumpAccept(undefined, '  abc1234  '), 'abc1234');
  });

  it('the verbatim row is never filtered out of the list', () => {
    assert.strictEqual(verbatimJumpItem('zzz').alwaysShow, true);
  });
});
