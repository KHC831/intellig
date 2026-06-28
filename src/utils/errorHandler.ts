/**
 * Centralized Error Handler for Git Operations.
 * Provides error categorization, user-friendly messages, and recovery suggestions.
 */

import { GitCommandError } from '../git-core/gitCli';
import { sanitizeGitError } from '../git-core/gitError';

/**
 * Categories of Git errors for appropriate handling
 */
export enum GitErrorCategory {
  /** Network-related errors (connection, timeout, DNS) */
  Network = 'network',
  /** Authentication errors (credentials, SSH keys) */
  Authentication = 'authentication',
  /** Merge/rebase conflicts */
  Conflict = 'conflict',
  /** Permission/access errors */
  Permission = 'permission',
  /** Repository state errors (not a repo, corrupted) */
  Repository = 'repository',
  /** Branch-related errors (already exists, not found) */
  Branch = 'branch',
  /** Remote-related errors (not found, rejected) */
  Remote = 'remote',
  /** Uncommitted changes blocking operation */
  UncommittedChanges = 'uncommitted_changes',
  /** Lock file errors */
  Lock = 'lock',
  /** Invalid input/arguments */
  InvalidInput = 'invalid_input',
  /** Git not installed or not found */
  GitNotFound = 'git_not_found',
  /** Unknown/unclassified errors */
  Unknown = 'unknown',
}

/**
 * Structured Git error with categorization and recovery suggestions
 */
export interface IGitError {
  /** The error category */
  category: GitErrorCategory;
  /** User-friendly error message */
  message: string;
  /** Technical details for debugging */
  details?: string;
  /** Suggested recovery actions */
  recoveryActions?: IRecoveryAction[];
  /** Original error for debugging */
  originalError?: Error;
}

/**
 * Recovery action that can be presented to the user
 */
export interface IRecoveryAction {
  /** Display label for the action */
  label: string;
  /** Description of what the action does */
  description?: string;
  /** Command ID to execute (VS Code command) */
  commandId?: string;
  /** Arguments for the command */
  commandArgs?: unknown[];
}

/**
 * Error patterns for categorization
 */
interface IErrorPattern {
  /** Regex pattern to match against error message */
  pattern: RegExp;
  /** Category to assign when matched */
  category: GitErrorCategory;
  /** User-friendly message template (can use $1, $2, etc. for captures) */
  messageTemplate: string;
  /** Recovery actions to suggest */
  recoveryActions?: IRecoveryAction[];
}

/**
 * Error patterns for categorizing Git errors
 */
