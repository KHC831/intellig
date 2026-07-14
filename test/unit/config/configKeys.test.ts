/**
 * Spec for src/config/configKeys.ts — the typed config-key seam.
 *
 * readConfig/updateConfig/inspectConfig are the single place the extension calls
 * getConfiguration('intellig'). These specs pin: reads forward the setting name
 * unchanged (plain + dotted section keys) and pass NO fallback argument (the
 * schema default is VS Code's job), writes forward (name, value, target) with a
 * Global default target, and inspect forwards the name.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  CONFIG_KEYS,
  readConfig,
  updateConfig,
  inspectConfig,
} from '../../../src/config/configKeys';

interface GetCall {
  key: string;
  argCount: number;
}
interface UpdateCall {
  key: string;
  value: unknown;
  target: unknown;
}

function captureGetConfiguration(returns: Record<string, unknown> = {}): {
  sections: string[];
  getCalls: GetCall[];
  updateCalls: UpdateCall[];
  inspectCalls: string[];
  restore: () => void;
} {
  const sections: string[] = [];
  const getCalls: GetCall[] = [];
  const updateCalls: UpdateCall[] = [];
  const inspectCalls: string[] = [];
  const original = vscode.workspace.getConfiguration;
  (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = (
    section?: string
  ): unknown => {
    sections.push(section ?? '');
    return {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      get(key: string, ..._rest: unknown[]): unknown {
        getCalls.push({ key, argCount: arguments.length });
        return returns[key];
      },
      update(key: string, value: unknown, target: unknown): Promise<void> {
        updateCalls.push({ key, value, target });
        return Promise.resolve();
      },
      inspect(key: string): unknown {
        inspectCalls.push(key);
        return { key, defaultValue: returns[key] };
      },
    };
  };
  return {
    sections,
    getCalls,
    updateCalls,
    inspectCalls,
    restore: () => {
      (vscode.workspace as unknown as { getConfiguration: unknown }).getConfiguration = original;
    },
  };
}

describe('config accessor', () => {
  it('readConfig forwards a plain key to getConfiguration(intellig).get(name) with no fallback arg', () => {
    const cap = captureGetConfiguration({ protectedBranches: ['main', 'master'] });
    try {
      const value = readConfig('protectedBranches');
      assert.deepStrictEqual(value, ['main', 'master']);
      assert.deepStrictEqual(cap.sections, ['intellig']);
      assert.deepStrictEqual(cap.getCalls, [{ key: 'protectedBranches', argCount: 1 }]);
    } finally {
      cap.restore();
    }
  });

  it('readConfig forwards a dotted section key name unchanged', () => {
    const cap = captureGetConfiguration({ 'log.showGpgColumn': true });
    try {
      const value = readConfig('log.showGpgColumn');
      assert.strictEqual(value, true);
      assert.deepStrictEqual(cap.getCalls, [{ key: 'log.showGpgColumn', argCount: 1 }]);
    } finally {
      cap.restore();
    }
  });

  it('readConfig returns whatever get() resolves (schema default relied on, no fallback passed)', () => {
    // get() reports the schema default for an unset key; readConfig passes no
    // second arg, so the value it returns is exactly VS Code's resolution.
    const cap = captureGetConfiguration({ fetchTags: 'auto' });
    try {
      assert.strictEqual(readConfig('fetchTags'), 'auto');
      assert.strictEqual(
        cap.getCalls[0].argCount,
        1,
        'readConfig must not pass a fallback argument'
      );
    } finally {
      cap.restore();
    }
  });

  it('updateConfig forwards (name, value, Global) when no target is given', () => {
    const cap = captureGetConfiguration();
    try {
      void updateConfig('useCommitToolWindow', false);
      assert.deepStrictEqual(cap.updateCalls, [
        { key: 'useCommitToolWindow', value: false, target: vscode.ConfigurationTarget.Global },
      ]);
    } finally {
      cap.restore();
    }
  });

  it('updateConfig forwards an explicit target', () => {
    const cap = captureGetConfiguration();
    try {
      void updateConfig('useCommitToolWindow', true, vscode.ConfigurationTarget.Workspace);
      assert.strictEqual(cap.updateCalls[0].target, vscode.ConfigurationTarget.Workspace);
    } finally {
      cap.restore();
    }
  });

  it('inspectConfig forwards the setting name to .inspect(name)', () => {
    const cap = captureGetConfiguration({ keymapPreset: 'default' });
    try {
      const inspected = inspectConfig('keymapPreset');
      assert.strictEqual(inspected?.defaultValue, 'default');
      assert.deepStrictEqual(cap.inspectCalls, ['keymapPreset']);
    } finally {
      cap.restore();
    }
  });

  it('CONFIG_KEYS maps logical names to the dotted setting name', () => {
    assert.strictEqual(CONFIG_KEYS.logShowGpgColumn, 'log.showGpgColumn');
    assert.strictEqual(CONFIG_KEYS.diffIgnorePolicy, 'diff.ignorePolicy');
    assert.strictEqual(CONFIG_KEYS.protectedBranches, 'protectedBranches');
  });

  it('exposes enum-typed keys as literal unions (compile-time contract)', () => {
    const cap = captureGetConfiguration({ fetchTags: 'all' });
    try {
      // Assigning to the exact union documents the tightening from bare string.
      const tags: 'auto' | 'all' | 'never' = readConfig('fetchTags');
      assert.strictEqual(tags, 'all');
      // @ts-expect-error protectedBranches is string[], not a number
      const _bad: number = readConfig('protectedBranches');
      void _bad;
      // Note: a CONFIG_KEYS key missing from ConfigValues fails to compile at
      // the _configValuesCoversAllKeys tie in configKeys.ts, not here.
    } finally {
      cap.restore();
    }
  });
});
