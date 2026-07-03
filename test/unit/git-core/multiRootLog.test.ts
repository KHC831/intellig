/**
 * G8 — merged multi-root log view: the root column.
 *
 * IntelliJ parity (platform/vcs-log RootCellRenderer / NewUiRootCellRenderer):
 * the root column is a narrow colored stripe by default — one stable color per
 * repo root, consecutive same-root rows fused into one band via run classes,
 * the name only in the tooltip. The "show root names" mode widens the cell and
 * paints the basename on the root color. The provider only enables the column
 * when the workspace has more than one repository.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitRows } from '../../../src/git-core/gitToolWindow/provider/graphClusterBuilder';
import type { ICommitNode } from '../../../src/git-core/commitGraph';
import type { ICommit } from '../../../src/git-core/interfaces/IGitService';
import { mkRowModel } from '../../support/printModelTestKit';

// Minimal fake commit factory — covers only the fields buildCommitRows reads.
function makeCommit(overrides: Partial<ICommit> & { repoRoot?: string }): ICommit & {
  repoRoot?: string;
} {
  return {
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortHash: 'aaaaaaa',
    message: 'test commit',
    author: { name: 'Alice', email: 'alice@example.com' },
    committer: { name: 'Alice', email: 'alice@example.com' },
    parents: [],
    authorDate: new Date('2024-01-01T12:00:00Z'),
    commitDate: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

function makeNode(commit: ICommit & { repoRoot?: string }): ICommitNode {
  return {
    commit,
    graphColumn: 0,
    graphLines: [],
    branches: [],
    tags: [],
    onFocusedBranchPath: false,
  } as unknown as ICommitNode;
}

// Minimal ICommitRowData — all maps/sets empty, callback returns empty string.
function makeRowData(
  rowCount: number,
  extra: Partial<{
    showRootColumn: boolean;
    showRootNames: boolean;
  }> = {}
) {
  return {
    selected: new Set<string>(),
    cherryPickedHashes: undefined,
    cherryPickBaseRef: undefined,
    printModels: Array.from({ length: rowCount }, () => mkRowModel()),
    branchLabelsFor: () => '',
    showGpgColumn: false,
    ...extra,
  };
}

function nodesFor(roots: (string | undefined)[]): ICommitNode[] {
  return roots.map((repoRoot, i) =>
    makeNode(makeCommit({ hash: `${'a'.repeat(39)}${i}`, repoRoot }))
  );
}

function stripeCells(html: string): string[] {
  return html.match(/<span class="log-root-stripe[^"]*"[^>]*>/g) ?? [];
}

describe('buildCommitRows — root column stripe (G8)', () => {
  it('renders a colored stripe per row when showRootColumn is true', () => {
    const html = buildCommitRows(
      nodesFor(['/workspace/api-service', '/workspace/web']),
      makeRowData(2, { showRootColumn: true })
    );
    const cells = stripeCells(html);
    assert.strictEqual(cells.length, 2, 'one stripe per row');
    assert.ok(
      cells.every((c) => /background-color:/.test(c)),
      'every stripe carries its root color inline'
    );
    assert.ok(!html.includes('log-root-label'), 'the old text-prefix label is gone');
  });

  it('renders nothing root-related when showRootColumn is false', () => {
    const html = buildCommitRows(
      nodesFor(['/workspace/api-service']),
      makeRowData(1, { showRootColumn: false })
    );
    assert.ok(!html.includes('log-root'), 'no root cell of any kind');
  });

  it('keeps the name out of the row: basename + path live in the tooltip only', () => {
    const html = buildCommitRows(
      nodesFor(['/workspace/api-service', '/workspace/web']),
      makeRowData(2, { showRootColumn: true })
    );
    assert.ok(
      html.includes('title="api-service — /workspace/api-service"'),
      'tooltip carries basename and full path'
    );
    const stripe = html.match(/<span class="log-root-stripe[^"]*"[^>]*><\/span>/);
    assert.ok(stripe, 'the stripe itself is empty — no visible text');
  });

  it('fuses consecutive same-root rows into one band via run classes', () => {
    const html = buildCommitRows(
      nodesFor(['/w/a', '/w/a', '/w/b', '/w/a']),
      makeRowData(4, { showRootColumn: true })
    );
    const cells = stripeCells(html);
    assert.strictEqual(cells.length, 4);
    assert.ok(cells[0].includes('run-start'), 'first of a run opens the band');
    assert.ok(cells[1].includes('run-end'), 'last of a run closes the band');
    assert.ok(cells[2].includes('run-single'), 'a lone row is a single band');
    assert.ok(cells[3].includes('run-single'), 'a lone row after a different root is single');
  });

  it('gives the same root the same color on every build, and colors stay per-root', () => {
    const build = (): string[] =>
      stripeCells(
        buildCommitRows(
          nodesFor(['/w/a', '/w/b', '/w/a']),
          makeRowData(3, { showRootColumn: true })
        )
      );
    const [a1, b1, a2] = build();
    const colorOf = (cell: string): string => /background-color:\s*([^;"]+)/.exec(cell)?.[1] ?? '';
    assert.strictEqual(colorOf(a1), colorOf(a2), 'same root, same color within a build');
    const [a1Again] = build();
    assert.strictEqual(colorOf(a1), colorOf(a1Again), 'color is stable across builds');
    assert.notStrictEqual(colorOf(a1), '', 'a color is actually set');
    void b1;
  });

  it('renders an empty spacer for a commit with no repoRoot so rows stay aligned', () => {
    const html = buildCommitRows(
      nodesFor(['/w/a', undefined]),
      makeRowData(2, { showRootColumn: true })
    );
    const cellWraps = html.match(/<span class="log-root-cell[^"]*"/g) ?? [];
    assert.strictEqual(cellWraps.length, 2, 'every row gets the cell, rooted or not');
  });

  it('escapes HTML metacharacters in the tooltip path', () => {
    const html = buildCommitRows(
      nodesFor(['/w/x"onmouseover="1', '/w/b']),
      makeRowData(2, { showRootColumn: true })
    );
    assert.ok(!html.includes('"onmouseover="'), 'quote must not escape the title attribute');
    assert.ok(html.includes('&quot;onmouseover=&quot;'), 'escaped form present');
  });
});

describe('buildCommitRows — root column names mode (Show Root Names)', () => {
  it('paints the basename on the root color when showRootNames is true', () => {
    const html = buildCommitRows(
      nodesFor(['/workspace/api-service', '/workspace/web']),
      makeRowData(2, { showRootColumn: true, showRootNames: true })
    );
    const name = html.match(/<span class="log-root-name[^"]*"[^>]*>([^<]*)<\/span>/);
    assert.ok(name, 'names mode renders a log-root-name cell');
    assert.strictEqual(name[1], 'api-service', 'visible text is the basename, not the path');
    assert.ok(
      /log-root-name[^"]*"[^>]*style="[^"]*background-color:/.test(html),
      'the name cell carries the root color'
    );
    assert.strictEqual(stripeCells(html).length, 0, 'stripe and name modes are exclusive');
  });

  it('names mode still fuses runs', () => {
    const html = buildCommitRows(
      nodesFor(['/w/a', '/w/a']),
      makeRowData(2, { showRootColumn: true, showRootNames: true })
    );
    const cells = html.match(/<span class="log-root-name[^"]*"/g) ?? [];
    assert.ok(cells[0]?.includes('run-start'));
    assert.ok(cells[1]?.includes('run-end'));
  });
});
