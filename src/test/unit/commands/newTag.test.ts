/**
 * Unit tests for the New Tag flow.
 *
 * Covers:
 *  - `validateTagName` against empty, whitespace, git-rejected chars,
 *    leading/trailing sentinels, `.lock` suffix, and control chars.
 *  - `runNewTagFlow` behaviour: lightweight vs annotated tag creation,
 *    cancellation at each prompt, success toast and refresh hook, error
 *    path with error toast, and the commit-context vs palette target-ref
 *    distinction.
 */

/*
 * Stub factories synthesise IGitService / INewTagFlowDeps implementations
 * whose member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import { runNewTagFlow, validateTagName, INewTagFlowDeps } from '../../../extension';
import { IGitService, IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface CreateTagCall {
  repo: IRepository;
  name: string;
  message: string | undefined;
  ref: string | undefined;
  force: boolean | undefined;
}

interface MockHarness {
  deps: INewTagFlowDeps;
  createTagCalls: CreateTagCall[];
  infoMessages: string[];
  errorMessages: string[];
  warnMessages: string[];
  tagCreatedCalled: number;
  inputResponses: Array<string | undefined>;
  inputIndex: number;
}

function createRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function createHarness(
  inputResponses: Array<string | undefined>,
  options?: {
    createTagError?: Error;
    /** When set, only the NON-forced createTag call throws — a forced retry
     *  succeeds. Models git rejecting an existing tag until `-f`. */
    failUntilForced?: boolean;
    /** Response returned by showWarningMessage (the overwrite prompt). */
    warnResponse?: string;
  }
): MockHarness {
  const repo = createRepo();
  const createTagCalls: CreateTagCall[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const warnMessages: string[] = [];

  const gitService = {
    createTag: async (
      r: IRepository,
      name: string,
      message?: string,
      ref?: string,
      force?: boolean
    ): Promise<void> => {
      createTagCalls.push({ repo: r, name, message, ref, force });
      if (options?.failUntilForced && !force) {
        throw new Error("fatal: tag 'v1.0.0' already exists");
      }
      if (options?.createTagError) {
        throw options.createTagError;
      }
    },
  } as unknown as IGitService;

  const harness: MockHarness = {
    createTagCalls,
    infoMessages,
    errorMessages,
    warnMessages,
    tagCreatedCalled: 0,
    inputResponses,
    inputIndex: 0,
    deps: {
      repo,
      gitService,
      showInputBox: async () => {
        const value = inputResponses[harness.inputIndex];
        harness.inputIndex += 1;
        return value;
      },
      showInformationMessage: async (msg: string) => {
        infoMessages.push(msg);
        return undefined;
      },
      showErrorMessage: async (msg: string) => {
        errorMessages.push(msg);
        return undefined;
      },
      showWarningMessage: async (msg: string) => {
        warnMessages.push(msg);
        return options?.warnResponse;
      },
      onTagCreated: () => {
        harness.tagCreatedCalled += 1;
      },
    },
  };

  return harness;
}

// ─── validateTagName ─────────────────────────────────────────────────────────

describe('validateTagName', () => {
  it('rejects empty name', () => {
    assert.ok(validateTagName(''));
  });

  it('rejects whitespace-only name', () => {
    assert.ok(validateTagName('   '));
  });

  it('rejects names containing spaces', () => {
    assert.ok(validateTagName('my tag'));
  });

  it('rejects names containing ~', () => {
    assert.ok(validateTagName('foo~bar'));
  });

  it('rejects names containing ^', () => {
    assert.ok(validateTagName('foo^bar'));
  });

  it('rejects names containing :', () => {
    assert.ok(validateTagName('foo:bar'));
  });

  it('rejects names containing ?', () => {
    assert.ok(validateTagName('foo?'));
  });

  it('rejects names containing *', () => {
    assert.ok(validateTagName('foo*'));
  });

  it('rejects names containing [', () => {
    assert.ok(validateTagName('foo[bar'));
  });

  it('rejects names containing backslash', () => {
    assert.ok(validateTagName('foo\\bar'));
  });

  it('rejects names containing ..', () => {
    assert.ok(validateTagName('v1..0'));
  });

  it('rejects names starting with -', () => {
    assert.ok(validateTagName('-tag'));
  });

  it('rejects names starting with .', () => {
    assert.ok(validateTagName('.tag'));
  });

  it('rejects names starting with /', () => {
    assert.ok(validateTagName('/tag'));
  });

  it('rejects names ending with .', () => {
    assert.ok(validateTagName('tag.'));
  });

  it('rejects names ending with /', () => {
    assert.ok(validateTagName('tag/'));
  });

  it('rejects names ending with .lock', () => {
    assert.ok(validateTagName('tag.lock'));
  });

  it('rejects names containing control characters', () => {
    assert.ok(validateTagName('tag\x01name'));
  });

  it('accepts well-formed lightweight-tag-style name', () => {
    assert.strictEqual(validateTagName('v1.0.0'), undefined);
  });

  it('accepts well-formed scoped tag name', () => {
    assert.strictEqual(validateTagName('release/1.0.0'), undefined);
  });

  it('accepts tag names with hyphens and digits', () => {
    assert.strictEqual(validateTagName('v1.2.3-rc.1'), undefined);
  });
});

// ─── runNewTagFlow ───────────────────────────────────────────────────────────

describe('runNewTagFlow', () => {
  it('creates a lightweight tag when message prompt is empty', async () => {
    const h = createHarness(['v1.0.0', '']);
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 1);
    const call = h.createTagCalls[0];
    assert.strictEqual(call.name, 'v1.0.0');
    assert.strictEqual(call.message, undefined, 'empty message should produce a lightweight tag');
    assert.strictEqual(call.ref, undefined, 'palette flow targets HEAD (ref=undefined)');
    assert.deepStrictEqual(h.infoMessages, ['Created tag: v1.0.0']);
    assert.deepStrictEqual(h.errorMessages, []);
    assert.strictEqual(h.tagCreatedCalled, 1);
  });

  it('creates an annotated tag when message prompt has text', async () => {
    const h = createHarness(['v1.0.0', 'Release 1.0']);
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 1);
    assert.strictEqual(h.createTagCalls[0].message, 'Release 1.0');
  });

  it('treats whitespace-only message as lightweight (trimmed empty)', async () => {
    const h = createHarness(['v1.0.0', '   ']);
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 1);
    assert.strictEqual(h.createTagCalls[0].message, undefined);
  });

  it('passes targetRef through when invoked from log commit context', async () => {
    const h = createHarness(['v1.0.0', '']);
    await runNewTagFlow(h.deps, 'abc1234');

    assert.strictEqual(h.createTagCalls.length, 1);
    assert.strictEqual(h.createTagCalls[0].ref, 'abc1234');
  });

  it('does not call createTag when user cancels at the name prompt', async () => {
    const h = createHarness([undefined]);
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 0);
    assert.deepStrictEqual(h.infoMessages, []);
    assert.deepStrictEqual(h.errorMessages, []);
    assert.strictEqual(h.tagCreatedCalled, 0);
  });

  it('does not call createTag when user cancels at the message prompt', async () => {
    const h = createHarness(['v1.0.0', undefined]);
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 0);
    assert.deepStrictEqual(h.infoMessages, []);
    assert.deepStrictEqual(h.errorMessages, []);
    assert.strictEqual(h.tagCreatedCalled, 0);
  });

  it('surfaces a non-"already exists" error from createTag via showErrorMessage', async () => {
    const h = createHarness(['v1.0.0', ''], {
      createTagError: new Error('fatal: not a valid object name'),
    });
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 1);
    assert.deepStrictEqual(h.infoMessages, []);
    assert.strictEqual(h.errorMessages.length, 1);
    assert.ok(
      h.errorMessages[0].includes('not a valid object name'),
      `Expected error toast to include stderr; got: ${h.errorMessages[0]}`
    );
    assert.strictEqual(h.tagCreatedCalled, 0, 'onTagCreated should not fire when createTag throws');
  });

  // #P2 — IntelliJ GitTagDialog Force checkbox, surfaced as an
  // overwrite-on-conflict prompt (we don't show the checkbox up front;
  // instead we offer Force only when the tag already exists).
  describe('force-overwrite on "already exists" (#P2)', () => {
    it('prompts to overwrite, then retries createTag with force=true on confirm', async () => {
      const h = createHarness(['v1.0.0', ''], {
        failUntilForced: true,
        warnResponse: 'Overwrite',
      });
      await runNewTagFlow(h.deps, undefined);

      assert.strictEqual(h.warnMessages.length, 1, 'overwrite prompt shown once');
      assert.strictEqual(h.createTagCalls.length, 2, 'first attempt + forced retry');
      assert.strictEqual(h.createTagCalls[0].force ?? false, false, 'first attempt is not forced');
      assert.strictEqual(h.createTagCalls[1].force, true, 'retry passes force');
      assert.strictEqual(h.tagCreatedCalled, 1, 'success fires onTagCreated');
      assert.deepStrictEqual(h.errorMessages, [], 'no error toast on a successful overwrite');
    });

    it('does NOT force when the user dismisses the overwrite prompt', async () => {
      const h = createHarness(['v1.0.0', ''], {
        failUntilForced: true,
        warnResponse: undefined,
      });
      await runNewTagFlow(h.deps, undefined);

      assert.strictEqual(h.warnMessages.length, 1, 'overwrite prompt shown');
      assert.strictEqual(h.createTagCalls.length, 1, 'no forced retry when declined');
      assert.strictEqual(h.tagCreatedCalled, 0);
    });
  });
});
