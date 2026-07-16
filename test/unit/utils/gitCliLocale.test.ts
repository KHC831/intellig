/**
 * Locale pinning at the single git spawn seam.
 *
 * Every prose-based classification of git output (conflict heuristics,
 * would-be-overwritten detection, untracked-overwrite file lists) matches
 * ENGLISH phrases. On a localized system git emits translated stderr and the
 * heuristics silently miss — the resolve dialog never opens. IntelliJ pins
 * the locale on EVERY spawn: git4idea GitHandler.java:527
 * `executionEnvironment.putAll(getLocaleEnv())` → VcsLocaleHelper.kt
 * `createEnvForLocale` sets `LANGUAGE=""` + `LC_ALL="en_US.UTF-8"` (the
 * EN_UTF_LOCALE default). These specs pin the same contract on
 * `GitCli._spawnOnce`'s env composition via the injectable spawn seam.
 */

import * as assert from 'assert';
import type { spawn, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { GitCli } from '../../../src/git-core/gitCli';

/** Fake spawn capturing SpawnOptions and exiting 0 with no output. */
function makeCapturingSpawn(captured: SpawnOptions[]): typeof spawn {
  return ((_cmd: string, _args: string[], options: SpawnOptions) => {
    captured.push(options);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: () => void; write: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => undefined, write: () => undefined, on: () => undefined };
    child.kill = () => undefined;
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as unknown as typeof spawn;
}

describe('GitCli — locale pinned on every spawn (VcsLocaleHelper parity)', () => {
  it('pins LC_ALL=en_US.UTF-8 and LANGUAGE="" in the spawn env', async () => {
    const captured: SpawnOptions[] = [];
    const cli = new GitCli('git', makeCapturingSpawn(captured));

    await cli.exec(['status', '--porcelain']);

    assert.strictEqual(captured.length, 1, 'one spawn expected');
    const env = captured[0].env ?? {};
    assert.strictEqual(
      env.LC_ALL,
      'en_US.UTF-8',
      'git output must be locale-pinned so prose-based detection is reliable'
    );
    assert.strictEqual(
      env.LANGUAGE,
      '',
      'LANGUAGE must be cleared (it outranks LC_ALL for gettext message lookup)'
    );
  });

  it('overrides an inherited localized environment', async () => {
    // A German host locale is exactly the failure mode: git would emit
    // localized stderr and every English-phrase heuristic would miss.
    const saved = { ...process.env };
    process.env.LANG = 'de_DE.UTF-8';
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANGUAGE = 'de_DE:de';
    try {
      const captured: SpawnOptions[] = [];
      const cli = new GitCli('git', makeCapturingSpawn(captured));

      await cli.exec(['status', '--porcelain']);

      const env = captured[0].env ?? {};
      assert.strictEqual(env.LC_ALL, 'en_US.UTF-8', 'the pin must beat the inherited LC_ALL');
      assert.strictEqual(env.LANGUAGE, '', 'the pin must beat the inherited LANGUAGE');
    } finally {
      process.env.LANG = saved.LANG;
      process.env.LC_ALL = saved.LC_ALL;
      process.env.LANGUAGE = saved.LANGUAGE;
      if (saved.LANG === undefined) {
        delete process.env.LANG;
      }
      if (saved.LC_ALL === undefined) {
        delete process.env.LC_ALL;
      }
      if (saved.LANGUAGE === undefined) {
        delete process.env.LANGUAGE;
      }
    }
  });

  it('keeps GIT_OPTIONAL_LOCKS and caller-supplied env vars intact', async () => {
    const captured: SpawnOptions[] = [];
    const cli = new GitCli('git', makeCapturingSpawn(captured));

    await cli.exec(['rebase', '--continue'], { env: { GIT_SEQUENCE_EDITOR: '/tmp/editor.sh' } });

    const env = captured[0].env ?? {};
    assert.strictEqual(env.GIT_OPTIONAL_LOCKS, '0', 'existing spawn env contract preserved');
    assert.strictEqual(env.GIT_SEQUENCE_EDITOR, '/tmp/editor.sh', 'caller env still applied');
    assert.strictEqual(env.LC_ALL, 'en_US.UTF-8', 'the pin coexists with caller env');
  });
});
