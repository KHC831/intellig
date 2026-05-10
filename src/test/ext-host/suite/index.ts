/**
 * Mocha entry point for the Extension Host smoke suite (R6 Gap-A).
 *
 * Only loads specs from this folder — does NOT recurse into `src/test/unit/`
 * or `src/test/property/` (those use a vscode-mock harness and must not run
 * inside the real extension host).
 */

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    // Budget: whole suite under 2 minutes. Give each spec generous headroom;
    // the aggregate budget is still enforced by the caller.
    timeout: 30_000,
    reporter: 'spec',
  });

  const suiteRoot = __dirname;
  for (const file of findTestFiles(suiteRoot)) {
    mocha.addFile(file);
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} ext-host smoke test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}
