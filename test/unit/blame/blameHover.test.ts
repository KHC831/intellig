/**
 * Unit tests for the shared blame-hover builder and its markdown escaper.
 *
 * Both `GutterBlameProvider` and `InlineBlameProvider` render a hover whose
 * body interpolates attacker-controllable commit metadata (author name,
 * author email, commit message — all sourced verbatim from `git blame`).
 * The hovers are `command:`-link bearing, so a trusted MarkdownString that
 * also reflects unescaped attacker text is a markdown-command-injection sink:
 * a crafted commit message `[x](command:some.command?args)` becomes a live,
 * one-click command link.
 *
 * The defenses verified here mirror the safe `LineStatusHoverProvider` pattern:
 *   1. `isTrusted` is scoped to ONLY the two commands the hover actually uses,
 *      so injected `command:` links to any other command are inert.
 *   2. `supportHtml` is never enabled, so raw HTML in metadata can't render.
 *   3. All dynamic metadata is markdown-escaped, so injected link/markup
 *      syntax renders as literal text.
 */

import * as assert from 'assert';
import { buildBlameHover, BLAME_HOVER_COMMANDS } from '../../../src/blame/blameHover';
import { escapeMarkdown } from '../../../src/utils/escapeMarkdown';
import { IBlameLine } from '../../../src/git-core/interfaces/IGitService';

function makeBlameLine(overrides: Partial<IBlameLine> = {}): IBlameLine {
  return {
    line: 1,
    commit: 'abcdef1234567890abcdef1234567890abcdef12',
    author: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    date: new Date('2026-06-21T10:00:00Z'),
    message: 'Initial commit',
    ...overrides,
  };
}

describe('escapeMarkdown', () => {
  it('escapes link and command-injection punctuation so it renders literally', () => {
    const out = escapeMarkdown('[x](command:evil?args)');
    assert.ok(!/\]\(command:/.test(out), `link syntax survived: ${out}`);
    assert.ok(out.includes('\\['), 'opening bracket not escaped');
    assert.ok(out.includes('\\]'), 'closing bracket not escaped');
    assert.ok(out.includes('\\('), 'opening paren not escaped');
    assert.ok(out.includes('\\)'), 'closing paren not escaped');
  });

  it('escapes backticks, asterisks, underscores and backslashes', () => {
    const out = escapeMarkdown('`code` *bold* _em_ a\\b');
    assert.ok(out.includes('\\`'), 'backtick not escaped');
    assert.ok(out.includes('\\*'), 'asterisk not escaped');
    assert.ok(out.includes('\\_'), 'underscore not escaped');
    assert.ok(out.includes('\\\\'), 'backslash not escaped');
  });

  it('escapes angle brackets so HTML/autolinks cannot form', () => {
    const out = escapeMarkdown('<img src=x onerror=alert(1)>');
    assert.ok(out.includes('\\<'), 'open angle not escaped');
    assert.ok(out.includes('\\>'), 'close angle not escaped');
  });

  it('leaves ordinary text untouched', () => {
    assert.strictEqual(escapeMarkdown('Ada Lovelace'), 'Ada Lovelace');
  });
});

