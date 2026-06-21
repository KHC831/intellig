/**
 * Unit tests asserting the `package.json` schema for the two new
 * logging configuration settings introduced by the structured-Logger
 * refactor:
 *
 *   - `intellig.log.level`   — string enum, default `"info"`
 *   - `intellig.log.console` — boolean, default `false`
 *
 * These are pure static checks — no VS Code host required. They pin
 * the schema shape so a future edit to `contributes.configuration`
 * cannot silently drop, rename, or weaken either key.
 *
 *
 * Style mirrors `test/unit/packageJson/coherence.test.ts`: each
 * `it(...)` makes assertions with descriptive failure messages so a
 * regression surfaces with a useful diff at PR time.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Loose shapes — parse defensively so the test keeps working when
// unrelated keys are added to `contributes.configuration`.
// ---------------------------------------------------------------------------

interface ConfigurationProperty {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
}

interface PackageJson {
  contributes?: {
    configuration?: {
      title?: string;
      properties?: Record<string, ConfigurationProperty>;
    };
  };
}

function loadPackageJson(): PackageJson {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  return JSON.parse(raw) as PackageJson;
}

// The exact enum the Logger admits as a configured threshold.
// Mirrors `LogThreshold` from `src/utils/logger/levels.ts`.
const EXPECTED_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'off'] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('package.json — intellig.log.* configuration schema', () => {
  let properties: Record<string, ConfigurationProperty>;

  before(() => {
    const pkg = loadPackageJson();
    properties = pkg.contributes?.configuration?.properties ?? {};
  });

  // -------------------------------------------------------------------------
  // intellig.log.level
  // -------------------------------------------------------------------------

  describe('intellig.log.level', () => {
    it('is declared under contributes.configuration.properties', () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, 'intellig.log.level'),
        "expected 'intellig.log.level' to be declared in package.json " +
          'contributes.configuration.properties'
      );
    });

    it('has type "string"', () => {
      const prop = properties['intellig.log.level'];
      assert.strictEqual(
        prop.type,
        'string',
        `expected intellig.log.level type to be 'string', got ${JSON.stringify(prop.type)}`
      );
    });

    it('declares the six-value enum trace/debug/info/warn/error/off', () => {
      const prop = properties['intellig.log.level'];
      assert.ok(Array.isArray(prop.enum), 'expected intellig.log.level to declare an enum array');
      assert.deepStrictEqual(
        prop.enum,
        [...EXPECTED_LOG_LEVELS],
        'expected intellig.log.level enum to be the exact six-value list ' +
          `[${EXPECTED_LOG_LEVELS.join(', ')}] in that order`
      );
    });

    it('has default "info"', () => {
      const prop = properties['intellig.log.level'];
      assert.strictEqual(
        prop.default,
        'info',
        `expected intellig.log.level default to be 'info', got ${JSON.stringify(prop.default)}`
      );
    });

    it('has a non-empty description', () => {
      const prop = properties['intellig.log.level'];
      assert.strictEqual(
        typeof prop.description,
        'string',
        'expected intellig.log.level to declare a string description'
      );
      assert.ok(
        (prop.description ?? '').trim().length > 0,
        'expected intellig.log.level description to be non-empty'
      );
    });
  });

  // -------------------------------------------------------------------------
  // intellig.log.console
  // -------------------------------------------------------------------------

  describe('intellig.log.console', () => {
    it('is declared under contributes.configuration.properties', () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(properties, 'intellig.log.console'),
        "expected 'intellig.log.console' to be declared in package.json " +
          'contributes.configuration.properties'
      );
    });

    it('has type "boolean"', () => {
      const prop = properties['intellig.log.console'];
      assert.strictEqual(
        prop.type,
        'boolean',
        `expected intellig.log.console type to be 'boolean', got ${JSON.stringify(prop.type)}`
      );
    });

    it('does not declare an enum (booleans are constrained by type alone)', () => {
      const prop = properties['intellig.log.console'];
      assert.strictEqual(
        prop.enum,
        undefined,
        'expected intellig.log.console to not declare an enum; booleans are ' +
          'sufficiently constrained by type:boolean'
      );
    });

    it('has default false', () => {
      const prop = properties['intellig.log.console'];
      assert.strictEqual(
        prop.default,
        false,
        `expected intellig.log.console default to be false, got ${JSON.stringify(prop.default)}`
      );
    });

    it('has a non-empty description', () => {
      const prop = properties['intellig.log.console'];
      assert.strictEqual(
        typeof prop.description,
        'string',
        'expected intellig.log.console to declare a string description'
      );
      assert.ok(
        (prop.description ?? '').trim().length > 0,
        'expected intellig.log.console description to be non-empty'
      );
    });
  });
});
