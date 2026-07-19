/**
 * Commit-hash linkification in commit messages.
 *
 * IntelliJ's CommitPresentationUtil scans the message for `[0-9a-f]{7,40}`
 * runs, resolves them against the log, and links only the ones that name a real
 * commit (replaceHashes) — an unresolvable run stays inert text, so a hex-ish
 * word never masquerades as a link.
 */

import '../../../setup';
import * as assert from 'assert';
import { buildMessageTokens } from '../../../../src/git-core/gitToolWindow/provider/detailsPanelModel';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';

/** Exactly 40 hex characters — the upper bound of a full git object name. */
const KNOWN = 'abc1234567890abcdef1234567890abcdef12345';
const KNOWN_SHORT = 'abc1234';

/** Resolver standing in for the loaded log: only the fixture hashes exist. */
const isKnown = (hash: string): boolean => KNOWN.startsWith(hash.toLowerCase()) && hash.length >= 7;

/** Commit tokens produced for `message`. */
function commitTokens(message: string): Array<{ hash: string; text: string }> {
  return buildMessageTokens(message, undefined, isKnown).flatMap((tok) =>
    tok.t === 'commit' ? [{ hash: tok.hash, text: tok.text }] : []
  );
}

describe('commit-hash tokens in commit messages', () => {
  it('links a resolvable short hash so the reader can jump to it', () => {
    assert.deepStrictEqual(commitTokens('Revert ' + KNOWN_SHORT + ' for now'), [
      { hash: KNOWN_SHORT, text: KNOWN_SHORT },
    ]);
  });

  it('links a resolvable full 40-character hash', () => {
    assert.deepStrictEqual(commitTokens('Cherry-picked from ' + KNOWN), [
      { hash: KNOWN, text: KNOWN },
    ]);
  });

  it('leaves a hex run that names no commit as inert text', () => {
    assert.deepStrictEqual(commitTokens('Set background to deadbeef in the theme'), []);
  });

  it('ignores a hex run shorter than seven characters', () => {
    assert.deepStrictEqual(commitTokens('Bumped abc123 times'), [], 'six hex chars is not a hash');
  });

  it('ignores a run longer than forty characters', () => {
    assert.deepStrictEqual(commitTokens('Digest ' + KNOWN + 'abcdef'), [], 'too long to be a hash');
  });

  it('preserves the surrounding text around a linked hash', () => {
    const text = buildMessageTokens('Revert ' + KNOWN_SHORT + ' now', undefined, isKnown)
      .map((tok) => (tok.t === 'text' ? tok.v : tok.t === 'commit' ? tok.text : ''))
      .join('');

    assert.strictEqual(text, 'Revert ' + KNOWN_SHORT + ' now');
  });

  it('links nothing when no resolver is supplied', () => {
    const tokens = buildMessageTokens('Revert ' + KNOWN_SHORT, undefined);

    assert.ok(
      tokens.every((tok) => tok.t !== 'commit'),
      'without a resolver every run is unresolvable'
    );
  });
});

describe('commit-hash resolution against the loaded graph', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  const loadNodes = (hashes: string[]): void => {
    (
      provider as unknown as { _extendedLogState: { commitNodes: unknown[] } }
    )._extendedLogState.commitNodes = hashes.map((hash) => ({
      commit: { hash },
      branches: [],
      tags: [],
    }));
  };

  it('resolves a short prefix of a loaded commit', () => {
    loadNodes(['abc1234567890abcdef1234567890abcdef12345']);

    assert.strictEqual(provider.isKnownCommitHash('abc1234'), true);
  });

  it('does not resolve a hex run that matches no loaded commit', () => {
    loadNodes(['abc1234567890abcdef1234567890abcdef12345']);

    assert.strictEqual(provider.isKnownCommitHash('deadbeef'), false);
  });

  it('resolves case-insensitively, as git object names are', () => {
    loadNodes(['abc1234567890abcdef1234567890abcdef12345']);

    assert.strictEqual(provider.isKnownCommitHash('ABC1234'), true);
  });
});

describe('selecting a commit by an abbreviated hash', () => {
  const FULL = 'abc1234567890abcdef1234567890abcdef12345';
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
    (
      provider as unknown as { _extendedLogState: { commitNodes: unknown[] } }
    )._extendedLogState.commitNodes = [{ commit: { hash: FULL }, branches: [], tags: [] }];
  });

  afterEach(() => {
    provider.dispose();
  });

  const selectedHashes = (): string[] =>
    Array.from(
      (provider as unknown as { _extendedLogState: { selectedCommits: Set<string> } })
        ._extendedLogState.selectedCommits
    );

  it('expands a message hash prefix to the full commit it names', () => {
    (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
      type: 'selectCommit',
      commitHash: 'abc1234',
    });

    assert.deepStrictEqual(
      selectedHashes(),
      [FULL],
      'a 7-character ref must select the whole commit, not the prefix string'
    );
  });

  it('leaves an already-full hash untouched', () => {
    (provider as unknown as { _handleWebviewMessage(m: unknown): void })._handleWebviewMessage({
      type: 'selectCommit',
      commitHash: FULL,
    });

    assert.deepStrictEqual(selectedHashes(), [FULL]);
  });
});
