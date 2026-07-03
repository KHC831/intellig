/**
 * Smoke test 10 — bare invocation of EVERY declared command (R9).
 *
 * VS Code can deliver a command with NO arguments: a `view/item/context`
 * click racing a tree refresh, a keybinding, a macro extension, or a plain
 * `executeCommand(id)`. Two live crashes came from exactly this shape
 * ("Cannot read properties of undefined (reading 'branch')"), and no
 * in-process suite can prove the real host wiring survives it — the unit
 * mocks swallow rejections the host surfaces.
 *
 * Contract asserted here: invoking any contributed command with no
 * arguments must not REJECT within the observation window. Hanging is
 * legitimate (pickers and input boxes wait for a user); rejecting is not —
 * a rejection here is precisely the "Error running command …" toast a user
 * would see.
 *
 * The host runs with no workspace folder, so repo-scoped commands bail
 * through their no-repo paths — which is itself the cold-surface contract
 * the R8 palette audit pinned.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

const EXT_ID = 'KaHoChan.intellig';

/** How long a command gets to reject before we call it well-behaved. */
const REJECTION_WINDOW_MS = 75;

describe('ext-host smoke — 10. bare command invocation', function () {
  this.timeout(120_000);

  it('no contributed command rejects when invoked with no arguments', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `Extension ${EXT_ID} not installed in host`);
    await ext.activate();

    const manifestPath = path.join(ext.extensionPath, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      contributes?: { commands?: Array<{ command: string }> };
    };
    const declared = (manifest.contributes?.commands ?? []).map((c) => c.command);
    assert.ok(declared.length > 0, 'package.json declared no commands');

    const rejections: Array<{ id: string; message: string }> = [];

    for (const id of declared) {
      let settledWithin = false;
      const invocation = Promise.resolve(vscode.commands.executeCommand(id)).then(
        () => {
          settledWithin = true;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!settledWithin) {
            rejections.push({ id, message });
          }
        }
      );
      // Give the handler a beat to reject synchronously or in its first
      // await; a command still pending after the window is presumed to be
      // waiting on UI (picker/input/dialog), which is fine. The catch above
      // stays attached, so a LATE rejection never becomes an unhandled one.
      await Promise.race([invocation, new Promise((r) => setTimeout(r, REJECTION_WINDOW_MS))]);
      settledWithin = true;
    }

    assert.deepStrictEqual(
      rejections.map((r) => `${r.id}: ${r.message}`),
      [],
      'commands must never reject on a bare invocation'
    );
  });
});
