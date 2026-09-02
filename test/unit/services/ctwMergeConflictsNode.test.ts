/**
 * The Merge Conflicts group node in the Commit tool window (issue #5).
 *
 * IntelliJ lifts every unmerged file out of its normal changelist position
 * and reparents it under a bold "Merge Conflicts" header holding its own
 * Resolve link (`DefaultChangesGroupingPolicy` + `ChangesBrowserConflictsNode`);
 * this is that node's render model.
 */

import '../../setup';
import * as assert from 'assert';
import { buildCommitToolWindowInitModel } from '../../../src/commits/CommitToolWindow';
import { countConflictRegions } from '../../../src/commits/ctwChangesTree';
import type {
  IChangelist,
  IFileChange,
} from '../../../src/changelists/interfaces/IChangelistService';

const composer = { message: '', amend: false, signOff: false };

function file(path: string, status: IFileChange['status']): IFileChange {
  return { path, status, staged: false };
}

function changelist(id: string, files: IFileChange[]): IChangelist {
  return {
    id,
    name: id === 'default' ? 'Changes' : id,
    files,
    description: '',
    isDefault: id === 'default',
    isActive: id === 'default',
  };
}

function build(changelists: IChangelist[], grouping: 'flat' | 'directory' = 'flat') {
  return buildCommitToolWindowInitModel({
    activeTab: 'localChanges',
    changelists,
    shelfItems: [],
    composer,
    activeChangelistId: 'default',
    grouping,
  });
}

describe('Commit tool window — Merge Conflicts node', () => {
  it('has no conflicts node when nothing is unmerged', () => {
    const model = build([changelist('default', [file('a.ts', 'modified')])]);
    assert.strictEqual(model.local.changelists[0].conflicts, null);
  });

  it('lifts unmerged files under a conflicts node carrying a count', () => {
    const model = build([
      changelist('default', [
        file('pom.xml', 'modified'),
        file('src/net/Service.java', 'conflicted'),
        file('config.yaml', 'conflicted'),
      ]),
    ]);

    assert.ok(model.local.changelists[0].conflicts, 'conflicts node must exist');
    assert.strictEqual(model.local.changelists[0].conflicts.fileCount, 2);
    assert.deepStrictEqual(
      model.local.changelists[0].conflicts.files.map((f) => f.path),
      ['config.yaml', 'src/net/Service.java'],
      'conflicted rows are alpha-sorted, independent of changelist order'
    );
  });

  it('removes the lifted files from their changelist so no row renders twice', () => {
    const model = build([
      changelist('default', [file('pom.xml', 'modified'), file('Service.java', 'conflicted')]),
    ]);

    const cl = model.local.changelists[0];
    assert.deepStrictEqual(
      (cl.files ?? []).map((f) => f.path),
      ['pom.xml'],
      'the conflicted file left the ordinary bucket'
    );
    assert.deepStrictEqual(
      cl.conflicts?.files.map((f) => f.path),
      ['Service.java'],
      'and appears once, in the conflicts node'
    );
    assert.strictEqual(cl.fileCount, 2, 'the count still covers every file the list owns');
  });

  it('keeps each lifted row pointing at the changelist it came from', () => {
    const model = build([
      changelist('default', [file('a.java', 'conflicted')]),
      changelist('feature-work', [file('b.java', 'conflicted')]),
    ]);

    const rows = model.local.changelists.flatMap((c) => c.conflicts?.files ?? []);
    const byPath = new Map(rows.map((f) => [f.path, f.changelistId]));
    assert.strictEqual(byPath.get('a.java'), 'default');
    assert.strictEqual(byPath.get('b.java'), 'feature-work');
  });

  it('marks lifted entries conflicted so the row can render its own affordances', () => {
    const model = build([changelist('default', [file('Service.java', 'conflicted')])]);
    assert.strictEqual(model.local.changelists[0].conflicts!.files[0].conflicted, true);
    assert.strictEqual(model.local.changelists[0].conflicts!.files[0].statusChar, 'U');
  });

  it('lifts out of directory grouping too, and shows full paths in the node', () => {
    const model = build(
      [
        changelist('default', [
          file('src/net/Service.java', 'conflicted'),
          file('src/net/Router.java', 'modified'),
        ]),
      ],
      'directory'
    );

    assert.deepStrictEqual(
      model.local.changelists[0].conflicts!.files.map((f) => f.displayName),
      ['src/net/Service.java'],
      'the conflicts node is flat: a lifted row shows where it lives'
    );
    const remaining = (model.local.changelists[0].dirGroups ?? []).flatMap((g) => g.files);
    assert.deepStrictEqual(
      remaining.map((f) => f.path),
      ['src/net/Router.java']
    );
  });

  it('KEEPS a changelist that holds nothing but conflicts', () => {
    // IntelliJ nests the conflicts node inside the changelist subtree
    // (SimpleChangesGroupingPolicy inserts under subtreeRoot), so the header
    // always survives. Dropping it took the list's own actions — Set Active,
    // Rename, Commit Only This Changelist — down with it, and its "(Active)"
    // marker vanished from the whole view.
    const model = build([
      changelist('default', [file('a.java', 'conflicted')]),
      changelist('other', [file('b.ts', 'modified')]),
    ]);

    assert.deepStrictEqual(
      model.local.changelists.map((c) => c.id),
      ['default', 'other'],
      'a conflicts-only changelist must not vanish'
    );
    const conflictsOnly = model.local.changelists[0];
    assert.strictEqual(conflictsOnly.conflicts?.fileCount, 1);
    assert.deepStrictEqual(conflictsOnly.files, [], 'its ordinary bucket is empty');
    assert.strictEqual(conflictsOnly.fileCount, 1, 'the count still covers every file it owns');
    assert.strictEqual(conflictsOnly.isActive, true, 'and it is still the active list');
  });

  it('gives each changelist its OWN conflicts node', () => {
    const model = build([
      changelist('default', [file('a.java', 'conflicted')]),
      changelist('feature-work', [file('b.java', 'conflicted'), file('c.ts', 'modified')]),
    ]);

    const byId = new Map(model.local.changelists.map((c) => [c.id, c]));
    assert.deepStrictEqual(
      byId.get('default')?.conflicts?.files.map((f) => f.path),
      ['a.java']
    );
    assert.deepStrictEqual(
      byId.get('feature-work')?.conflicts?.files.map((f) => f.path),
      ['b.java'],
      'a conflict belongs to its own list, not pooled across all of them'
    );
    assert.deepStrictEqual(
      byId.get('feature-work')?.files?.map((f) => f.path),
      ['c.ts']
    );
  });

  it('carries the conflict-region count onto the row when the host supplies one', () => {
    const model = buildCommitToolWindowInitModel({
      activeTab: 'localChanges',
      changelists: [
        changelist('default', [file('Service.java', 'conflicted'), file('c.yaml', 'conflicted')]),
      ],
      shelfItems: [],
      composer,
      activeChangelistId: 'default',
      grouping: 'flat',
      conflictRegionCounts: new Map([
        ['Service.java', 3],
        ['c.yaml', 1],
      ]),
    });
    const byPath = new Map(
      model.local.changelists[0].conflicts!.files.map((f) => [f.path, f.conflictCount])
    );
    assert.strictEqual(byPath.get('Service.java'), 3);
    assert.strictEqual(byPath.get('c.yaml'), 1);
  });

  it('leaves the count off a file with nothing to count, rather than showing zero', () => {
    // A binary or delete/modify conflict has no markers; a row reading
    // "0 conflicts" would be worse than a row with no count at all.
    const model = buildCommitToolWindowInitModel({
      activeTab: 'localChanges',
      changelists: [changelist('default', [file('logo.png', 'conflicted')])],
      shelfItems: [],
      composer,
      activeChangelistId: 'default',
      grouping: 'flat',
      conflictRegionCounts: new Map([['logo.png', 0]]),
    });
    assert.strictEqual(model.local.changelists[0].conflicts!.files[0].conflictCount, undefined);
  });

  it('leaves the count off when the host supplied none at all', () => {
    const model = build([changelist('default', [file('a.java', 'conflicted')])]);
    assert.strictEqual(model.local.changelists[0].conflicts!.files[0].conflictCount, undefined);
  });

  it('does not treat unversioned files as conflicts', () => {
    const model = build([
      changelist('default', [file('scratch.txt', 'untracked'), file('a.java', 'conflicted')]),
    ]);
    assert.deepStrictEqual(
      model.local.changelists[0].conflicts!.files.map((f) => f.path),
      ['a.java']
    );
    assert.ok(model.local.unversioned, 'untracked files keep their own pseudo-changelist');
  });
});