const ERROR_PATTERNS: IErrorPattern[] = [
  // Network errors
  {
    pattern: /Could not resolve host|unable to access|Connection refused|Network is unreachable/i,
    category: GitErrorCategory.Network,
    messageTemplate:
      'Unable to connect to the remote server. Please check your network connection.',
    recoveryActions: [
      { label: 'Retry', description: 'Try the operation again' },
      { label: 'Work Offline', description: 'Continue working without network access' },
    ],
  },
  {
    pattern: /Connection timed out|Operation timed out/i,
    category: GitErrorCategory.Network,
    messageTemplate: 'The connection timed out. The server may be slow or unreachable.',
    recoveryActions: [{ label: 'Retry', description: 'Try the operation again' }],
  },
  {
    pattern: /SSL certificate problem|certificate verify failed/i,
    category: GitErrorCategory.Network,
    messageTemplate:
      'SSL certificate verification failed. The server certificate may be invalid or expired.',
    recoveryActions: [{ label: 'Check Certificate', description: 'Verify the server certificate' }],
  },

  // Authentication errors
  {
    pattern: /Authentication failed|Invalid username or password|Permission denied \(publickey\)/i,
    category: GitErrorCategory.Authentication,
    messageTemplate:
      'Authentication failed. Please check your credentials or SSH key configuration.',
    recoveryActions: [
      { label: 'Configure Credentials', description: 'Update your Git credentials' },
      { label: 'Configure SSH Key', description: 'Set up SSH key authentication' },
    ],
  },
  {
    pattern: /Host key verification failed/i,
    category: GitErrorCategory.Authentication,
    messageTemplate: 'SSH host key verification failed. The server identity could not be verified.',
    recoveryActions: [{ label: 'Add Host Key', description: 'Add the server to known hosts' }],
  },
  {
    pattern: /could not read Username|terminal prompts disabled/i,
    category: GitErrorCategory.Authentication,
    messageTemplate: 'Git credentials are required but could not be obtained.',
    recoveryActions: [{ label: 'Configure Credentials', description: 'Set up credential helper' }],
  },

  // Conflict errors
  {
    pattern: /CONFLICT|Automatic merge failed|fix conflicts and then commit/i,
    category: GitErrorCategory.Conflict,
    messageTemplate: 'Merge conflicts detected. Please resolve the conflicts before continuing.',
    recoveryActions: [
      { label: 'Open Merge Tool', description: 'Open the conflict resolution interface' },
      { label: 'Abort', description: 'Abort the current operation' },
    ],
  },
  {
    pattern: /needs merge|not possible because you have unmerged files/i,
    category: GitErrorCategory.Conflict,
    messageTemplate: 'There are unresolved merge conflicts. Please resolve them first.',
    recoveryActions: [{ label: 'View Conflicts', description: 'Show conflicted files' }],
  },

  // Permission errors
  {
    pattern: /Permission denied|Access denied|unable to create.*Permission denied/i,
    category: GitErrorCategory.Permission,
    messageTemplate: 'Permission denied. You may not have the required access rights.',
    recoveryActions: [
      { label: 'Check Permissions', description: 'Verify file and repository permissions' },
    ],
  },

  // Repository errors
  {
    pattern: /not a git repository|fatal: not a git repository/i,
    category: GitErrorCategory.Repository,
    messageTemplate: 'This directory is not a Git repository.',
    recoveryActions: [
      {
        label: 'Initialize Repository',
        description: 'Create a new Git repository here',
        commandId: 'git.init',
      },
      {
        label: 'Clone Repository',
        description: 'Clone an existing repository',
        commandId: 'git.clone',
      },
    ],
  },
  {
    pattern: /corrupt|bad object|broken|missing object/i,
    category: GitErrorCategory.Repository,
    messageTemplate:
      'The repository appears to be corrupted. Some objects may be missing or damaged.',
    recoveryActions: [
      { label: 'Run fsck', description: 'Check repository integrity' },
      { label: 'Re-clone', description: 'Clone the repository again' },
    ],
  },

  // Branch errors
  {
    // Two capture groups ($1 = new ref, $2 = blocking ref): exercises the
    // multi-group substitution path — a value like "$2" in group 1 must not
    // be re-consumed by the group-2 pass.
    pattern: /cannot lock ref '([^']+)': '([^']+)' exists/i,
    category: GitErrorCategory.Branch,
    messageTemplate: "Cannot create ref '$1': conflicts with existing '$2'.",
    recoveryActions: [],
  },
  {
    pattern: /(?:A )?branch (?:named )?'([^']+)' already exists/i,
    category: GitErrorCategory.Branch,
    messageTemplate: "A branch named '$1' already exists. Please choose a different name.",
    recoveryActions: [
      { label: 'Checkout Existing', description: 'Switch to the existing branch' },
      { label: 'Use Different Name', description: 'Create branch with a different name' },
    ],
  },
  {
    pattern: /branch '([^']+)' not found|error: branch '([^']+)' not found/i,
    category: GitErrorCategory.Branch,
    messageTemplate: "Branch '$1' was not found.",
    recoveryActions: [
      { label: 'Fetch', description: 'Fetch from remote to update branch list' },
      { label: 'Create Branch', description: 'Create a new branch with this name' },
    ],
  },
  {
    pattern: /Cannot delete.*checked out|Cannot delete the branch.*which you are currently on/i,
    category: GitErrorCategory.Branch,
    messageTemplate:
      'Cannot delete the currently checked out branch. Switch to another branch first.',
    recoveryActions: [{ label: 'Switch Branch', description: 'Checkout a different branch first' }],
  },
  {
    pattern: /branch.*is not fully merged/i,
    category: GitErrorCategory.Branch,
    messageTemplate:
      'The branch has unmerged changes. Use force delete if you want to discard them.',
    recoveryActions: [
      { label: 'Force Delete', description: 'Delete the branch and discard unmerged changes' },
      { label: 'Merge First', description: 'Merge the branch before deleting' },
    ],
  },
  {
    pattern: /invalid branch name|'([^']+)' is not a valid branch name/i,
    category: GitErrorCategory.InvalidInput,
    messageTemplate:
      'Invalid branch name. Branch names cannot contain spaces or special characters like ~ ^ : \\ ? * [',
    recoveryActions: [],
  },

  // Remote errors
  {
    pattern: /remote.*already exists/i,
    category: GitErrorCategory.Remote,
    messageTemplate: 'A remote with this name already exists.',
    recoveryActions: [
      { label: 'Use Different Name', description: 'Choose a different remote name' },
      { label: 'Update Existing', description: 'Update the URL of the existing remote' },
    ],
  },
  {
    pattern: /remote.*does not exist|No such remote/i,
    category: GitErrorCategory.Remote,
    messageTemplate: 'The specified remote does not exist.',
    recoveryActions: [
      { label: 'Add Remote', description: 'Add a new remote' },
      { label: 'List Remotes', description: 'View available remotes' },
    ],
  },
  {
    pattern:
      /rejected.*non-fast-forward|Updates were rejected because the tip of your current branch is behind/i,
    category: GitErrorCategory.Remote,
    messageTemplate:
      'Push rejected: your branch is behind the remote. Pull the latest changes first.',
    recoveryActions: [
      { label: 'Pull First', description: 'Pull changes before pushing' },
      { label: 'Pull with Rebase', description: 'Pull with rebase to maintain linear history' },
      { label: 'Force Push', description: 'Force push (use with caution!)' },
    ],
  },
  {
    pattern: /rejected.*would clobber existing tag/i,
    category: GitErrorCategory.Remote,
    messageTemplate: 'A tag with this name already exists on the remote.',
    recoveryActions: [
      { label: 'Delete Remote Tag', description: 'Delete the tag from remote first' },
      { label: 'Use Different Name', description: 'Choose a different tag name' },
    ],
  },
  {
    pattern: /no upstream branch|no tracking information/i,
    category: GitErrorCategory.Remote,
    messageTemplate: 'No upstream branch is configured for the current branch.',
    recoveryActions: [
      { label: 'Set Upstream', description: 'Set the upstream branch' },
      { label: 'Push with -u', description: 'Push and set upstream in one command' },
    ],
  },

  // Uncommitted changes errors
  {
    pattern: /Your local changes.*would be overwritten|Please commit your changes or stash them/i,
    category: GitErrorCategory.UncommittedChanges,
    messageTemplate:
      'You have uncommitted changes that would be overwritten. Please commit or stash them first.',
    recoveryActions: [
      { label: 'Stash Changes', description: 'Temporarily save your changes' },
      { label: 'Commit Changes', description: 'Commit your current changes' },
      { label: 'Discard Changes', description: 'Discard all uncommitted changes' },
    ],
  },
  {
    pattern: /Cannot.*with.*uncommitted changes|error: cannot.*dirty/i,
    category: GitErrorCategory.UncommittedChanges,
    messageTemplate: 'This operation cannot be performed with uncommitted changes.',
    recoveryActions: [
      { label: 'Stash Changes', description: 'Temporarily save your changes' },
      { label: 'Commit Changes', description: 'Commit your current changes' },
    ],
  },

  // Lock errors
  {
    pattern: /Unable to create.*\.lock|Another git process seems to be running|index\.lock/i,
    category: GitErrorCategory.Lock,
    messageTemplate:
      'Another Git process is running or a lock file exists. Please wait or remove the lock file.',
    recoveryActions: [
      { label: 'Wait and Retry', description: 'Wait for the other process to finish' },
      { label: 'Remove Lock', description: 'Remove the lock file (use with caution)' },
    ],
  },

  // Git not found
  {
    pattern: /git.*not found|'git' is not recognized|command not found.*git/i,
    category: GitErrorCategory.GitNotFound,
    messageTemplate: 'Git is not installed or not found in PATH. Please install Git and try again.',
    recoveryActions: [
      { label: 'Install Git', description: 'Download and install Git' },
      { label: 'Configure Path', description: 'Set the path to Git executable' },
    ],
  },

  // Invalid input
  {
    pattern: /invalid.*tag name|'([^']+)' is not a valid tag name/i,
    category: GitErrorCategory.InvalidInput,
    messageTemplate: 'Invalid tag name. Tag names cannot contain spaces or special characters.',
    recoveryActions: [],
  },
  {
    pattern: /invalid.*remote.*url|not a valid URL/i,
    category: GitErrorCategory.InvalidInput,
    messageTemplate: 'Invalid remote URL format. Please check the URL and try again.',
    recoveryActions: [],
  },
  {
    pattern: /Aborting commit due to empty commit message/i,
    category: GitErrorCategory.InvalidInput,
    messageTemplate: 'Commit message cannot be empty.',
    recoveryActions: [],
  },
  {
    pattern: /pathspec '([^']+)' did not match any file/i,
    category: GitErrorCategory.InvalidInput,
    messageTemplate: "The path '$1' does not exist or is not tracked by Git.",
    recoveryActions: [],
  },
  {
    pattern: /unknown revision or path not in the working tree/i,
    category: GitErrorCategory.InvalidInput,
    messageTemplate: 'The specified revision or path was not found.',
    recoveryActions: [],
  },
];