describe('buildBlameHover', () => {
  it('scopes isTrusted to only the two hover commands (not boolean true)', () => {
    const md = buildBlameHover(makeBlameLine(), {});
    assert.notStrictEqual(md.isTrusted, true, 'isTrusted must not be blanket-true');
    assert.deepStrictEqual(
      md.isTrusted,
      { enabledCommands: BLAME_HOVER_COMMANDS },
      'isTrusted must enable exactly the show-commit + copy-hash commands'
    );
    assert.deepStrictEqual(
      [...BLAME_HOVER_COMMANDS].sort(),
      ['intellig.editor.copyCommitHash', 'intellig.editor.showCommit'],
      'hover must only ever enable these two commands'
    );
  });

  it('never enables supportHtml', () => {
    const md = buildBlameHover(makeBlameLine(), {});
    assert.strictEqual(md.supportHtml, false);
  });

  it('escapes a malicious author so it cannot form a command link', () => {
    const md = buildBlameHover(
      makeBlameLine({ author: '[pwn](command:workbench.action.terminal.new)' }),
      {}
    );
    assert.ok(
      !/\]\(command:workbench/.test(md.value),
      `injected author command link survived: ${md.value}`
    );
  });

  it('escapes a malicious commit message so it cannot form a command link', () => {
    const md = buildBlameHover(
      makeBlameLine({ message: 'fix [click](command:workbench.action.terminal.new) me' }),
      {}
    );
    assert.ok(
      !/\]\(command:workbench/.test(md.value),
      `injected message command link survived: ${md.value}`
    );
  });

  it('escapes a malicious author email', () => {
    const md = buildBlameHover(
      makeBlameLine({ authorEmail: 'a@b)](command:workbench.action.terminal.new)(' }),
      {}
    );
    assert.ok(
      !/\]\(command:workbench/.test(md.value),
      `injected email command link survived: ${md.value}`
    );
  });

  it('still renders the two real action links for legitimate commits', () => {
    const md = buildBlameHover(makeBlameLine(), {});
    assert.ok(md.value.includes('command:intellig.editor.showCommit'), 'show-commit link missing');
    assert.ok(
      md.value.includes('command:intellig.editor.copyCommitHash'),
      'copy-hash link missing'
    );
  });

  it('encodes the command argument as a JSON array VS Code can spread into the handler', () => {
    const md = buildBlameHover(makeBlameLine(), {});
    // Match the pattern at LineStatusHoverProvider: `command:<id>?<encoded>`
    // where decodeURIComponent(<encoded>) is a JSON ARRAY of positional args.
    // A bare (non-array) payload diverges from the proven-working hover links.
    const match = md.value.match(/command:intellig\.editor\.showCommit\?([^)\s|]+)/);
    assert.ok(match, `show-commit link not found in: ${md.value}`);
    const decoded: unknown = JSON.parse(decodeURIComponent(match[1]));
    assert.ok(Array.isArray(decoded), `command arg must be an array, got: ${match[1]}`);
    assert.deepStrictEqual(decoded, ['abcdef1234567890abcdef1234567890abcdef12']);
  });

  it('renders the previous-revision link when requested and available', () => {
    const md = buildBlameHover(
      makeBlameLine({ previousCommit: 'fedcba0987654321fedcba0987654321fedcba09' }),
      { showPreviousRevision: true }
    );
    assert.ok(md.value.includes('Previous Revision'), 'previous-revision link missing');
  });

  it('links the short hash to the provider URL when one is supplied', () => {
    const md = buildBlameHover(makeBlameLine(), {
      providerLink: 'https://example.com/commit/abc',
      showOpenOnHost: true,
    });
    assert.ok(md.value.includes('https://example.com/commit/abc'), 'provider link missing');
    assert.ok(md.value.includes('Open on Host'), 'open-on-host link missing');
  });

  it('drops a providerLink with link-breaking chars (markdown injection into the trusted hover)', () => {
    const evil = 'https://h/r)](command:workbench.action.terminal.new)';
    const md = buildBlameHover(makeBlameLine(), { providerLink: evil, showOpenOnHost: true });
    assert.ok(
      !/\]\(command:workbench/.test(md.value),
      `injected provider command link survived: ${md.value}`
    );
    assert.ok(!md.value.includes(evil), 'the raw malicious providerLink must not be interpolated');
  });

  it('drops a non-http providerLink (e.g. javascript:)', () => {
    const md = buildBlameHover(makeBlameLine(), {
      providerLink: 'javascript:alert(1)',
      showOpenOnHost: true,
    });
    assert.ok(!md.value.includes('javascript:'), 'a non-http(s) providerLink must be dropped');
  });
});