/**
 * The per-file conflict-region count on a lifted row.
 *
 * Counts the regions git itself marked up, which is what the merge window will
 * show you. Never used to decide WHETHER a file is conflicted — that stays the
 * index's job — only how many hunks are waiting inside one that already is.
 */
describe('countConflictRegions', () => {
  it('counts one region', () => {
    assert.strictEqual(
      countConflictRegions('a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\nb\n'),
      1
    );
  });

  it('counts each region separately', () => {
    const text = [
      'head',
      '<<<<<<< HEAD',
      'one-mine',
      '=======',
      'one-theirs',
      '>>>>>>> other',
      'middle',
      '<<<<<<< HEAD',
      'two-mine',
      '=======',
      'two-theirs',
      '>>>>>>> other',
      'tail',
    ].join('\n');
    assert.strictEqual(countConflictRegions(text), 2);
  });

  it('is unmoved by diff3 style, which adds a base section but no new region', () => {
    const text = [
      '<<<<<<< HEAD',
      'mine',
      '||||||| base',
      'original',
      '=======',
      'theirs',
      '>>>>>>> other',
    ].join('\n');
    assert.strictEqual(countConflictRegions(text), 1);
  });

  it('counts nothing in a file with no markers', () => {
    assert.strictEqual(countConflictRegions('just\nsome\nlines\n'), 0);
  });

  it('ignores a marker that is not at the start of a line', () => {
    // A string literal or a doc line about merge conflicts is not a region.
    assert.strictEqual(countConflictRegions('const s = "<<<<<<< HEAD";\n'), 0);
    assert.strictEqual(countConflictRegions('  <<<<<<< indented\n'), 0);
  });

  it('reads CRLF files the same as LF', () => {
    assert.strictEqual(
      countConflictRegions('a\r\n<<<<<<< HEAD\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> x\r\n'),
      1
    );
  });

  it('requires exactly seven angle brackets', () => {
    // Git writes seven. Fewer or more is someone's text, not a conflict.
    assert.strictEqual(countConflictRegions('<<<<<< HEAD\n'), 0);
    assert.strictEqual(countConflictRegions('<<<<<<<< HEAD\n'), 0);
  });
});
