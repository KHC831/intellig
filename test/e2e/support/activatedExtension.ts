/**
 * Bridge to the ACTIVATED extension's runtime API.
 *
 * The VS Code host activates the built `out/extension.js` (package `main`).
 * The test tree compiles to `out-test/`, so a direct
 * `import { getServices } from '../../../src/extension'` resolves at runtime to
 * `out-test/src/extension.js` — a SEPARATE module instance whose module-level
 * singletons activation never populates. `getServices()` then returns
 * `undefined` and every fixture-backed test fails with "ExtensionServices not
 * initialised yet". (Latent since the suite moved from `src/test/` to
 * top-level `test/`: before the move the tests compiled into `out/` and shared
 * the one `out/extension.js`.)
 *
 * Loading the `out/` build with `require` returns the exact module instance the
 * host activated (Node caches by resolved absolute path), so `getServices()`
 * observes the populated singletons. Types still come from source via
 * `import type`, so the seam stays fully typed.
 */
import type {
  getServices as GetServicesFn,
  getGitToolWindowProvider as GetGitToolWindowProviderFn,
} from '../../../src/extension';
import type { getOutputChannel as GetOutputChannelFn } from '../../../src/utils/outputChannel';

// Resolved from out-test/test/e2e/support/ → project-root/out/extension.js, the
// same absolute path the host requires when it activates the extension.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activated = require('../../../../out/extension') as {
  getServices: typeof GetServicesFn;
  getGitToolWindowProvider: typeof GetGitToolWindowProviderFn;
};

// The structured Logger writes through the `out/` output-channel singleton, so
// a test that wants to observe rendered log records must read the SAME `out/`
// module — not the `out-test/src` copy a direct import would resolve to.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activatedOutputChannel = require('../../../../out/utils/outputChannel') as {
  getOutputChannel: typeof GetOutputChannelFn;
};

export const getServices = activated.getServices;
export const getGitToolWindowProvider = activated.getGitToolWindowProvider;
export const getOutputChannel = activatedOutputChannel.getOutputChannel;
