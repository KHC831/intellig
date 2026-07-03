/**
 * Bridge to the ACTIVATED extension's runtime API.
 *
 * The VS Code host activates the `dist/extension.js` bundle (package `main`).
 * The test tree compiles to `out-test/`, so a direct
 * `import { getServices } from '../../../src/extension'` resolves at runtime to
 * `out-test/src/extension.js` — a SEPARATE module instance whose module-level
 * singletons activation never populates. `getServices()` then returns
 * `undefined` and every fixture-backed test fails with "ExtensionServices not
 * initialised yet".
 *
 * Loading the bundle with `require` returns the exact module instance the
 * host activated (Node caches by resolved absolute path), so `getServices()`
 * observes the populated singletons. The bundle inlines every internal module,
 * so singletons that used to live in their own compiled files (logger, output
 * channel) are reachable only through the bundle's entry exports —
 * extension.ts re-exports them for exactly this seam. Types still come from
 * source via `import type`, so the seam stays fully typed.
 */
import type {
  getServices as GetServicesFn,
  getGitToolWindowProvider as GetGitToolWindowProviderFn,
} from '../../../src/extension';
import type { getOutputChannel as GetOutputChannelFn } from '../../../src/utils/outputChannel';

// Resolved from out-test/test/e2e/support/ → project-root/dist/extension.js,
// the same absolute path the host requires when it activates the extension.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activated = require('../../../../dist/extension') as {
  getServices: typeof GetServicesFn;
  getGitToolWindowProvider: typeof GetGitToolWindowProviderFn;
  getOutputChannel: typeof GetOutputChannelFn;
};

export const getServices = activated.getServices;
export const getGitToolWindowProvider = activated.getGitToolWindowProvider;
export const getOutputChannel = activated.getOutputChannel;
