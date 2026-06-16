/**
 * P1 #4 — sequence-editor glue around {@link transformRebaseTodo}.
 *
 * Verifies the editor reads git's real todo file, applies the plan from
 * `INTELLIG_REBASE_PLAN`, and writes the structural-line-preserving result
 * back in place — the fs/argv/env wiring that runs as GIT_SEQUENCE_EDITOR.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyPlanToTodoFile,
  runEditorMain,
  REBASE_PLAN_ENV,
} from '../../../git-core/rebaseTodoEditor';
import type { IRebaseAction } from '../../../git-core/interfaces/IRebaseService';

describe('rebaseTodoEditor (#4 sequence-editor glue)', () => {
  // Use .git/rebase-merge/ structure so applyPlanToTodoFile can derive the
  // git dir (for writing reword message files) via path.dirname(todoPath)/..
  let repoDir: string;
  let gitDir: string;
  let rebaseMergeDir: string;
  let todoPath: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-rebase-editor-'));
    gitDir = path.join(repoDir, '.git');
    rebaseMergeDir = path.join(gitDir, 'rebase-merge');
    fs.mkdirSync(rebaseMergeDir, { recursive: true });
    todoPath = path.join(rebaseMergeDir, 'git-rebase-todo');
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('applyPlanToTodoFile rewrites the todo in place, preserving update-ref', () => {
    fs.writeFileSync(
      todoPath,
      ['pick aaaaaaa first', 'update-ref refs/heads/topic', 'pick bbbbbbb second'].join('\n') + '\n'
    );
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'pick' },
      { hash: 'bbbbbbb', action: 'edit' },
    ];

    applyPlanToTodoFile(todoPath, plan);

    assert.strictEqual(
      fs.readFileSync(todoPath, 'utf8'),
      ['pick aaaaaaa first', 'update-ref refs/heads/topic', 'edit bbbbbbb second'].join('\n') + '\n'
    );
  });

  it('runEditorMain with newMessage writes message file and emits exec amend', () => {
    fs.writeFileSync(todoPath, 'pick aaaaaaa only commit\n');
    const plan: IRebaseAction[] = [
      { hash: 'aaaaaaa', action: 'reword', newMessage: 'My new message' },
    ];

    runEditorMain(['node', 'editor.js', todoPath], { [REBASE_PLAN_ENV]: JSON.stringify(plan) });

    const todoContent = fs.readFileSync(todoPath, 'utf8');
    assert.match(todoContent, /^pick aaaaaaa only commit\n/);
    assert.match(
      todoContent,
      /exec git commit --amend -F .git\/.intellig-reword-aaaaaaa\.txt --no-edit\n$/
    );

    // Message file must exist with the new message content.
    const msgFile = path.join(gitDir, '.intellig-reword-aaaaaaa.txt');
    assert.ok(fs.existsSync(msgFile), 'message file should have been written');
    assert.strictEqual(fs.readFileSync(msgFile, 'utf8'), 'My new message');
  });

  it('runEditorMain without newMessage emits classic reword (no exec)', () => {
    fs.writeFileSync(todoPath, 'pick aaaaaaa only commit\n');
    const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'reword' }];

    runEditorMain(['node', 'editor.js', todoPath], { [REBASE_PLAN_ENV]: JSON.stringify(plan) });

    assert.strictEqual(fs.readFileSync(todoPath, 'utf8'), 'reword aaaaaaa only commit\n');
  });

  it('runEditorMain throws when the plan env var is missing (git then aborts)', () => {
    fs.writeFileSync(todoPath, 'pick aaaaaaa only\n');
    assert.throws(() => runEditorMain(['node', 'editor.js', todoPath], {}), /not set/);
  });

  it('runEditorMain throws when no todo path argument is given', () => {
    assert.throws(
      () => runEditorMain(['node', 'editor.js'], { [REBASE_PLAN_ENV]: '[]' }),
      /no todo file path/
    );
  });
});