/**
 * Categorize a Git error and provide user-friendly information.
 *
 * @param error - The error to categorize
 * @returns Structured Git error with category, message, and recovery actions
 */
export function categorizeGitError(error: Error | string): IGitError {
  const errorMessage = error instanceof Error ? error.message : error;
  const stderr = error instanceof GitCommandError ? error.result.stderr : '';
  const fullMessage = `${errorMessage}\n${stderr}`.trim();

  // Try to match against known patterns
  for (const pattern of ERROR_PATTERNS) {
    const match = fullMessage.match(pattern.pattern);
    if (match) {
      // Replace $1, $2, … placeholders in a single pass with a regex +
      // function replacement. Single-pass means replaced text is never
      // re-scanned, so a captured value that is itself "$2" (e.g. a branch
      // literally named "$2") cannot be consumed by the group-2 substitution
      // in a subsequent iteration — it survives verbatim in the output.
      const message = pattern.messageTemplate.replace(
        /\$(\d+)/g,
        (_, n: string) => match[Number(n)] ?? ''
      );

      return {
        category: pattern.category,
        // The template can interpolate captured groups (e.g. a URL), and the
        // details carry raw stderr — both can embed credentials or home-dir
        // paths, so scrub before they reach any toast / notification / log.
        message: sanitizeGitError(message),
        details: sanitizeGitError(fullMessage),
        recoveryActions: pattern.recoveryActions,
        originalError: error instanceof Error ? error : new Error(error),
      };
    }
  }

  // Default to unknown category
  return {
    category: GitErrorCategory.Unknown,
    message: getDefaultErrorMessage(errorMessage),
    details: sanitizeGitError(fullMessage),
    recoveryActions: [
      { label: 'View Details', description: 'Show full error details' },
      { label: 'Retry', description: 'Try the operation again' },
    ],
    originalError: error instanceof Error ? error : new Error(error),
  };
}

