/**
 * Unit tests for the Configure Remotes flow (IntelliJ GitConfigureRemotesDialog
 * as a QuickPick wizard).
 *
 * Covers:
 *  - `validateRemoteName` / `validateRemoteUrl` input validation.
 *  - `sortRemotesOriginFirst` ordering (origin first, then alphabetical).
 *  - `runConfigureRemotesFlow`: listing, add (with origin proposal and
 *    fetch-after-add), rename, change-URL, remove (single modal confirm),
 *    cancellation at each prompt, error surfacing, and the loop-back-to-list
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
  validateRemoteName,
  validateRemoteUrl,
  IConfigureRemotesDeps,
} from '../../../src/sync/configureRemotes';
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
  inputBoxOptions: Array<{ value?: string; prompt?: string }>;
  infoMessages: string[];
  errorMessages: string[];
  warnMessages: string[];
  fetchedRemotes: string[];
  probedUrls: string[];
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
 * substring used to select an item (undefined = Esc); inputResponses feed
 * showInputBox in order (undefined = Esc).
 */
function createHarness(options: {
  remotes: IRemote[];
  quickPickResponses: Array<string | undefined>;
  inputResponses?: Array<string | undefined>;
  warnResponse?: string;
  addError?: Error;
  getRemotesError?: Error;
  fetchError?: Error;
  /** Scripted probe outcomes, consumed in order. Present = probe seam wired. */
  probeResults?: Array<{ ok: boolean; message?: string }>;
}): MockHarness {
  const opCalls: OpCall[] = [];
  const quickPickItemLabels: string[][] = [];
  const inputBoxOptions: Array<{ value?: string; prompt?: string }> = [];
  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const warnMessages: string[] = [];
  const fetchedRemotes: string[] = [];
  let quickPickIndex = 0;
  let inputIndex = 0;
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
      return okAsync(undefined);
    },
  } as unknown as IGitService;

  let probeIndex = 0;
  const probedUrls: string[] = [];
  const harness: MockHarness = {
    opCalls,
    quickPickItemLabels,
    inputBoxOptions,
    infoMessages,
    errorMessages,
    warnMessages,
    fetchedRemotes,
    probedUrls,
    remotesChangedCalls: 0,
    deps: {
      repo: createRepo(),
      gitService,
      probeRemoteUrl: options.probeResults
        ? async (url: string) => {
            probedUrls.push(url);
            const result = options.probeResults?.[probeIndex] ?? { ok: true };
            probeIndex += 1;
            return result;
          }
        : undefined,
      showQuickPick: async (items: Array<{ label: string }>) => {
        quickPickItemLabels.push(items.map((i) => i.label));
        const response = options.quickPickResponses[quickPickIndex];
        quickPickIndex += 1;
        if (response === undefined) {
          return undefined;
        }
        return items.find((i) => i.label.includes(response));
      },
      showInputBox: async (opts: { value?: string; prompt?: string }) => {
        inputBoxOptions.push(opts);
        const value = options.inputResponses?.[inputIndex];
        inputIndex += 1;
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

  it('adds a remote, fetches it, refreshes, and loops back to the list', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      inputResponses: ['upstream', 'https://example.com/upstream.git'],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.opCalls, [
      { op: 'add', args: ['upstream', 'https://example.com/upstream.git'] },
    ]);
    assert.deepStrictEqual(h.fetchedRemotes, ['upstream']);
    assert.strictEqual(h.remotesChangedCalls, 1);
    assert.ok(h.infoMessages.some((m) => m.includes('upstream')));
    // Looped back: the remotes list was shown a second time.
    assert.strictEqual(h.quickPickItemLabels.length, 2);
  });

  it('proposes "origin" as the name when no origin exists, empty otherwise', async () => {
    const noOrigin = createHarness({
      remotes: [UPSTREAM],
      quickPickResponses: ['Add Remote'],
      inputResponses: [undefined],
    });
    await runConfigureRemotesFlow(noOrigin.deps);
    assert.strictEqual(noOrigin.inputBoxOptions[0].value, 'origin');

    const withOrigin = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote'],
      inputResponses: [undefined],
    });
    await runConfigureRemotesFlow(withOrigin.deps);
    assert.strictEqual(withOrigin.inputBoxOptions[0].value ?? '', '');
  });

  it('surfaces a fetch failure as a warning while the add still succeeds', async () => {
    const h = createHarness({
      remotes: [],
      quickPickResponses: ['Add Remote', undefined],
      inputResponses: ['origin', 'https://example.com/origin.git'],
      fetchError: new Error('could not resolve host'),
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.opCalls.length, 1);
    assert.ok(h.warnMessages.some((m) => m.toLowerCase().includes('fetch')));
    assert.strictEqual(h.errorMessages.length, 0);
  });

  it('cancelling the name prompt returns to the list without adding', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      inputResponses: [undefined],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.opCalls.length, 0);
    assert.strictEqual(h.quickPickItemLabels.length, 2);
  });

  // GitDefineRemoteDialog runs `git ls-remote <url>` on OK and refuses to
  // create/update a remote whose URL is inaccessible.
  it('blocks the add when the URL probe fails and the user gives up', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      inputResponses: ['upstream', 'https://bad.example/repo.git', undefined],
      probeResults: [{ ok: false, message: 'could not read from remote repository' }],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.probedUrls, ['https://bad.example/repo.git']);
    assert.strictEqual(h.opCalls.length, 0, 'the remote must NOT be created');
    assert.ok(
      h.errorMessages.some((m) => /not (accessible|reachable)/i.test(m)),
      `error explains the inaccessible URL: ${JSON.stringify(h.errorMessages)}`
    );
  });

  it('re-prompts the URL after a failed probe and adds once a good URL passes', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['Add Remote', undefined],
      inputResponses: ['upstream', 'https://bad.example/repo.git', 'https://good.example/repo.git'],
      probeResults: [{ ok: false, message: 'no route to host' }, { ok: true }],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.probedUrls, [
      'https://bad.example/repo.git',
      'https://good.example/repo.git',
    ]);
    assert.deepStrictEqual(h.opCalls, [
      { op: 'add', args: ['upstream', 'https://good.example/repo.git'] },
    ]);
    // The retry input is prefilled with the failing URL for correction.
    assert.strictEqual(h.inputBoxOptions[2].value, 'https://bad.example/repo.git');
  });

  it('blocks a URL change when the probe fails', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Change URL', undefined],
      inputResponses: ['https://typo.example/origin.git', undefined],
      probeResults: [{ ok: false, message: 'could not resolve host' }],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.probedUrls, ['https://typo.example/origin.git']);
    assert.strictEqual(h.opCalls.length, 0, 'the URL must NOT be changed');
    assert.ok(h.errorMessages.some((m) => /not (accessible|reachable)/i.test(m)));
  });

  it('changes the URL when the probe passes', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Change URL', undefined],
      inputResponses: ['https://new.example/origin.git'],
      probeResults: [{ ok: true }],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.opCalls, [
      { op: 'setUrl', args: ['origin', 'https://new.example/origin.git'] },
    ]);
  });

  it('renames a remote through the action menu', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Rename', undefined],
      inputResponses: ['upstream'],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.opCalls, [{ op: 'rename', args: ['origin', 'upstream'] }]);
    assert.strictEqual(h.remotesChangedCalls, 1);
    // Rename prompt is prefilled with the current name.
    assert.strictEqual(h.inputBoxOptions[0].value, 'origin');
  });

  it('changes a remote URL through the action menu', async () => {
    const h = createHarness({
      remotes: [ORIGIN],
      quickPickResponses: ['origin', 'Change URL', undefined],
      inputResponses: ['https://example.com/new.git'],
    });
    await runConfigureRemotesFlow(h.deps);
    assert.deepStrictEqual(h.opCalls, [
      { op: 'setUrl', args: ['origin', 'https://example.com/new.git'] },
    ]);
    // URL prompt is prefilled with the current URL.
    assert.strictEqual(h.inputBoxOptions[0].value, 'https://example.com/origin.git');
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
      inputResponses: ['upstream', 'https://example.com/u.git'],
      addError: new Error('fatal: remote upstream already exists'),
    });
    await runConfigureRemotesFlow(h.deps);
    assert.strictEqual(h.errorMessages.length, 1);
    assert.ok(h.errorMessages[0].includes('already exists'));
    // Flow loops back to the list after the error.
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
