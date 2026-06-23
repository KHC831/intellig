/**
 * Unit test: dragged divider + column widths survive a full re-render.
 *
 * The reset-on-select report is "the divider AND the Title/Author/Date columns
 * snap back to DEFAULT". Snapping to *default* (rather than to the dragged
 * value) means that whenever a full re-render does happen, it is NOT seeing the
 * user's dragged widths — i.e. the drag's `panelResize` / `columnResize`
 * messages never reached host state. This test drives those messages through the
 * real inbound dispatch (`_handleWebviewMessage`) and asserts a subsequent
 * render emits the dragged widths, not the defaults.
 */

import '../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../src/ui-shell/GitToolWindowProvider';
import { ICommit, IAuthor } from '../../src/git-core/interfaces/IGitService';
import { Uri } from '../mocks/vscode';
import { invokePrivateHandler } from '../typed/privateHandler';

const AUTHOR: IAuthor = { name: 'tester', email: 't@example.com' };

function mkCommit(hash: string): ICommit {
  const date = new Date(2020, 0, 1);
  return {
    hash,
    shortHash: hash.substring(0, 7),
    message: 'm',
    author: AUTHOR,
    committer: AUTHOR,
    parents: [],
    authorDate: date,
    commitDate: date,
  };
}

describe('dragged widths persist across a full re-render', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('panelResize then render emits the dragged divider widths', () => {
    void invokePrivateHandler(provider, '_handleWebviewMessage', {
      type: 'panelResize',
      widths: [62, 38],
    });

    assert.deepStrictEqual(
      provider.getPanelWidths(),
      [62, 38],
      'panelResize must update host panel-width state'
    );

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const html = (provider as any)._getThreePanelHtmlContent(
      { cspSource: 'test:', asWebviewUri: (u: unknown) => u },
      []
    ) as string;
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

    assert.ok(
      html.includes('width: 62%'),
      'graph panel must render at the dragged width, not the default'
    );
    assert.ok(html.includes('width: 38%'), 'details panel must render at the dragged width');
  });

  it('columnResize then render emits the dragged Author/Date column widths', () => {
    // Seed a commit so the populated graph-panel renderer (which carries the
    // column-width custom properties) is exercised, not the empty-state one.
    provider.updateLogState([mkCommit('a'.repeat(40))], new Map(), new Map(), 'a'.repeat(40));

    void invokePrivateHandler(provider, '_handleWebviewMessage', {
      type: 'columnResize',
      widths: [205, 175],
    });

    assert.deepStrictEqual(
      provider.getColumnWidths(),
      [205, 175],
      'columnResize must update host column-width state'
    );

    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
    const nodes = (provider.getExtendedLogState() as any).commitNodes;
    const graphHtml = (provider as any)._getGraphPanelHtml(nodes) as string;
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

    assert.ok(
      graphHtml.includes('--col-author-width: 205px'),
      'author column must render at the dragged width, not the default'
    );
    assert.ok(
      graphHtml.includes('--col-date-width: 175px'),
      'date column must render at the dragged width'
    );
  });
});
