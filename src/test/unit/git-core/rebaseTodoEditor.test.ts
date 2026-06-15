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
  let dir: string;
  let todoPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-rebase-editor-'));
    todoPath = path.join(dir, 'git-rebase-todo');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
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

  it('runEditorMain reads the plan from the env var and the path from argv', () => {
    fs.writeFileSync(todoPath, 'pick aaaaaaa only commit\n');
    const plan: IRebaseAction[] = [{ hash: 'aaaaaaa', action: 'reword', newMessage: 'x' }];

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
