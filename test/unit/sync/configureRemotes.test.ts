/**
 * Unit tests for the Configure Remotes flow (IntelliJ GitConfigureRemotesDialog
 * as a QuickPick list over a define-remote dialog).
 *
 * Covers:
 *  - `validateRemoteName` / `validateRemoteUrl` input validation.
 *  - `sortRemotesOriginFirst` ordering (origin first, then alphabetical).
 *  - `runConfigureRemotesFlow`: listing, add (with origin proposal and
 *    fetch-after-add), edit (rename + URL in one dialog), remove (single modal
 *    confirm), cancellation, error surfacing, and the loop-back-to-list
 *    behaviour that mirrors IntelliJ's stays-open dialog.
 */

/*
 * Stub factories synthesise IGitService / IConfigureRemotesDeps whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { okAsync, errAsync } from 'neverthrow';
import * as assert from 'assert';
import { SpawnFailedError } from '../../../src/git-core/errors';
import {
  runConfigureRemotesFlow,
  sortRemotesOriginFirst,
  IConfigureRemotesDeps,
} from '../../../src/sync/configureRemotes';
import { validateRemoteName, validateRemoteUrl } from '../../../src/sync/remoteValidation';
import type {
  IDefineRemoteRequest,
  IDefineRemoteResult,
} from '../../../src/sync/defineRemoteDialog.protocol';
import { IGitService, IRemote, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface OpCall {
  op: 'add' | 'remove' | 'setUrl' | 'rename';
  args: string[];
}

interface MockHarness {
  deps: IConfigureRemotesDeps;
  opCalls: OpCall[];
  quickPickItemLabels: string[][];
  defineRequests: IDefineRemoteRequest[];
  infoMessages: string[];
  errorMessages: string[];
  warnMessages: string[];
  fetchedRemotes: string[];
  remotesChangedCalls: number;
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

/**
 * Scripted-response harness. Each quickPickResponses entry is a label
 * substring used to select an item (undefined = Esc); defineResponses feed the
 * define-remote dialog in order (undefined = Cancel).
 */
function createHarness(options: {
  remotes: IRemote[];
  quickPickResponses: Array<string | undefined>;
  defineResponses?: Array<IDefineRemoteResult | undefined>;
  warnResponse?: string;
  addError?: Error;
  renameError?: Error;
  getRemotesError?: Error;
  fetchError?: Error;
}): MockHarness {
  const opCalls: OpCall[] = [];
  const quickPickItemLabels: string[][] = [];
  const defineRequests: IDefineRemoteRequest[] = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const warnMessages: string[] = [];
  const fetchedRemotes: string[] = [];
  let quickPickIndex = 0;
  let defineIndex = 0;
  let remotes = options.remotes;

  const gitService = {
    getRemotes: () =>
      options.getRemotesError
        ? errAsync(new SpawnFailedError(options.getRemotesError.message))
        : okAsync(remotes),
    addRemote: (_r: IRepository, name: string, url: string) => {
      opCalls.push({ op: 'add', args: [name, url] });
      if (options.addError) {
        return errAsync(new SpawnFailedError(options.addError.message));
      }
      remotes = [...remotes, { name, fetchUrl: url }];
      return okAsync(undefined);
    },
    removeRemote: (_r: IRepository, name: string) => {
      opCalls.push({ op: 'remove', args: [name] });
      remotes = remotes.filter((rm) => rm.name !== name);
      return okAsync(undefined);
    },
    setRemoteUrl: (_r: IRepository, name: string, url: string) => {
      opCalls.push({ op: 'setUrl', args: [name, url] });
      return okAsync(undefined);
    },
    renameRemote: (_r: IRepository, oldName: string, newName: string) => {
      opCalls.push({ op: 'rename', args: [oldName, newName] });
      if (options.renameError) {
        return errAsync(new SpawnFailedError(options.renameError.message));
      }
      remotes = remotes.map((rm) => (rm.name === oldName ? { ...rm, name: newName } : rm));
      return okAsync(undefined);
    },
  } as unknown as IGitService;

  const harness: MockHarness = {
    opCalls,
    quickPickItemLabels,
    defineRequests,
    infoMessages,
    errorMessages,
    warnMessages,
    fetchedRemotes,
    remotesChangedCalls: 0,
    deps: {
      repo: createRepo(),
      gitService,
      defineRemote: async (request: IDefineRemoteRequest) => {
        defineRequests.push(request);
        const response = options.defineResponses?.[defineIndex];
        defineIndex += 1;
        return response;
      },
      showQuickPick: async (items: Array<{ label: string }>) => {
        quickPickItemLabels.push(items.map((i) => i.label));
        const response = options.quickPickResponses[quickPickIndex];
        quickPickIndex += 1;
        if (response === undefined) {
          return undefined;
        }
        return items.find((i) => i.label.includes(response));
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
        return options.warnResponse;
      },
      fetchRemote: async (name: string) => {
        fetchedRemotes.push(name);
        if (options.fetchError) {
          throw options.fetchError;
        }
      },
      onRemotesChanged: () => {
        harness.remotesChangedCalls += 1;
      },
    },
  };
  return harness;
}

