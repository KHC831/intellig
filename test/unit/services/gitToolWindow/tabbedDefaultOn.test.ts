/**
 * Unit tests for the tabbed Git tool window layout default (C-5).
 *
 * The tabbed layout (Log / Console / Incoming / Update Info / History) is the
 * default Git tool-window presentation, matching IntelliJ's git4idea tool
 * window which registers its content as tabs. Users can still opt out via
 * `intellig.useTabbedGitToolWindow: false`.
 *
 * These specs pin both halves of the contract:
 *   - the runtime read helper resolves to `true` on fresh state, and
 *   - the package.json schema registers `default: true`,
 * while preserving the explicit opt-out / opt-in paths.
 */

import '../../../setup';
import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { resetMockConfiguration, setMockConfigValue } from '../../../mocks/vscode';
import {
  isTabbedGitToolWindowEnabled,
  TABBED_CONFIG_KEY,
  TABBED_CONFIG_FULL_KEY,
} from '../../../../src/git-core/gitToolWindow/config';

describe('git tool window — tabbed layout default-on (C-5)', () => {
  beforeEach(() => resetMockConfiguration());
  afterEach(() => resetMockConfiguration());

  it('resolves to true on fresh state (no user override)', () => {
    assert.strictEqual(isTabbedGitToolWindowEnabled(), true);
  });

  it('honours an explicit opt-out (user sets the flag false)', () => {
    setMockConfigValue('intellig', TABBED_CONFIG_KEY, false);
    assert.strictEqual(isTabbedGitToolWindowEnabled(), false);
  });

  it('honours an explicit opt-in (user sets the flag true)', () => {
    setMockConfigValue('intellig', TABBED_CONFIG_KEY, true);
    assert.strictEqual(isTabbedGitToolWindowEnabled(), true);
  });

  it('package.json registers the schema default as true', () => {
    const pkgPath = path.resolve(__dirname, '../../../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      contributes: {
        configuration: Array<{
          properties?: Record<string, { default?: unknown }>;
        }>;
      };
    };
    // configuration is an array of titled sections; flatten to look up a key.
    const properties = Object.assign(
      {},
      ...pkg.contributes.configuration.map((s) => s.properties ?? {})
    ) as Record<string, { default?: unknown }>;
    const prop = properties[TABBED_CONFIG_FULL_KEY];
    assert.ok(prop, `schema must declare ${TABBED_CONFIG_FULL_KEY}`);
    assert.strictEqual(prop.default, true, 'tabbed layout must default on');
  });
});
