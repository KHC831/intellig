/**
 * Mocha root hooks for the visual lane. One browser is shared across the whole
 * run and closed here; without this the lane leaves a Chrome process behind.
 */

import { closeSharedBrowser } from './browser';

export const mochaHooks = {
  async afterAll(): Promise<void> {
    await closeSharedBrowser();
  },
};
