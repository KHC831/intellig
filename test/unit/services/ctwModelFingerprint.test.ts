/**
 * Unit tests for the CTW render-model fingerprint.
 *
 * The fingerprint gates every live push: equal models must collide (so no-op
 * service events post nothing), a composer-only delta must collide (a lagging
 * host mirror must neither trigger nor suppress a push, I7), and any delta in
 * the rendered tree/shelf/selection state must differ.
 */

import '../../setup';
import * as assert from 'assert';
import { fingerprintCtwModel } from '../../../src/commits/ctwModelFingerprint';
import { buildCommitToolWindowInitModel } from '../../../src/commits/CommitToolWindow';
import type { IRenderInput } from '../../../src/commits/CommitToolWindow';
import type { IChangelist } from '../../../src/changelists/interfaces/IChangelistService';

function makeChangelist(name: string, files: string[]): IChangelist {
  return {
    id: name,
    name,
    isDefault: true,
    isActive: true,
    files: files.map((path) => ({ path, status: 'modified' as const, staged: false })),
  };
}

function makeInput(overrides: Partial<IRenderInput> = {}): IRenderInput {
  return {
    activeTab: 'localChanges',
    changelists: [makeChangelist('Changes', ['src/a.ts', 'src/b.ts'])],
    shelfItems: [],
    shelfTabFilter: 'both',
    composer: { message: '', amend: false, signOff: false },
    activeChangelistId: 'Changes',
    grouping: 'flat',
    selectedFiles: ['src/a.ts'],
    ...overrides,
  };
}

describe('CommitToolWindow — fingerprintCtwModel', () => {
  it('two builds of the same input produce the same fingerprint', () => {
    const a = fingerprintCtwModel(buildCommitToolWindowInitModel(makeInput()));
    const b = fingerprintCtwModel(buildCommitToolWindowInitModel(makeInput()));
    assert.strictEqual(a, b);
  });

  it('a composer-only delta produces the SAME fingerprint (I7: composer excluded)', () => {
    const quiet = fingerprintCtwModel(buildCommitToolWindowInitModel(makeInput()));
    const typing = fingerprintCtwModel(
      buildCommitToolWindowInitModel(
        makeInput({ composer: { message: 'half-typed wip', amend: true, signOff: true } })
      )
    );
    assert.strictEqual(typing, quiet, 'composer state must not participate in the fingerprint');
  });

  // The host DROPS any repo-scoped message whose stamp is not the current
  // target, and the webview only learns its stamp from a pushed model. So a
  // retarget that produces an identical model must still push: two clean repos
  // in a multi-root workspace differ in nothing else, and skipping the push
  // leaves the view holding the previous repo's stamp with every action —
  // including Commit — silently dropped and no way to recover.
  it('a repoRoot delta produces a different fingerprint', () => {
    const a = buildCommitToolWindowInitModel(makeInput({ repoRoot: '/repo/a' }));
    const b = buildCommitToolWindowInitModel(makeInput({ repoRoot: '/repo/b' }));
    assert.notStrictEqual(
      fingerprintCtwModel(a),
      fingerprintCtwModel(b),
      'a field the host guards on is part of what makes a model distinct'
    );
  });

  it('a changelist-content delta produces a different fingerprint', () => {
    const before = fingerprintCtwModel(buildCommitToolWindowInitModel(makeInput()));
    const after = fingerprintCtwModel(
      buildCommitToolWindowInitModel(
        makeInput({ changelists: [makeChangelist('Changes', ['src/a.ts', 'src/c.ts'])] })
      )
    );
    assert.notStrictEqual(after, before);
  });

  it('a selection delta produces a different fingerprint', () => {
    const before = fingerprintCtwModel(buildCommitToolWindowInitModel(makeInput()));
    const after = fingerprintCtwModel(
      buildCommitToolWindowInitModel(makeInput({ selectedFiles: ['src/a.ts', 'src/b.ts'] }))
    );
    assert.notStrictEqual(after, before);
  });

  it('activeTab / grouping / shelf-filter deltas produce different fingerprints', () => {
    const base = fingerprintCtwModel(buildCommitToolWindowInitModel(makeInput()));
    const tab = fingerprintCtwModel(
      buildCommitToolWindowInitModel(makeInput({ activeTab: 'shelf' }))
    );
    const grouping = fingerprintCtwModel(
      buildCommitToolWindowInitModel(makeInput({ grouping: 'directory' }))
    );
    const filter = fingerprintCtwModel(
      buildCommitToolWindowInitModel(makeInput({ shelfTabFilter: 'stashes' }))
    );
    assert.notStrictEqual(tab, base);
    assert.notStrictEqual(grouping, base);
    assert.notStrictEqual(filter, base);
  });

  it('is stable across file order in the input (builder sorts; same set → same print)', () => {
    // The builder's directory grouping sorts buckets and files; the same file
    // SET arriving in a different order collides to one fingerprint.
    const a = fingerprintCtwModel(
      buildCommitToolWindowInitModel(
        makeInput({
          grouping: 'directory',
          changelists: [makeChangelist('Changes', ['src/x/one.ts', 'src/y/two.ts'])],
        })
      )
    );
    const b = fingerprintCtwModel(
      buildCommitToolWindowInitModel(
        makeInput({
          grouping: 'directory',
          changelists: [makeChangelist('Changes', ['src/y/two.ts', 'src/x/one.ts'])],
        })
      )
    );
    assert.strictEqual(a, b);
  });
});
