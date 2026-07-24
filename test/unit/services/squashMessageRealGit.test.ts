/**
 * Real-git regression coverage for the multi-select "Squash Commits" combined
 * message. The mock/shape tests prove the PLAN the handler builds; this test
 * proves the runtime DELIVERY — it runs an actual `git rebase -i` under
 * `GIT_EDITOR=true` (the same non-interactive pin the production rebase uses)
 * and asserts the squashed commit ends up with EXACTLY the user's combined
 * message.
 *
 * The bug this guards against: the squash silently discarded the user's edited
 * message and kept only the newest commit's message. The failure could only be
 * caught by running git, because it hinged on git's non-interactive behaviour
 * (a classic `squash` never pauses under `GIT_EDITOR=true`).
 *
 * Drives the real flow: the plan comes from the production
 * {@link buildSquashRebasePlan}; the todo is rewritten by the production
 * sequence editor (`dist/rebaseTodoEditor.js`, exactly as
 * `RebaseService.executeRebase` invokes it). Reverting either the plan shape or
 * the editor's transform turns this test red.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCli } from '../../../src/git-core/gitCli';
import { REBASE_PLAN_ENV } from '../../../src/git-core/rebaseTodoEditor';
import { buildSquashRebasePlan } from '../../../src/commits/squashPlan';
import type { IRebaseCommit } from '../../../src/git-core/interfaces/IRebaseService';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const COMPILED_EDITOR = path.join(PROJECT_ROOT, 'dist', 'rebaseTodoEditor.js');

describe('Squash Commits combined message (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let savedSeqEditor: string | undefined;
  let savedEditor: string | undefined;

  async function git(...args: string[]): Promise<string> {
    const r = await gitCli.exec(args, { cwd: repoPath });
    return r.stdout.trim();
  }

  async function commit(content: string, message: string): Promise<string> {
    fs.writeFileSync(path.join(repoPath, 'f.txt'), content);
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', message], { cwd: repoPath });
    return git('rev-parse', 'HEAD');
  }

  /**
   * Run `git rebase -i <onto>` driving the production sequence editor with the
   * given plan — the same wiring as RebaseService.executeRebase (custom
   * GIT_SEQUENCE_EDITOR shim + plan in the env + GIT_EDITOR=true).
   */
  async function rebaseWithPlan(
    onto: string,
    plan: ReturnType<typeof buildSquashRebasePlan>
  ): Promise<{ exitCode: number; combined: string }> {
    // git runs GIT_SEQUENCE_EDITOR (and the paths inside the shim) through sh on
    // every platform, so forward-slash them or Windows backslashes get mangled
    // (C:\a → C:a). No-op on POSIX.
    const seqEditor = path.join(repoPath, 'seq-editor.sh').replace(/\\/g, '/');
    fs.writeFileSync(seqEditor, `#!/bin/sh\nnode "${COMPILED_EDITOR.replace(/\\/g, '/')}" "$1"\n`, {
      mode: 0o755,
    });
    const r = await gitCli.exec(['rebase', '-i', '--end-of-options', onto], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_SEQUENCE_EDITOR: seqEditor,
        GIT_EDITOR: 'true',
        [REBASE_PLAN_ENV]: JSON.stringify(plan),
      },
    });
    return { exitCode: r.exitCode, combined: r.combined };
  }

  beforeEach(async () => {
    savedSeqEditor = process.env.GIT_SEQUENCE_EDITOR;
    savedEditor = process.env.GIT_EDITOR;
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-message-realgit-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: repoPath });
  });

  afterEach(() => {
    if (savedSeqEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    } else {
      process.env.GIT_SEQUENCE_EDITOR = savedSeqEditor;
    }
    if (savedEditor === undefined) {
      delete process.env.GIT_EDITOR;
    } else {
      process.env.GIT_EDITOR = savedEditor;
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('lands EXACTLY the user combined message on the squash target and discards the rest', async () => {
    assert.ok(
      fs.existsSync(COMPILED_EDITOR),
      `compiled sequence editor missing at ${COMPILED_EDITOR} — run \`npm run compile\` first`
    );

    // Three commits with distinct messages/bodies; B and C touch the same file
    // sequentially so squashing B+C is conflict-free.
    await commit('a\n', 'A subject\n\nA body line');
    const hashB = await commit('b\n', 'B subject\n\nB body line');
    const hashC = await commit('c\n', 'C subject\n\nC body line');

    // The squash window is everything after B^ (i.e. B and C), in replay order.
    const session: IRebaseCommit[] = [
      { hash: hashB, message: 'B subject', action: 'pick' },
      { hash: hashC, message: 'C subject', action: 'pick' },
    ];
    const userMessage = 'Squashed combined message\n\nedited body that the user typed';
    const plan = buildSquashRebasePlan(
      session,
      [hashB, hashC],
      hashB, // oldest selected = squash target
      userMessage
    );

    const result = await rebaseWithPlan(`${hashB}^`, plan);
    assert.strictEqual(result.exitCode, 0, `rebase must complete cleanly; got: ${result.combined}`);

    // The squashed commit carries EXACTLY the user's combined message.
    const finalMessage = await git('log', '-1', '--format=%B');
    assert.strictEqual(
      finalMessage,
      userMessage,
      'the squashed commit must keep the user-edited combined message verbatim'
    );

    // B's and C's own messages are gone from history (fixup discarded them).
    const allMessages = await git('log', '--format=%B');
    assert.ok(!/B subject/.test(allMessages), "B's own message must be absent after squash");
    assert.ok(!/C subject/.test(allMessages), "C's own message must be absent after squash");

    // Three commits collapsed to two (A + the squashed B/C).
    const count = await git('rev-list', '--count', 'HEAD');
    assert.strictEqual(count, '2', 'commit count must drop by two (B and C combined into one)');

    // A is untouched and still present.
    assert.ok(/A subject/.test(allMessages), 'the non-selected base commit A must be preserved');
  });
});
