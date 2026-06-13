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
}

interface MockHarness {
  deps: INewTagFlowDeps;
  createTagCalls: CreateTagCall[];
  infoMessages: string[];
  errorMessages: string[];
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
  options?: { createTagError?: Error }
): MockHarness {
  const repo = createRepo();
  const createTagCalls: CreateTagCall[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];

  const gitService = {
    createTag: async (
      r: IRepository,
      name: string,
      message?: string,
      ref?: string
    ): Promise<void> => {
      createTagCalls.push({ repo: r, name, message, ref });
      if (options?.createTagError) {
        throw options.createTagError;
      }
    },
  } as unknown as IGitService;

  const harness: MockHarness = {
    createTagCalls,
    infoMessages,
    errorMessages,
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

  it('surfaces errors from createTag via showErrorMessage', async () => {
    const h = createHarness(['v1.0.0', ''], {
      createTagError: new Error('tag already exists'),
    });
    await runNewTagFlow(h.deps, undefined);

    assert.strictEqual(h.createTagCalls.length, 1);
    assert.deepStrictEqual(h.infoMessages, []);
    assert.strictEqual(h.errorMessages.length, 1);
    assert.ok(
      h.errorMessages[0].includes('tag already exists'),
      `Expected error toast to include stderr; got: ${h.errorMessages[0]}`
    );
    assert.strictEqual(h.tagCreatedCalled, 0, 'onTagCreated should not fire when createTag throws');
  });
});
