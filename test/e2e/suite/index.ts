/**
 * Mocha entry point for the Tier-2 command E2E suite.
 *
 * Only loads specs from this folder. Per-test timeout is generous (15s) to
 * cover the worst case of a `git fetch` over a local file:// remote on a
 * cold machine; aggregate wall time is enforced by the caller.
 */

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 15_000,
    reporter: 'spec',
  });

  // Optional focus filter for local iteration: `E2E_GREP="<pattern>"`.
  if (process.env.E2E_GREP) {
    mocha.grep(process.env.E2E_GREP);
  }

  const suiteRoot = __dirname;
  for (const file of findTestFiles(suiteRoot)) {
    mocha.addFile(file);
  }

  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} Tier-2 E2E test(s) failed.`));
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
