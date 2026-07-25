/**
 * Mocha root hooks for the visual lane. One browser is shared across the whole
 * run and closed here; without this the lane leaves a Chrome process behind.
 *
 * The per-test hook feeds the current spec's name to the screenshot namer, so
 * specs never have to pass a label just to get a usefully-named image.
 */

import { closeSharedBrowser } from './browser';
import { setCurrentTestName, shotsDirectory, shotsEnabled } from './capture';

export const mochaHooks = {
  beforeEach(this: Mocha.Context): void {
    setCurrentTestName(this.currentTest?.fullTitle() ?? 'unknown');
  },

  async afterAll(): Promise<void> {
    await closeSharedBrowser();
    if (shotsEnabled()) {
      console.log(`\n  screenshots written to ${shotsDirectory()}`);
    }
  },
};
