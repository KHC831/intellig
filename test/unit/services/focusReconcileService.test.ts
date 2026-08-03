/**
 * Unit tests for FocusReconcileService: when the window regains focus, probe
 * each repository's live ref listing against the last known snapshot and
 * reload on drift — the IntelliJ frame-activation sync
 * (SaveAndSyncHandlerImpl reacts to ApplicationActivationListener with a VFS
 * refresh of all roots; git4idea's GitRepositoryUpdater consumes the events),
 * so external .git changes heal even if the file watcher missed them.
 */

import '../../setup';
import * as assert from 'assert';
import { IBranch, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { FocusReconcileService } from '../../../src/sync/FocusReconcileService';
import { EventEmitter, Uri } from '../../mocks/vscode';

function makeRepo(path: string): IRepository {
  return {
    rootUri: Uri.file(path),
    state: 'idle',
    head: { name: 'refs/heads/main' },
    remotes: [],
  } as unknown as IRepository;
}

function branch(name: string, commit: string, type: 'local' | 'remote' = 'local'): IBranch {
  return { name, type, commit, isHead: name === 'main' };
}

interface Harness {
  service: FocusReconcileService;
  focus: () => void;
  repoChanged: (repo: IRepository) => void;
  setBranches: (rootPath: string, branches: IBranch[]) => void;
  reloadCalls: string[];
  branchListCalls: string[];
  advance: (ms: number) => void;
  setEnabled: (v: boolean) => void;
}

function makeHarness(repos: IRepository[]): Harness {
  const focusEmitter = new EventEmitter<void>();
  const changeEmitter = new EventEmitter<IRepository>();
  const branchesByRoot = new Map<string, IBranch[]>();
  const reloadCalls: string[] = [];
  const branchListCalls: string[] = [];
  let clock = 1_000_000;
  let enabled = true;

  const gitService = {
    getRepositories: () => repos,
    getBranches: (repo: IRepository) => {
      branchListCalls.push(repo.rootUri.fsPath);
      return Promise.resolve(branchesByRoot.get(repo.rootUri.fsPath) ?? []);
    },
    reloadRepository: (repo: IRepository) => {
      reloadCalls.push(repo.rootUri.fsPath);
      // Production reloads fire onDidChangeRepository; the harness mirrors
      // that so snapshot-invalidation-on-reload is part of every drift test.
      changeEmitter.fire(repo);
      return Promise.resolve(repo);
    },
    onDidChangeRepository: changeEmitter.event,
  };

  const service = new FocusReconcileService(gitService, {
    readEnabled: () => enabled,
    onDidFocus: (listener) => focusEmitter.event(() => listener()),
    now: () => clock,
  });

  return {
    service,
    focus: () => focusEmitter.fire(),
    repoChanged: (repo) => changeEmitter.fire(repo),
    setBranches: (rootPath, branches) => branchesByRoot.set(rootPath, branches),
    reloadCalls,
    branchListCalls,
    advance: (ms) => {
      clock += ms;
    },
    setEnabled: (v) => {
      enabled = v;
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('FocusReconcileService', () => {
  it('primes silently on the first focus (no reload)', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);

    h.focus();
    await flush();

    assert.deepStrictEqual(h.branchListCalls, ['/r1']);
    assert.strictEqual(h.reloadCalls.length, 0);
    h.service.dispose();
  });

  it('reloads only the drifted repo on a later focus', async () => {
    const h = makeHarness([makeRepo('/r1'), makeRepo('/r2')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);
    h.setBranches('/r2', [branch('main', 'c'.repeat(40))]);

    h.focus();
    await flush();
    // External change in /r1 only: a new agent branch appears.
    h.setBranches('/r1', [branch('main', 'a'.repeat(40)), branch('dev/fix', 'b'.repeat(40))]);
    h.advance(10_000);
    h.focus();
    await flush();

    assert.deepStrictEqual(h.reloadCalls, ['/r1']);
    h.service.dispose();
  });

  it('does not reload when nothing drifted', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);

    h.focus();
    await flush();
    h.advance(10_000);
    h.focus();
    await flush();

    assert.strictEqual(h.reloadCalls.length, 0);
    h.service.dispose();
  });

  it('detects a branch tip move, not just add/remove', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);

    h.focus();
    await flush();
    h.setBranches('/r1', [branch('main', 'b'.repeat(40))]);
    h.advance(10_000);
    h.focus();
    await flush();

    assert.deepStrictEqual(h.reloadCalls, ['/r1']);
    h.service.dispose();
  });

  it('drops the snapshot when the repository reloads through other paths', async () => {
    const repo = makeRepo('/r1');
    const h = makeHarness([repo]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);

    h.focus();
    await flush();
    // A watcher-driven reload already delivered this change to the views;
    // the next focus must re-prime, not issue a redundant reload.
    h.setBranches('/r1', [branch('main', 'b'.repeat(40))]);
    h.repoChanged(repo);
    h.advance(10_000);
    h.focus();
    await flush();

    assert.strictEqual(h.reloadCalls.length, 0);
    h.service.dispose();
  });

  it('rate-limits probes on rapid focus flapping', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);

    h.focus();
    await flush();
    h.advance(1_000);
    h.focus();
    await flush();

    assert.deepStrictEqual(h.branchListCalls, ['/r1']);
    h.service.dispose();
  });

  it('treats an empty listing as unknown: no prime, no reload', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', []);

    h.focus();
    await flush();
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);
    h.advance(10_000);
    h.focus();
    await flush();

    // The first (empty) listing must not become a baseline that makes the
    // first real listing read as drift.
    assert.strictEqual(h.reloadCalls.length, 0);
    h.service.dispose();
  });

  it('does nothing when autorefresh is disabled', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);
    h.setEnabled(false);

    h.focus();
    await flush();

    assert.strictEqual(h.branchListCalls.length, 0);
    h.service.dispose();
  });

  it('ignores focus events after dispose', async () => {
    const h = makeHarness([makeRepo('/r1')]);
    h.setBranches('/r1', [branch('main', 'a'.repeat(40))]);
    h.service.dispose();

    h.focus();
    await flush();

    assert.strictEqual(h.branchListCalls.length, 0);
  });
});