/**
 * Get a user-friendly default error message.
 *
 * @param errorMessage - The original error message
 * @returns A cleaned up, user-friendly message
 */
function getDefaultErrorMessage(errorMessage: string): string {
  // Scrub credentials / home-dir paths first: this message is shown to the user
  // and an Unknown-category error (no template) echoes the raw git text.
  let message = sanitizeGitError(errorMessage)
    .replace(/^fatal:\s*/i, '')
    .replace(/^error:\s*/i, '')
    .replace(/^warning:\s*/i, '')
    .trim();

  // Capitalize first letter
  if (message.length > 0) {
    message = message.charAt(0).toUpperCase() + message.slice(1);
  }

  // Ensure it ends with a period
  if (
    message.length > 0 &&
    !message.endsWith('.') &&
    !message.endsWith('!') &&
    !message.endsWith('?')
  ) {
    message += '.';
  }

  return message || 'An unknown error occurred.';
}

/**
 * Check if an error is of a specific category.
 *
 * @param error - The error to check
 * @param category - The category to check for
 * @returns True if the error matches the category
 */
export function isErrorCategory(error: Error | string, category: GitErrorCategory): boolean {
  const gitError = categorizeGitError(error);
  return gitError.category === category;
}

/**
 * Check if an error is a network-related error.
 *
 * @param error - The error to check
 * @returns True if the error is network-related
 */
export function isNetworkError(error: Error | string): boolean {
  return isErrorCategory(error, GitErrorCategory.Network);
}

/**
 * Check if an error is an authentication error.
 *
 * @param error - The error to check
 * @returns True if the error is authentication-related
 */
export function isAuthenticationError(error: Error | string): boolean {
  return isErrorCategory(error, GitErrorCategory.Authentication);
}

/**
 * Check if an error is a conflict error.
 *
 * @param error - The error to check
 * @returns True if the error is conflict-related
 */
export function isConflictError(error: Error | string): boolean {
  return isErrorCategory(error, GitErrorCategory.Conflict);
}