const ORIGIN: IRemote = { name: 'origin', fetchUrl: 'https://example.com/origin.git' };
const UPSTREAM: IRemote = { name: 'upstream', fetchUrl: 'https://example.com/upstream.git' };
const ALPHA: IRemote = { name: 'alpha', fetchUrl: 'https://example.com/alpha.git' };

// ─── validateRemoteName ──────────────────────────────────────────────────────

describe('validateRemoteName', () => {
  it('rejects an empty name', () => {
    assert.ok(validateRemoteName('', []));
    assert.ok(validateRemoteName('   ', []));
  });

  it('rejects whitespace and control characters', () => {
    assert.ok(validateRemoteName('my remote', []));
    assert.ok(validateRemoteName('bad\x07name', []));
  });

  it('rejects a leading dash (argv-injection shape)', () => {
    assert.ok(validateRemoteName('-evil', []));
  });

  it('rejects git-invalid ref characters', () => {
    assert.ok(validateRemoteName('a~b', []));
    assert.ok(validateRemoteName('a..b', []));
    assert.ok(validateRemoteName('a.lock', []));
  });

  it('rejects a duplicate of an existing remote', () => {
    assert.ok(validateRemoteName('origin', ['origin', 'upstream']));
  });

  it('allows keeping the original name on edit', () => {
    assert.strictEqual(validateRemoteName('origin', ['origin'], 'origin'), undefined);
  });

  it('accepts a well-formed unique name', () => {
    assert.strictEqual(validateRemoteName('upstream', ['origin']), undefined);
  });
});

// ─── validateRemoteUrl ───────────────────────────────────────────────────────

describe('validateRemoteUrl', () => {
  it('rejects an empty URL', () => {
    assert.ok(validateRemoteUrl(''));
    assert.ok(validateRemoteUrl('   '));
  });

  it('rejects a leading dash (argv-injection shape)', () => {
    assert.ok(validateRemoteUrl('--upload-pack=evil'));
  });

  it('accepts https and scp-style URLs', () => {
    assert.strictEqual(validateRemoteUrl('https://example.com/r.git'), undefined);
    assert.strictEqual(validateRemoteUrl('git@example.com:me/r.git'), undefined);
  });
});

// ─── sortRemotesOriginFirst ──────────────────────────────────────────────────

describe('sortRemotesOriginFirst', () => {
  it('puts origin first, then sorts alphabetically', () => {
    const sorted = sortRemotesOriginFirst([UPSTREAM, ALPHA, ORIGIN]);
    assert.deepStrictEqual(
      sorted.map((r) => r.name),
      ['origin', 'alpha', 'upstream']
    );
  });

  it('does not mutate its input', () => {
    const input = [UPSTREAM, ORIGIN];
    sortRemotesOriginFirst(input);
    assert.deepStrictEqual(
      input.map((r) => r.name),
      ['upstream', 'origin']
    );
  });
});

// ─── runConfigureRemotesFlow ─────────────────────────────────────────────────

const GOOD_DEFINE: IDefineRemoteResult = {
  name: 'upstream',
  url: 'https://example.com/upstream.git',
  fetch: true,
};

