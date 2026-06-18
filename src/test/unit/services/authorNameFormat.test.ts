/**
 * Unit tests for the author name-format helper.
 *
 * Mirrors IntelliJ's `ShortNameType.shorten`
 * (platform/vcs-impl/.../actions/ShortNameType.kt): the annotation gutter lets
 * the user pick how an author identity is rendered — full name, first name,
 * last name, initials, or email. This is the pure-function boundary for that
 * choice, unit-tested without the extension host.
 */

import * as assert from 'assert';
import { formatAuthorName } from '../../../blame/authorNameFormat';

describe('formatAuthorName', () => {
  describe('full', () => {
    it('returns the whole name unchanged', () => {
      assert.strictEqual(formatAuthorName('John Smith', 'john@example.com', 'full'), 'John Smith');
    });

    it('collapses runs of internal whitespace', () => {
      assert.strictEqual(formatAuthorName('John   Smith', '', 'full'), 'John Smith');
    });
  });

  describe('firstname', () => {
    it('returns the first whitespace-separated token', () => {
      assert.strictEqual(formatAuthorName('John Smith', '', 'firstname'), 'John');
    });
  });

  describe('lastname', () => {
    it('returns the last whitespace-separated token', () => {
      assert.strictEqual(formatAuthorName('John Smith', '', 'lastname'), 'Smith');
    });

    it('returns the only token for a single-word name', () => {
      assert.strictEqual(formatAuthorName('Cher', '', 'lastname'), 'Cher');
    });

    it('handles three-part names by taking the final token', () => {
      assert.strictEqual(formatAuthorName('Ada B Lovelace', '', 'lastname'), 'Lovelace');
    });
  });

  describe('initials', () => {
    it('joins the uppercased first letter of each token', () => {
      assert.strictEqual(formatAuthorName('john smith', '', 'initials'), 'JS');
    });

    it('produces a single initial for a single-word name', () => {
      assert.strictEqual(formatAuthorName('Madonna', '', 'initials'), 'M');
    });
  });

  describe('email', () => {
    it('returns the supplied email address', () => {
      assert.strictEqual(
        formatAuthorName('John Smith', 'john@example.com', 'email'),
        'john@example.com'
      );
    });

    it('falls back to an email embedded in the name when none is supplied', () => {
      assert.strictEqual(
        formatAuthorName('jane.doe@example.com', undefined, 'email'),
        'jane.doe@example.com'
      );
    });

    it('falls back to the name when no email is available', () => {
      assert.strictEqual(formatAuthorName('John Smith', '', 'email'), 'John Smith');
    });
  });

  describe('degenerate input', () => {
    it('returns empty string for an empty author', () => {
      assert.strictEqual(formatAuthorName('', '', 'full'), '');
    });

    it('returns empty string for a whitespace-only author', () => {
      assert.strictEqual(formatAuthorName('   ', '', 'lastname'), '');
    });
  });
});