/**
 * Check if an error is due to uncommitted changes.
 *
 * @param error - The error to check
 * @returns True if the error is due to uncommitted changes
 */
export function isUncommittedChangesError(error: Error | string): boolean {
  return isErrorCategory(error, GitErrorCategory.UncommittedChanges);
}

/**
 * Get recovery suggestions for a specific error category.
 *
 * @param category - The error category
 * @returns Array of recovery action labels
 */
export function getRecoverySuggestions(category: GitErrorCategory): string[] {
  const suggestions: Record<GitErrorCategory, string[]> = {
    [GitErrorCategory.Network]: [
      'Check your internet connection',
      'Verify the remote URL is correct',
      'Try again later if the server is down',
    ],
    [GitErrorCategory.Authentication]: [
      'Check your username and password',
      'Verify your SSH key is configured correctly',
      'Ensure your credentials are not expired',
    ],
    [GitErrorCategory.Conflict]: [
      'Open the conflicted files and resolve conflicts',
      'Use the merge tool to resolve conflicts visually',
      'Abort the operation if you want to start over',
    ],
    [GitErrorCategory.Permission]: [
      'Check file and directory permissions',
      'Ensure you have write access to the repository',
      'Run with elevated privileges if necessary',
    ],
    [GitErrorCategory.Repository]: [
      'Initialize a new repository with git init',
      'Clone an existing repository',
      'Check if the .git directory exists',
    ],
    [GitErrorCategory.Branch]: [
      'Use a different branch name',
      'Fetch from remote to update branch list',
      'Check if the branch exists locally or remotely',
    ],
    [GitErrorCategory.Remote]: [
      'Pull the latest changes before pushing',
      'Set up the upstream branch',
      'Verify the remote URL is correct',
    ],
    [GitErrorCategory.UncommittedChanges]: [
      'Commit your changes before proceeding',
      'Stash your changes temporarily',
      'Discard changes if they are not needed',
    ],
    [GitErrorCategory.Lock]: [
      'Wait for the other Git process to finish',
      'Remove the lock file if no other process is running',
      'Restart VS Code if the issue persists',
    ],
    [GitErrorCategory.InvalidInput]: [
      'Check the input format and try again',
      'Refer to Git documentation for valid formats',
    ],
    [GitErrorCategory.GitNotFound]: [
      'Install Git from https://git-scm.com',
      'Add Git to your system PATH',
      'Configure the Git path in VS Code settings',
    ],
    [GitErrorCategory.Unknown]: [
      'Check the error details for more information',
      'Try the operation again',
      'Search for the error message online',
    ],
  };

  return suggestions[category] || suggestions[GitErrorCategory.Unknown];
}

/**
 * Format an error for logging purposes.
 *
 * @param error - The error to format
 * @returns Formatted error string for logging
 */
export function formatErrorForLogging(error: Error | string): string {
  const gitError = categorizeGitError(error);
  const lines: string[] = [
    `[Git Error] Category: ${gitError.category}`,
    `Message: ${gitError.message}`,
  ];

  if (gitError.details) {
    lines.push(`Details: ${gitError.details}`);
  }

  if (gitError.originalError instanceof GitCommandError) {
    const cmdError = gitError.originalError;
    // args can carry a tokenized remote URL and stderr can echo it back —
    // scrub both before they hit the Output channel / log file. (details +
    // message arrive already sanitized from categorizeGitError.)
    lines.push(`Command: git ${sanitizeGitError(cmdError.args.join(' '))}`);
    lines.push(`Exit Code: ${cmdError.result.exitCode}`);
    if (cmdError.result.stderr) {
      lines.push(`Stderr: ${sanitizeGitError(cmdError.result.stderr)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Create a user-friendly error message with optional recovery suggestions.
 *
 * @param error - The error to format
 * @param includeRecovery - Whether to include recovery suggestions
 * @returns User-friendly error message
 */
export function formatUserFriendlyError(
  error: Error | string,
  includeRecovery: boolean = true
): string {
  const gitError = categorizeGitError(error);
  let message = gitError.message;

  if (includeRecovery && gitError.recoveryActions && gitError.recoveryActions.length > 0) {
    const suggestions = gitError.recoveryActions
      .filter((action) => action.description)
      .map((action) => `• ${action.description}`)
      .join('\n');

    if (suggestions) {
      message += '\n\nSuggestions:\n' + suggestions;
    }
  }

  return message;
}
