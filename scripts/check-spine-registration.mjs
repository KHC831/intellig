#!/usr/bin/env node
/**
 * Structural CI guard — new commands register through the command spine.
 *
 * Maintenance contract (per ADR-007 section "Guard maintenance contract"):
 *
 * 1. Bug class
 *    Hand-rolled command handlers re-implement (and forget) the invariants
 *    the spine centralizes: the services guard, the (clickedUri,
 *    selectedUris[]) selection contract, resolveRepo, and the failure-toast
 *    backstop. One forgotten piece = a palette crash, a dropped multi-select,
 *    or a silent no-op — seventeen such commands shipped before the spine
 *    existed. The registration modules are fully migrated; this guard keeps
 *    the next command on the spine.
 *
 * 2. Heuristic + how it scales
 *    Scope: src/commands/registration/*.ts + src/extension.ts (the spine's
 *    domain — thin command modules over ICommandContext). Any literal-id
 *    registerLoggedCommand / commands.registerCommand call there must carry
 *    a `spine-exempt: <reason>` comment within the four lines above the
 *    call. Exemptions are legitimate and documented in place (return-value
 *    contracts, dialog owners, pure routers, singleton togglers usable
 *    without services). Class-based context-menu surfaces
 *    (BranchContextMenuCommands, CommitContextMenuCommands) and view
 *    providers are OUT of scope: they have their own structured dispatch
 *    (tree-item / webview payload targeting) that the spine's scopes don't
 *    model; extending the spine there is a known follow-up (AGENT-HANDBOOK section 8).
 *
 * 3. Known false-positive cases
 *    A registration whose id literal sits more than one line below the call
 *    would be missed (never the prettier-formatted shape). None today.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src', 'commands', 'registration');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(dir, f));
files.push(join(root, 'src', 'extension.ts'));

const CALL = /(?:registerLoggedCommand|commands\.registerCommand)\(/;
const violations = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!CALL.test(lines[i])) continue;
    // The command id literal is on the call line or the next (prettier's
    // multi-line form). Only literal intellig.* ids are in scope — the
    // spine wrappers pass a VARIABLE id internally and never match.
    const idLine = `${lines[i]} ${lines[i + 1] ?? ''}`;
    const idMatch = idLine.match(/['"](intellig\.[^'"]+)['"]/);
    if (!idMatch) continue;
    const windowAbove = lines.slice(Math.max(0, i - 4), i).join('\n');
    if (!windowAbove.includes('spine-exempt:')) {
      violations.push(`  ${file.replace(root + '/', '')}:${i + 1} — ${idMatch[1]}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    'check-spine-registration: literal-id command registrations outside the spine.\n' +
      'Register through the command spine (src/commands/registration/commandSpine.ts:\n' +
      'registerSelectionCommand / registerFileCommand / registerRepoCommand /\n' +
      "registerBareCommand), or add a justified `// spine-exempt: <reason>` comment\n" +
      'within the four lines above the call:\n'
  );
  for (const v of violations) console.error(v);
  process.exit(1);
}
console.log('check-spine-registration: OK');
