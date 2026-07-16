/**
 * StashView / ShelfView singleton factory — the ONE creation seam.
 *
 * Three scattered creation sites used to carry drifted dependency sets (the
 * palette fallbacks omitted the conflict service, silently dropping the
 * Resolve-Conflicts arm if activation order ever changed). These pins hold
 * the factory contract: full dependency set on create, singleton reuse, and
 * disposal registration.
 */

import '../../setup';
import * as assert from 'assert';
import { ensureStashView, ensureShelfView } from '../../../src/shelf/viewSingletons';
import type {
  IStashShelfViewHost,
  IStashShelfViewServices,
} from '../../../src/shelf/viewSingletons';
import type { StashView } from '../../../src/shelf/StashView';
import type { ShelfView } from '../../../src/shelf/ShelfView';
import type * as vscode from 'vscode';

function makeHost(): IStashShelfViewHost & { subscriptions: unknown[] } {
  const subscriptions: unknown[] = [];
  return {
    context: { subscriptions } as unknown as vscode.ExtensionContext,
    stashView: undefined,
    shelfView: undefined,
    subscriptions,
  };
}

function makeServices(): IStashShelfViewServices {
  return {
    gitService: {
      getStatus: async (): Promise<never[]> => [],
    } as unknown as IStashShelfViewServices['gitService'],
    shelfService: {
      onDidChangeShelf: (): { dispose(): void } => ({ dispose: (): void => {} }),
    } as unknown as IStashShelfViewServices['shelfService'],
    conflictResolutionService: {
      marker: 'conflict-svc',
    } as unknown as IStashShelfViewServices['conflictResolutionService'],
    changelistService: {} as unknown as IStashShelfViewServices['changelistService'],
  };
}

describe('stash/shelf view singleton factory', () => {
  it('creates the StashView WITH the conflict service and registers disposal', () => {
    const host = makeHost();
    const services = makeServices();
    const view = ensureStashView(host, services);
    assert.strictEqual(host.stashView, view, 'written back to the host slot');
    assert.strictEqual(
      (view as unknown as { _conflictResolutionService: unknown })._conflictResolutionService,
      services.conflictResolutionService,
      'the conflict-dialog arm must never be dropped by a creation site'
    );
    assert.ok(host.subscriptions.includes(view), 'registered for disposal');
    view.dispose();
  });

  it('creates the ShelfView WITH conflict + changelist services and registers disposal', () => {
    const host = makeHost();
    const services = makeServices();
    const view = ensureShelfView(host, services);
    assert.strictEqual(host.shelfView, view);
    assert.strictEqual(
      (view as unknown as { _conflictResolutionService: unknown })._conflictResolutionService,
      services.conflictResolutionService
    );
    assert.ok(host.subscriptions.includes(view), 'registered for disposal');
    view.dispose();
  });

  it('returns the existing singleton on later calls (no re-create)', () => {
    const host = makeHost();
    const services = makeServices();
    const stash1: StashView = ensureStashView(host, services);
    const stash2: StashView = ensureStashView(host, services);
    const shelf1: ShelfView = ensureShelfView(host, services);
    const shelf2: ShelfView = ensureShelfView(host, services);
    assert.strictEqual(stash1, stash2);
    assert.strictEqual(shelf1, shelf2);
    assert.strictEqual(host.subscriptions.length, 2, 'each view registered exactly once');
    stash1.dispose();
    shelf1.dispose();
  });
});
