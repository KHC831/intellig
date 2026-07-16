import * as vscode from 'vscode';

/** Section under which every intellig setting lives. */
const SECTION = 'intellig';

/**
 * Every intellig.* setting, keyed by a stable logical name → its VS Code setting
 * name (relative to `intellig.`). Mirrors package.json contributes 1:1;
 * check:config-keys fences that mirror in both directions.
 */
export const CONFIG_KEYS = {
  defaultRepo: 'defaultRepo',
  keymapPreset: 'keymapPreset',
  protectedBranches: 'protectedBranches',
  autorefresh: 'autorefresh',
  addCherryPickedFromSuffix: 'addCherryPickedFromSuffix',
  useCommitToolWindow: 'useCommitToolWindow',
  commitAuthor: 'commitAuthor',
  warnAboutCrlf: 'warnAboutCrlf',
  largeFileWarningMb: 'largeFileWarningMb',
  commitMessageIssueLinks: 'commitMessageIssueLinks',
  useTabbedGitToolWindow: 'useTabbedGitToolWindow',
  logShowAllRoots: 'log.showAllRoots',
  logShowRootNames: 'log.showRootNames',
  logHighlightCherryPicked: 'log.highlightCherryPicked',
  logShowGpgColumn: 'log.showGpgColumn',
  logShowLongEdges: 'log.showLongEdges',
  autoFetchEnabled: 'autoFetchEnabled',
  autoFetchInterval: 'autoFetchInterval',
  fetchTags: 'fetchTags',
  pullRebase: 'pullRebase',
  branchesShowTags: 'branches.showTags',
  branchesShowRecentBranches: 'branches.showRecentBranches',
  branchesGroupByDirectory: 'branches.groupByDirectory',
  blameAnnotationStyle: 'blameAnnotationStyle',
  blameColorMode: 'blame.colorMode',
  blameShowAuthor: 'blame.showAuthor',
  blameShowDate: 'blame.showDate',
  blameShowRevision: 'blame.showRevision',
  blameAuthorNameFormat: 'blame.authorNameFormat',
  blameIgnoreWhitespace: 'blame.ignoreWhitespace',
  blameDetectMovements: 'blame.detectMovements',
  diffIgnorePolicy: 'diff.ignorePolicy',
  lineStatusEnabled: 'lineStatus.enabled',
  autoOpenResolveConflictsDialog: 'autoOpenResolveConflictsDialog',
  mergeWindowEnabled: 'mergeWindow.enabled',
  mergeWindowAutoApplyNonConflicting: 'mergeWindow.autoApplyNonConflicting',
  shelveRemoveAppliedFiles: 'shelve.removeAppliedFiles',
  repositoryScanMaxDepth: 'repositoryScanMaxDepth',
  repositoryScanIgnoredFolders: 'repositoryScanIgnoredFolders',
  logLevel: 'log.level',
  logConsole: 'log.console',
} as const;

export type ConfigKey = (typeof CONFIG_KEYS)[keyof typeof CONFIG_KEYS];

/**
 * Value type per setting NAME (the `intellig.`-relative name, e.g.
 * `'log.showGpgColumn'`). Enum settings are LITERAL UNIONS, not bare `string`,
 * so call sites get the exact type the schema promises.
 */
export type ConfigValues = {
  defaultRepo: string;
  keymapPreset: 'default' | 'intellij';
  protectedBranches: string[];
  autorefresh: boolean;
  addCherryPickedFromSuffix: boolean;
  useCommitToolWindow: boolean;
  commitAuthor: string;
  warnAboutCrlf: boolean;
  largeFileWarningMb: number;
  commitMessageIssueLinks: boolean;
  useTabbedGitToolWindow: boolean;
  'log.showAllRoots': boolean;
  'log.showRootNames': boolean;
  'log.highlightCherryPicked': boolean;
  'log.showGpgColumn': boolean;
  'log.showLongEdges': boolean;
  autoFetchEnabled: boolean;
  autoFetchInterval: number;
  fetchTags: 'auto' | 'all' | 'never';
  pullRebase: boolean;
  'branches.showTags': boolean;
  'branches.showRecentBranches': boolean;
  'branches.groupByDirectory': boolean;
  blameAnnotationStyle: 'inline' | 'gutter' | 'both' | 'off';
  'blame.colorMode': 'order' | 'author';
  'blame.showAuthor': boolean;
  'blame.showDate': boolean;
  'blame.showRevision': boolean;
  'blame.authorNameFormat': 'full' | 'firstname' | 'lastname' | 'initials' | 'email';
  'blame.ignoreWhitespace': boolean;
  'blame.detectMovements': 'none' | 'within' | 'across';
  'diff.ignorePolicy':
    | 'default'
    | 'trim-whitespaces'
    | 'ignore-whitespaces'
    | 'ignore-whitespaces-empty-lines';
  'lineStatus.enabled': boolean;
  autoOpenResolveConflictsDialog: boolean;
  'mergeWindow.enabled': boolean;
  'mergeWindow.autoApplyNonConflicting': boolean;
  'shelve.removeAppliedFiles': boolean;
  repositoryScanMaxDepth: number;
  repositoryScanIgnoredFolders: string[];
  'log.level': 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'off';
  'log.console': boolean;
};

/**
 * Compile-time exhaustiveness tie: ConfigValues MUST cover every ConfigKey. A
 * key present in CONFIG_KEYS but missing from ConfigValues errors HERE, not only
 * at first use — which for a dead key would be never.
 */
const _configValuesCoversAllKeys: Record<ConfigKey, unknown> = {} as ConfigValues;
void _configValuesCoversAllKeys;

/**
 * Read an intellig setting. Returns the schema-registered default when the user
 * has not set it — VS Code's get() already does this, so call sites pass NO
 * fallback. There is deliberately no default parameter: inline fallbacks that
 * duplicate (and drift from) the schema become UNWRITABLE.
 */
export function readConfig<K extends ConfigKey>(key: K): ConfigValues[K] {
  return vscode.workspace.getConfiguration(SECTION).get<ConfigValues[K]>(key) as ConfigValues[K];
}

/** Write an intellig setting (Global target by default). */
export function updateConfig<K extends ConfigKey>(
  key: K,
  value: ConfigValues[K] | undefined,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Thenable<void> {
  return vscode.workspace.getConfiguration(SECTION).update(key, value, target);
}

/** Inspect an intellig setting's per-scope values (global / workspace / default). */
export function inspectConfig<K extends ConfigKey>(
  key: K
):
  | {
      key: string;
      defaultValue?: ConfigValues[K];
      globalValue?: ConfigValues[K];
      workspaceValue?: ConfigValues[K];
      workspaceFolderValue?: ConfigValues[K];
    }
  | undefined {
  return vscode.workspace.getConfiguration(SECTION).inspect<ConfigValues[K]>(key);
}
