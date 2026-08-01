/**
 * The editor build both Electron lanes (`test/e2e`, `test/ext-host`) boot.
 *
 * Pinned rather than floating on `stable`: these lanes launch a real editor, so
 * a VS Code release can break them with no change on our side — 1.131.0 renamed
 * `Contents/MacOS/Electron` to `Code`, which broke launching outright on
 * `@vscode/test-electron` 2.x. A gate that fails on someone else's release
 * schedule is not a gate.
 *
 * One constant for both launchers so the two lanes can never drift onto
 * different editors. Set `IG_VSCODE_VERSION` (e.g. `stable`, or an explicit
 * `1.131.0`) to try another build before moving the pin.
 */
export const VSCODE_TEST_VERSION = process.env.IG_VSCODE_VERSION ?? '1.130.0';
