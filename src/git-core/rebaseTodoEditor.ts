/**
 * Sequence-editor entry point for interactive rebase.
 *
 * `git rebase -i` invokes `GIT_SEQUENCE_EDITOR <git-rebase-todo>`; this module
 * is that editor. It reads git's REAL todo (the only place the `update-ref` /
 * `label` / `reset` / `merge` / `exec` structural lines exist), applies the
 * user's plan via {@link transformRebaseTodo}, and writes the result back in
 * place — never rebuilding from scratch, so those structural lines survive
 * (IntelliJ git4idea parity; see rebaseTodo.ts).
 *
 * The plan arrives as JSON in `INTELLIG_REBASE_PLAN` (an env var, not an argv —
 * git appends the todo path as the sole argument, and a JSON blob on the
 * command line would need shell-escaping). RebaseService spawns this under the
 * VS Code Electron binary with `ELECTRON_RUN_AS_NODE=1`.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  transformRebaseTodo,
  hasInlineMessageOverride,
  messageOverrideFileName,
} from './rebaseTodo';
import type { IRebaseAction } from './interfaces/IRebaseService';

/** Env var carrying the JSON-encoded {@link IRebaseAction}[] plan. */
export const REBASE_PLAN_ENV = 'INTELLIG_REBASE_PLAN';

/**
 * Apply a rebase plan to git's todo file in place.
 *
 * @param todoPath - Path to git's `git-rebase-todo` (the editor's argument).
 * @param plan - The ordered actions to apply.
 */
export function applyPlanToTodoFile(todoPath: string, plan: IRebaseAction[]): void {
  // Write pre-set message files for reword entries before transforming the
  // todo. The exec lines reference these files by path relative to the repo
  // root, so they must exist when git runs the exec commands.
  const gitDir = path.resolve(path.dirname(todoPath), '..');
  for (const entry of plan) {
    // Only write a message file for a non-blank reword/squash override; a blank
    // one falls back to git's classic interactive editor (see
    // hasInlineMessageOverride), so writing an empty -F file that would abort
    // the amend is avoided.
    if (hasInlineMessageOverride(entry)) {
      const msgFile = path.join(gitDir, messageOverrideFileName(entry.hash));
      fs.writeFileSync(msgFile, entry.newMessage as string, 'utf8');
    }
  }
  const original = fs.readFileSync(todoPath, 'utf8');
  const transformed = transformRebaseTodo(original, plan, gitDir);
  fs.writeFileSync(todoPath, transformed, 'utf8');
}

/**
 * Editor `main`: read the plan from the environment and the todo path from
 * argv, then rewrite the todo. Throws (non-zero exit) on any failure so git
 * aborts the rebase rather than replaying a half-edited plan.
 *
 * @param argv - Process argv (todo path is the last element).
 * @param env - Process environment (carries {@link REBASE_PLAN_ENV}).
 */
export function runEditorMain(argv: string[], env: NodeJS.ProcessEnv): void {
  // git invokes `<editor> <todo-path>`, so under `node <script> <todo-path>`
  // the path is argv[2]: argv must carry at least one argument past the
  // node-binary + script pair.
  if (argv.length < 3) {
    throw new Error('rebase-todo editor: no todo file path argument');
  }
  const todoPath = argv[argv.length - 1];
  const planJson = env[REBASE_PLAN_ENV];
  if (!planJson) {
    throw new Error(`rebase-todo editor: ${REBASE_PLAN_ENV} is not set`);
  }
  const plan = JSON.parse(planJson) as IRebaseAction[];
  applyPlanToTodoFile(todoPath, plan);
}

// Run as a script when invoked directly (node out/git-core/rebaseTodoEditor.js
// <todofile>). The `require.main === module` guard keeps this inert when the
// file is imported as a library (e.g. by the unit tests above).
if (require.main === module) {
  try {
    runEditorMain(process.argv, process.env);
  } catch (error) {
    process.stderr.write(`rebase-todo editor failed: ${String(error)}\n`);
    process.exit(1);
  }
}