describe('runConfigureRemotesFlow', () => {
  it('lists remotes origin-first with URLs plus an Add item, exits on Esc', async () => {
    const h = createHarness({
      remotes: [UPSTREAM, ORIGIN],
      quickPickResponses: [undefined],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.quickPickItemLabels.length, 1);
    const labels = h.quickPickItemLabels[0];
    const originIdx = labels.findIndex((l) => l.includes('origin'));
    const upstreamIdx = labels.findIndex((l) => l.includes('upstream'));
    assert.ok(
      originIdx >= 0 && upstreamIdx > originIdx,
      `origin before upstream in ${labels.join(', ')}`
    );
    assert.ok(
      labels.some((l) => l.includes('Add Remote')),
      `expected an Add Remote item in ${labels.join(', ')}`
    );
    assert.strictEqual(h.opCalls.length, 0);
  });

  it('collects the new remote in one define dialog instead of sequential prompts', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [GOOD_DEFINE],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.strictEqual(h.defineRequests.length, 1);
    assert.deepStrictEqual(h.opCalls, [
      { op: 'add', args: ['upstream', 'https://example.com/upstream.git'] },
    ]);
  });

  it('fetches, refreshes, and loops back to the list after an add', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [GOOD_DEFINE],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.fetchedRemotes, ['upstream']);
    assert.strictEqual(h.remotesChangedCalls, 1);
    assert.ok(h.infoMessages.some((m) => m.includes('upstream')));
    assert.strictEqual(h.quickPickItemLabels.length, 2, 'looped back to the list');
  });

  it('skips the post-add fetch when the dialog cleared the fetch option', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [{ ...GOOD_DEFINE, fetch: false }],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.fetchedRemotes, []);
  });

  it('hands the dialog the taken names so it can reject a duplicate', async () => {
    const h = createHarness({
      remotes: [ORIGIN, UPSTREAM],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [undefined],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.defineRequests[0].existingNames, ['origin', 'upstream']);
  });

  it('proposes "origin" as the name when no origin exists, empty otherwise', async () => {
    const noOrigin = createHarness({
      remotes: [UPSTREAM],
      quickPickResponses: ['Add Remote'],
      defineResponses: [undefined],
    });
    await runConfigureRemotesFlow(noOrigin.deps);
    assert.strictEqual(noOrigin.defineRequests[0].name, 'origin');

    const withOrigin = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote'],
      defineResponses: [undefined],
    });
    await runConfigureRemotesFlow(withOrigin.deps);
    assert.strictEqual(withOrigin.defineRequests[0].name, '');
  });

  it('surfaces a fetch failure as a warning while the add still succeeds', async () => {
    const h = createHarness({
      remotes: [],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [{ name: 'origin', url: 'https://example.com/origin.git', fetch: true }],
      fetchError: new Error('could not resolve host'),
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.opCalls.length, 1);
    assert.ok(h.warnMessages.some((m) => m.toLowerCase().includes('fetch')));
    assert.strictEqual(h.errorMessages.length, 0);
  });

  it('cancelling the define dialog returns to the list without adding', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [undefined],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.opCalls.length, 0);
    assert.strictEqual(h.quickPickItemLabels.length, 2);
  });

  // GitConfigureRemotesDialog.editRemote opens the same define dialog prefilled
  // with the current name + URL, then renames and re-points in one go.
  it('prefills the define dialog with the edited remote and exempts its own name', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Edit', undefined],
      defineResponses: [undefined],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(
      {
        name: h.defineRequests[0].name,
        url: h.defineRequests[0].url,
        originalName: h.defineRequests[0].originalName,
      },
      { name: 'origin', url: 'https://example.com/origin.git', originalName: 'origin' }
    );
  });

  it('renames before re-pointing the URL so the URL lands on the new name', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Edit', undefined],
      defineResponses: [{ name: 'upstream', url: 'https://example.com/new.git', fetch: false }],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.opCalls, [
      { op: 'rename', args: ['origin', 'upstream'] },
      { op: 'setUrl', args: ['upstream', 'https://example.com/new.git'] },
    ]);
  });

  it('changes only the URL when the name was left alone', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Edit', undefined],
      defineResponses: [{ name: 'origin', url: 'https://example.com/new.git', fetch: false }],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.opCalls, [
      { op: 'setUrl', args: ['origin', 'https://example.com/new.git'] },
    ]);
  });

  it('runs no git command when the edit dialog returns unchanged values', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Edit', undefined],
      defineResponses: [{ name: 'origin', url: 'https://example.com/origin.git', fetch: false }],
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.opCalls, []);
    assert.strictEqual(h.remotesChangedCalls, 0);
  });

  it('leaves the URL untouched when the rename fails', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Edit', undefined],
      defineResponses: [{ name: 'upstream', url: 'https://example.com/new.git', fetch: false }],
      renameError: new Error('fatal: remote upstream already exists'),
    });

    await runConfigureRemotesFlow(h.deps);

    assert.deepStrictEqual(h.opCalls, [{ op: 'rename', args: ['origin', 'upstream'] }]);
    assert.strictEqual(h.errorMessages.length, 1);
  });

  it('removes a remote after one modal confirm', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Remove', undefined],
      warnResponse: 'Remove',
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.opCalls, [{ op: 'remove', args: ['origin'] }]);
    assert.strictEqual(h.warnMessages.length, 1);
    assert.ok(h.warnMessages[0].includes('origin'));
  });

  it('does not remove when the confirm is dismissed', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Remove', undefined],
      warnResponse: undefined,
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.opCalls.length, 0);
  });

  it('Esc on the action menu returns to the list', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', undefined, undefined],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.opCalls.length, 0);
    assert.strictEqual(h.quickPickItemLabels.length, 3);
  });

  it('surfaces an op failure as an error toast and keeps the flow open', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      defineResponses: [GOOD_DEFINE],
      addError: new Error('fatal: remote upstream already exists'),
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.errorMessages.length, 1);
    assert.ok(h.errorMessages[0].includes('already exists'));
    assert.strictEqual(h.quickPickItemLabels.length, 2);
    assert.deepStrictEqual(h.fetchedRemotes, []);
  });

  it('exits with an error toast when remotes cannot be listed', async () => {
    const h = createHarness({
      remotes: [],
      quickPickResponses: [],
      getRemotesError: new Error('not a git repository'),
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.errorMessages.length, 1);
    assert.strictEqual(h.quickPickItemLabels.length, 0);
  });
});
