/**
 * Structured notification for an Update Project result.
 *
 * A single pure builder consumed by the Update Project command
 * (`commitRepoCoreCommands`): it turns the run outcome into a severity + a
 * headline + a deep-link that focuses the Update Info tab. Kept vscode-free so
 * the command owns the toast.
 */

/** A deep-link action on a notification: selecting `label` runs `commandId`. */
export interface IUpdateNotificationDeepLink {
  /** Button label shown in the notification. */
  label: string;
  /** Command executed when the button is selected. */
  commandId: string;
  /** Arguments passed to `commandId`. */
  commandArgs?: unknown[];
}

/** The structured outcome of an Update Project run. */
export interface IUpdateNotification {
  severity: 'info' | 'warning';
  /** The headline message (already human-readable / sanitized by the caller). */
  message: string;
  deepLinks?: IUpdateNotificationDeepLink[];
}

/**
 * Build the structured notification for an Update Project result.
 *
 * @param allClean whether every repo finished cleanly
 * @param headline a one-line, already-sanitized outcome headline
 */
export function buildUpdateNotification(allClean: boolean, headline: string): IUpdateNotification {
  return {
    severity: allClean ? 'info' : 'warning',
    message: headline,
    deepLinks: [
      {
        label: 'Show Update Info',
        commandId: 'intellig.toolWindow.focusTab',
        commandArgs: ['updateInfo'],
      },
    ],
  };
}
