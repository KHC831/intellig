/**
 * Mock implementation of the VS Code API for unit testing.
 * This allows tests to run outside of the VS Code extension host.
 */

/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

// Mock EventEmitter
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  fire(data: T): void {
    this.listeners.forEach((listener) => listener(data));
  }

  dispose(): void {
    this.listeners = [];
  }
}

// Mock Event type
export type Event<T> = (listener: (e: T) => void) => { dispose: () => void };

// Mock ConfigurationTarget enum
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// Mock DecorationRangeBehavior enum
export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}

// Mock OverviewRulerLane enum — matches the real vscode API values so
// decoration types that paint into the overview ruler (LineStatusTracker)
// can be constructed under unit tests.
export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

// Mock QuickPickItemKind enum — matches the values from the real vscode API
// so code that uses it (QuickPick separators, etc.) works under unit tests.
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

// Mock StatusBarAlignment enum
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// Mock ViewColumn enum
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
}

// Mock ProgressLocation enum
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

// Mock `vscode.TabInputText` class so the
// squash dialog's tab-API close path can do `instanceof TabInputText`
// checks against tab inputs constructed by tests.
export class TabInputText {
  constructor(public readonly uri: Uri) {}
}

// Mock configuration storage (per-scope tracker).
//
// Real VS Code distinguishes three scopes through `inspect()`:
//   - `defaultValue` — schema default (declared in package.json
//     `contributes.configuration`).
//   - `globalValue` — user wrote it at user-settings scope.
//   - `workspaceValue` — user wrote it at workspace-settings scope.
// And `get()` resolves with workspace > global > default precedence.
//
// Earlier the mock collapsed all three into one map, so tests
// couldn't distinguish "user explicitly wrote 'default'" from
// "schema default returned 'default'." That hole let the migration
// land mostly correctly but tests had to bypass the mock through
// `IKeymapMigrationConfigSeam` to drive the per-scope shape.
// The rebuilt mock lets production code use
// `IConfigurationService.inspect()` uniformly without bypass.
interface ScopeStore {
  global: Map<string, unknown>;
  workspace: Map<string, unknown>;
  schemaDefaults: Map<string, unknown>;
}
const configurationStore: Map<string, ScopeStore> = new Map();

// Initialize default configuration values. Schema defaults populate
// the `schemaDefaults` slot; `global` and `workspace` start empty
// (no user has written) so `inspect().globalValue` is undefined
// until a test explicitly writes via `setMockConfigValue` or the
// production code calls `update`.
function initializeDefaultConfig(): void {
  const schemaDefaults = new Map<string, unknown>();
  schemaDefaults.set('defaultCommitSignOff', false);
  schemaDefaults.set('commitMessageTemplate', '');
  schemaDefaults.set('pullRebase', false);
  schemaDefaults.set('autoFetchEnabled', true);
  schemaDefaults.set('autoFetchInterval', 180);
  schemaDefaults.set('defaultToolWindowTab', 'local-changes');
  schemaDefaults.set('useTabbedGitToolWindow', true);
  schemaDefaults.set('blameAnnotationStyle', 'inline');
  schemaDefaults.set('showStatusBarBranch', true);
  schemaDefaults.set('keymapPreset', 'default');
  schemaDefaults.set('modifiedFileColor', '#6897BB');
  schemaDefaults.set('addedFileColor', '#629755');
  schemaDefaults.set('deletedFileColor', '#6C6C6C');
  schemaDefaults.set('ignoredFileColor', '#848504');
  schemaDefaults.set('conflictFileColor', '#FF0000');
  configurationStore.set('intellig', {
    global: new Map(),
    workspace: new Map(),
    schemaDefaults,
  });
}

// Initialize on module load
initializeDefaultConfig();

function ensureSection(section: string): ScopeStore {
  let store = configurationStore.get(section);
  if (!store) {
    store = {
      global: new Map(),
      workspace: new Map(),
      schemaDefaults: new Map(),
    };
    configurationStore.set(section, store);
  }
  return store;
}

// Mock WorkspaceConfiguration
export interface WorkspaceConfiguration {
  get<T>(section: string): T | undefined;
  get<T>(section: string, defaultValue: T): T;
  has(section: string): boolean;
  inspect<T>(section: string):
    | {
        key: string;
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
      }
    | undefined;
  update(
    section: string,
    value: unknown,
    configurationTarget?: ConfigurationTarget | boolean
  ): Promise<void>;
}

// Configuration change event listeners
const configChangeListeners: ((e: ConfigurationChangeEvent) => void)[] = [];

/**
 * Workspace-folder change event listeners. Earlier
 * the mock had a no-op `onDidChangeWorkspaceFolders` that returned a stub
 * disposable, which made it impossible for tests to drive the real
 * production listener path (`vscode.workspace.onDidChangeWorkspaceFolders`)
 * the way `onDidChangeConfiguration` already supported. This registry
 * + the {@link fireWorkspaceFoldersChange} helper lets tests synthesize a
 * folder-removal event and verify the production handler fires the
 * `onDidRemoveRepository` emitter.
 */
const workspaceFoldersListeners: ((e: unknown) => void)[] = [];

/**
 * Test-only registry of active FileSystemWatcher mocks. Tests can read this
 * to assert which patterns a service subscribed to and to synthesize
 * `onDidChange` / `onDidCreate` / `onDidDelete` events without having to go
 * through the real VS Code API.
 *
 * Exposed via {@link getCreatedFileSystemWatchers}.
 */
interface IMockFileSystemWatcher extends FileSystemWatcher {
  _pattern: string | RelativePattern;
  _fireCreate: (uri: Uri) => void;
  _fireChange: (uri: Uri) => void;
  _fireDelete: (uri: Uri) => void;
}

const createdFileSystemWatchers: IMockFileSystemWatcher[] = [];

/**
 * Return a snapshot of all currently-active FileSystemWatcher mocks.
 * Tests use this to verify subscription patterns and to fire synthetic
 * change events against the watchers a service installed.
 */
export function getCreatedFileSystemWatchers(): IMockFileSystemWatcher[] {
  return [...createdFileSystemWatchers];
}

// Mock ConfigurationChangeEvent
export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean;
}

// Mock workspace namespace
export const workspace = {
  getConfiguration(section?: string): WorkspaceConfiguration {
    const store = section ? configurationStore.get(section) : undefined;

    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        // Resolve workspace > global > schema-default (matches VS
        // Code semantics).
        if (!store) {
          return defaultValue;
        }
        if (store.workspace.has(key)) {
          return store.workspace.get(key) as T;
        }
        if (store.global.has(key)) {
          return store.global.get(key) as T;
        }
        const schema = store.schemaDefaults.get(key);
        if (schema !== undefined) {
          return schema as T;
        }
        return defaultValue;
      },
      has(key: string): boolean {
        if (!store) {
          return false;
        }
        return store.workspace.has(key) || store.global.has(key) || store.schemaDefaults.has(key);
      },
      inspect<T>(key: string) {
        // per-scope tracker now lets `inspect()`
        // distinguish "user wrote at user scope" (globalValue)
        // from "user wrote at workspace scope" (workspaceValue)
        // from "schema default returned" (defaultValue) — matching
        // production VS Code semantics. Returns undefined for any
        // scope where the user has not explicitly written.
        if (!store) {
          return {
            key: section ? `${section}.${key}` : key,
          };
        }
        const result: {
          key: string;
          defaultValue?: T;
          globalValue?: T;
          workspaceValue?: T;
          workspaceFolderValue?: T;
        } = { key: section ? `${section}.${key}` : key };
        if (store.schemaDefaults.has(key)) {
          result.defaultValue = store.schemaDefaults.get(key) as T;
        }
        if (store.global.has(key)) {
          result.globalValue = store.global.get(key) as T;
        }
        if (store.workspace.has(key)) {
          result.workspaceValue = store.workspace.get(key) as T;
        }
        return result;
      },
      async update(
        key: string,
        value: unknown,
        target?: ConfigurationTarget | boolean
      ): Promise<void> {
        if (!section) {
          return;
        }
        // Explicitly reject WorkspaceFolder target.
        // Earlier the mock silently coerced WorkspaceFolder writes to
        // Global, which would have given a future test author writing
        // a WorkspaceFolder-scope spec a green run that was actually
        // testing global-scope semantics. Better to fail fast with a
        // clear path forward.
        if (target === ConfigurationTarget.WorkspaceFolder) {
          throw new Error(
            'mock does not support ConfigurationTarget.WorkspaceFolder; ' +
              'add a workspaceFolder scope to ScopeStore if you need it.'
          );
        }
        const sectionStore = ensureSection(section);
        const useWorkspace = target === ConfigurationTarget.Workspace;
        const map = useWorkspace ? sectionStore.workspace : sectionStore.global;
        if (value === undefined) {
          map.delete(key);
        } else {
          map.set(key, value);
        }

        // Fire configuration change event
        const event: ConfigurationChangeEvent = {
          affectsConfiguration(s: string): boolean {
            return s === section || s.startsWith(`${section}.`);
          },
        };
        configChangeListeners.forEach((listener) => listener(event));
      },
    };
  },

  onDidChangeConfiguration(listener: (e: ConfigurationChangeEvent) => void): {
    dispose: () => void;
  } {
    configChangeListeners.push(listener);
    return {
      dispose: () => {
        const index = configChangeListeners.indexOf(listener);
        if (index >= 0) {
          configChangeListeners.splice(index, 1);
        }
      },
    };
  },

  onDidChangeWorkspaceFolders(listener: (e: unknown) => void): { dispose: () => void } {
    workspaceFoldersListeners.push(listener);
    return {
      dispose: (): void => {
        const i = workspaceFoldersListeners.indexOf(listener);
        if (i >= 0) {
          workspaceFoldersListeners.splice(i, 1);
        }
      },
    };
  },

  createFileSystemWatcher(
    globPattern: string | RelativePattern,
    _ignoreCreateEvents?: boolean,
    _ignoreChangeEvents?: boolean,
    _ignoreDeleteEvents?: boolean
  ): FileSystemWatcher {
    const createEmitter = new EventEmitter<Uri>();
    const changeEmitter = new EventEmitter<Uri>();
    const deleteEmitter = new EventEmitter<Uri>();

    const watcher: FileSystemWatcher & {
      _pattern: string | RelativePattern;
      _fireCreate: (uri: Uri) => void;
      _fireChange: (uri: Uri) => void;
      _fireDelete: (uri: Uri) => void;
    } = {
      _pattern: globPattern,
      _fireCreate: (uri: Uri): void => createEmitter.fire(uri),
      _fireChange: (uri: Uri): void => changeEmitter.fire(uri),
      _fireDelete: (uri: Uri): void => deleteEmitter.fire(uri),
      onDidCreate: createEmitter.event,
      onDidChange: changeEmitter.event,
      onDidDelete: deleteEmitter.event,
      dispose: () => {
        createEmitter.dispose();
        changeEmitter.dispose();
        deleteEmitter.dispose();
        const idx = createdFileSystemWatchers.indexOf(watcher);
        if (idx >= 0) {
          createdFileSystemWatchers.splice(idx, 1);
        }
      },
    };

    createdFileSystemWatchers.push(watcher);
    return watcher;
  },

  onDidChangeTextDocument(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },

  onDidSaveTextDocument(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },

  // Mock for `vscode.workspace.onDidCloseTextDocument`.
  // Tests override on the writable `workspace` to drive the squash-
  // editor save/close listener flow.
  onDidCloseTextDocument(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },

  // Mock for `vscode.workspace.openTextDocument`. Default
  // returns a minimal text-document stub; tests override on the
  // writable `workspace` to drive the squash-editor flow.
  openTextDocument: async (
    options?:
      | string
      | Uri
      | {
          content?: string;
          language?: string;
        }
  ): Promise<{
    uri: Uri;
    getText: () => string;
    languageId: string;
    isUntitled: boolean;
  }> => {
    if (typeof options === 'object' && options !== null && 'content' in options) {
      const content = (options as { content?: string }).content ?? '';
      const language = (options as { language?: string }).language ?? 'plaintext';
      return {
        uri: Uri.parse(`untitled:wave-c-mock-${Date.now()}`),
        getText: () => content,
        languageId: language,
        isUntitled: true,
      };
    }
    return {
      uri: Uri.parse('untitled:wave-c-mock-empty'),
      getText: () => '',
      languageId: 'plaintext',
      isUntitled: true,
    };
  },

  workspaceFolders: undefined as unknown[] | undefined,

  /**
   * Mirror `vscode.workspace.asRelativePath`: return the path relative to the
   * owning workspace folder when one is set, otherwise the input path
   * unchanged. Accepts a string or `Uri`.
   */
  asRelativePath(pathOrUri: string | Uri, _includeWorkspaceFolder?: boolean): string {
    const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    const folders = (this.workspaceFolders ?? []) as Array<{ uri: Uri }>;
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      if (p === root) {
        return '';
      }
      if (p.startsWith(root + '/')) {
        return p.slice(root.length + 1);
      }
    }
    return p;
  },

  fs: {
    readFile: async (_uri: Uri): Promise<Uint8Array> => new Uint8Array(),
    writeFile: async (_uri: Uri, _content: Uint8Array): Promise<void> => {},
    delete: async (_uri: Uri): Promise<void> => {},
    rename: async (_oldUri: Uri, _newUri: Uri): Promise<void> => {},
    copy: async (_source: Uri, _target: Uri): Promise<void> => {},
    createDirectory: async (_uri: Uri): Promise<void> => {},
    readDirectory: async (_uri: Uri): Promise<[string, number][]> => [],
    stat: async (
      _uri: Uri
    ): Promise<{ type: number; ctime: number; mtime: number; size: number }> => ({
      type: 1,
      ctime: 0,
      mtime: 0,
      size: 0,
    }),
    isWritableFileSystem: (_scheme: string): boolean | undefined => true,
  },

  // Mock for `vscode.workspace.registerTextDocumentContentProvider`. Records
  // the provider in `registeredContentProviders` keyed by scheme so tests can
  // invoke `provideTextDocumentContent` directly, then disposes by removing it.
  registerTextDocumentContentProvider(
    scheme: string,
    provider: { provideTextDocumentContent: (uri: Uri) => string | Promise<string> }
  ): { dispose: () => void } {
    registeredContentProviders.set(scheme, provider);
    return {
      dispose: () => {
        registeredContentProviders.delete(scheme);
      },
    };
  },
};

/**
 * Registry of TextDocumentContentProviders registered through the mocked
 * `workspace.registerTextDocumentContentProvider`. Tests read it to drive a
 * provider's `provideTextDocumentContent` without a real editor.
 */
export const registeredContentProviders = new Map<
  string,
  { provideTextDocumentContent: (uri: Uri) => string | Promise<string> }
>();

// Mock FileSystemWatcher
export interface FileSystemWatcher {
  onDidCreate: Event<Uri>;
  onDidChange: Event<Uri>;
  onDidDelete: Event<Uri>;
  dispose(): void;
}

// Mock RelativePattern — minimal shape consumed by createFileSystemWatcher
// and by tests that inspect the pattern after it's been passed in.
export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;
  readonly pattern: string;

  constructor(base: Uri | string, pattern: string) {
    if (typeof base === 'string') {
      this.base = base;
      this.baseUri = Uri.file(base);
    } else {
      this.baseUri = base;
      this.base = base.fsPath;
    }
    this.pattern = pattern;
  }
}

// Mock WebviewViewProvider
export interface WebviewViewProvider {
  resolveWebviewView(
    webviewView: WebviewView,
    context: WebviewViewResolveContext,
    token: CancellationToken
  ): void | Thenable<void>;
}

// Mock WebviewView
export interface WebviewView {
  webview: Webview;
  visible: boolean;
  onDidChangeVisibility: Event<void>;
  onDidDispose: Event<void>;
}

// Mock Webview
export interface Webview {
  html: string;
  options: WebviewOptions;
  cspSource: string;
  onDidReceiveMessage: Event<unknown>;
  postMessage(message: unknown): Thenable<boolean>;
  asWebviewUri(localResource: Uri): Uri;
}

// Mock WebviewOptions
export interface WebviewOptions {
  enableScripts?: boolean;
  localResourceRoots?: Uri[];
  retainContextWhenHidden?: boolean;
}

// Mock WebviewPanel
export interface WebviewPanel {
  viewType: string;
  title: string;
  webview: Webview;
  visible: boolean;
  active: boolean;
  onDidChangeViewState: Event<unknown>;
  onDidDispose: Event<void>;
  reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
  dispose(): void;
}

// Mock WebviewViewResolveContext
export interface WebviewViewResolveContext {
  state?: unknown;
}

// Mock CancellationToken
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: Event<unknown>;
}

// Mock window namespace
// Active-editor change listeners registered via `window.onDidChangeActiveTextEditor`.
// Tests drive a file switch with `fireActiveTextEditor(editor)`.
const _activeEditorListeners: Array<(e: unknown) => void> = [];

/** Fire a simulated active-editor change to every registered listener. */
export function fireActiveTextEditor(editor: unknown): void {
  window.activeTextEditor = editor;
  for (const listener of [..._activeEditorListeners]) {
    listener(editor);
  }
}

export const window = {
  showInformationMessage: async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    return undefined;
  },
  showErrorMessage: async (_message: string, ..._items: string[]): Promise<string | undefined> => {
    return undefined;
  },
  showWarningMessage: async (
    _message: string,
    ..._items: string[]
  ): Promise<string | undefined> => {
    return undefined;
  },
  showQuickPick: async (_items: unknown[], _options?: unknown): Promise<unknown> => {
    return undefined;
  },
  showInputBox: async (options?: { value?: string }): Promise<string | undefined> => {
    return options?.value;
  },
  showSaveDialog: async (_options?: unknown): Promise<Uri | undefined> => {
    return undefined;
  },
  // Mock for `vscode.window.showTextDocument`. Default
  // returns a minimal stub editor; tests override on the writable
  // `window` to drive the squash-editor flow without a real editor.
  showTextDocument: async (
    document: unknown,
    _options?: unknown
  ): Promise<{ document: unknown }> => {
    return { document };
  },

  // `_promptForSquashMessage` now uses the
  // tab API (`vscode.window.tabGroups`) to close the squash editor
  // specifically rather than `workbench.action.closeActiveEditor`
  // (which would close whatever was active when focus shifted). The
  // mock returns an empty group set by default; tests stub
  // `tabGroups.all` + `tabGroups.close` to drive the close path.
  tabGroups: {
    all: [] as { tabs: { input: unknown; label: string }[] }[],
    close: async (_tab: unknown): Promise<boolean> => true,
  },
  createOutputChannel(name: string): {
    name: string;
    _lines: string[];
    append(value: string): void;
    appendLine(value: string): void;
    clear(): void;
    show(): void;
    hide(): void;
    dispose(): void;
    replace(value: string): void;
  } {
    // Minimal stub — captures every `appendLine` call in `_lines` so
    // tests asserting OutputChannel routing (safeFireAndForget with
    // `options.outputChannel`) can inspect what was written. Each
    // call returns a fresh instance; production code caches a
    // singleton, but tests are free to construct their own.
    return {
      name,
      _lines: [],
      append(value: string): void {
        // `append` without newline — tests usually assert via appendLine,
        // but we capture both for symmetry.
        this._lines.push(value);
      },
      appendLine(value: string): void {
        this._lines.push(value);
      },
      clear(): void {
        this._lines = [];
      },
      show(): void {
        /* no-op in tests */
      },
      hide(): void {
        /* no-op in tests */
      },
      dispose(): void {
        /* no-op in tests */
      },
      replace(value: string): void {
        this._lines = [value];
      },
    };
  },
  createStatusBarItem(
    _alignment?: unknown,
    _priority?: number
  ): {
    text: string;
    tooltip: string | undefined;
    command: string | { title: string; command: string; arguments?: unknown[] } | undefined;
    alignment: unknown;
    priority: number | undefined;
    show(): void;
    hide(): void;
    dispose(): void;
    _shown: boolean;
    _disposed: boolean;
  } {
    // Minimal stub implementation — captures `text`, `tooltip`, `command`
    // so tests can assert on the rendered badge state. The underlying VS
    // Code runtime creates a real StatusBarItem; here we only need observable
    // state.
    return {
      text: '',
      tooltip: undefined,
      command: undefined,
      alignment: _alignment,
      priority: _priority,
      _shown: false,
      _disposed: false,
      show(): void {
        this._shown = true;
      },
      hide(): void {
        this._shown = false;
      },
      dispose(): void {
        this._disposed = true;
      },
    };
  },
  onDidChangeActiveTextEditor(listener: (e: unknown) => void): { dispose: () => void } {
    _activeEditorListeners.push(listener);
    return {
      dispose: (): void => {
        const i = _activeEditorListeners.indexOf(listener);
        if (i >= 0) {
          _activeEditorListeners.splice(i, 1);
        }
      },
    };
  },
  onDidChangeTextEditorSelection(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },
  onDidChangeTextEditorVisibleRanges(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },
  registerWebviewViewProvider(
    _viewId: string,
    _provider: WebviewViewProvider,
    _options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }
  ): { dispose: () => void } {
    return { dispose: () => {} };
  },
  createTextEditorDecorationType(_options: unknown): { dispose: () => void } {
    return { dispose: () => {} };
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
    _options?: WebviewOptions
  ): WebviewPanel {
    const messageEmitter = new EventEmitter<unknown>();
    const disposeEmitter = new EventEmitter<void>();
    const viewStateEmitter = new EventEmitter<unknown>();

    const postedMessages: unknown[] = [];

    const webview: Webview & { _posted: unknown[] } = {
      html: '',
      options: _options ?? {},
      cspSource: 'vscode-webview://mock',
      onDidReceiveMessage: messageEmitter.event,
      postMessage: async (message: unknown): Promise<boolean> => {
        postedMessages.push(message);
        return true;
      },
      asWebviewUri: (localResource: Uri): Uri => localResource,
      _posted: postedMessages,
    };

    let disposeCallCount = 0;
    let revealCallCount = 0;

    const panel: WebviewPanel & {
      _disposeCallCount: number;
      _revealCallCount: number;
      _fireMessage: (message: unknown) => void;
    } = {
      viewType,
      title,
      webview,
      visible: true,
      active: true,
      onDidChangeViewState: viewStateEmitter.event,
      onDidDispose: disposeEmitter.event,
      reveal: (_viewColumn?: ViewColumn, _preserveFocus?: boolean): void => {
        revealCallCount++;
        panel._revealCallCount = revealCallCount;
      },
      dispose: (): void => {
        disposeCallCount++;
        panel._disposeCallCount = disposeCallCount;
        if (disposeCallCount === 1) {
          disposeEmitter.fire();
        }
      },
      _disposeCallCount: 0,
      _revealCallCount: 0,
      _fireMessage: (message: unknown): void => {
        messageEmitter.fire(message);
      },
    };

    // Use showOptions to avoid unused-var lint; accept either column or object.
    if (typeof showOptions === 'object' && showOptions !== null) {
      // no-op; columns aren't meaningful in the mock
    }

    return panel;
  },
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
};

// Mock env namespace
export const env = {
  clipboard: {
    readText: async (): Promise<string> => '',
    writeText: async (_value: string): Promise<void> => {},
  },
};

// Mock commands namespace
export const commands = {
  registerCommand(
    _command: string,
    _callback: (...args: unknown[]) => unknown
  ): { dispose: () => void } {
    return { dispose: () => {} };
  },
  executeCommand: async <T>(_command: string, ..._rest: unknown[]): Promise<T | undefined> => {
    return undefined;
  },
};

// Mock Uri class
export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;

  private constructor(
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fragment: string
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path;
  }

  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }

  static parse(value: string): Uri {
    return new Uri('file', '', value, '', '');
  }

  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? '',
      components.path ?? '',
      components.query ?? '',
      components.fragment ?? ''
    );
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = pathSegments.reduce((acc, seg) => `${acc}/${seg}`, base.path);
    return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toJSON(): any {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath,
    };
  }

  with(_change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      _change.scheme ?? this.scheme,
      _change.authority ?? this.authority,
      _change.path ?? this.path,
      _change.query ?? this.query,
      _change.fragment ?? this.fragment
    );
  }
}

// Mock Range class
export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position, end: Position);
  constructor(
    startLineOrPosition: number | Position,
    startCharacterOrEnd: number | Position,
    endLine?: number,
    endCharacter?: number
  ) {
    if (typeof startLineOrPosition === 'number') {
      this.start = new Position(startLineOrPosition, startCharacterOrEnd as number);
      this.end = new Position(endLine!, endCharacter!);
    } else {
      this.start = startLineOrPosition;
      this.end = startCharacterOrEnd as Position;
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(_positionOrRange: Position | Range): boolean {
    return true;
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(_range: Range): Range | undefined {
    return undefined;
  }

  union(other: Range): Range {
    return new Range(
      this.start.isBefore(other.start) ? this.start : other.start,
      this.end.isAfter(other.end) ? this.end : other.end
    );
  }

  with(start?: Position, end?: Position): Range {
    return new Range(start ?? this.start, end ?? this.end);
  }
}

// Mock Position class
export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }

  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }

  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: Position): number {
    if (this.isBefore(other)) {
      return -1;
    }
    if (this.isAfter(other)) {
      return 1;
    }
    return 0;
  }

  translate(lineDelta?: number, characterDelta?: number): Position {
    return new Position(this.line + (lineDelta ?? 0), this.character + (characterDelta ?? 0));
  }

  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character);
  }
}

// Mock Disposable class
export class Disposable {
  private _callOnDispose: () => void;

  constructor(callOnDispose: () => void) {
    this._callOnDispose = callOnDispose;
  }

  static from(...disposables: { dispose: () => void }[]): Disposable {
    return new Disposable(() => {
      disposables.forEach((d) => d.dispose());
    });
  }

  dispose(): void {
    this._callOnDispose();
  }
}

// Mock ExtensionContext
export interface ExtensionContext {
  subscriptions: { dispose: () => void }[];
  workspaceState: Memento;
  globalState: Memento;
  extensionPath: string;
  storagePath: string | undefined;
  globalStoragePath: string;
  logPath: string;
  extensionUri: Uri;
  storageUri: Uri | undefined;
  globalStorageUri: Uri;
  logUri: Uri;
  extensionMode: ExtensionMode;
  asAbsolutePath(relativePath: string): string;
}

// Mock Memento
export interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

// Mock ExtensionMode
export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

// Mock MarkdownString class
export class MarkdownString {
  value: string = '';
  isTrusted: boolean | { readonly enabledCommands: readonly string[] } = false;
  supportHtml: boolean = false;
  supportThemeIcons: boolean = false;

  constructor(value?: string, supportThemeIcons?: boolean) {
    this.value = value ?? '';
    this.supportThemeIcons = supportThemeIcons ?? false;
  }

  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language?: string): MarkdownString {
    this.value += `\`\`\`${language ?? ''}\n${value}\n\`\`\``;
    return this;
  }
}

// Mock TreeItemCollapsibleState enum
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

// Mock ThemeColor class
export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// Mock ThemeIcon class
export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  readonly id: string;
  readonly color?: ThemeColor;

  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

// Mock TreeItem class
export class TreeItem {
  label?: string;
  id?: string;
  iconPath?: ThemeIcon | Uri;
  description?: string | boolean;
  tooltip?: string | MarkdownString;
  command?: { command: string; title: string; arguments?: unknown[] };
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;
  resourceUri?: Uri;

  constructor(labelOrUri: string | Uri, collapsibleState?: TreeItemCollapsibleState) {
    if (typeof labelOrUri === 'string') {
      this.label = labelOrUri;
    } else {
      this.resourceUri = labelOrUri;
    }
    this.collapsibleState = collapsibleState;
  }
}

/**
 * Reset the mock configuration to defaults.
 * Useful for test cleanup.
 */
export function resetMockConfiguration(): void {
  configurationStore.clear();
  initializeDefaultConfig();
}

/**
 * Synthesize a `vscode.workspace.onDidChangeWorkspaceFolders` event so
 * production listeners (e.g. `GitService`'s folder-removal handler) can
 * be exercised in unit tests. Pass `removed` and/or `added` arrays of
 * `{ uri, name, index }` workspace-folder shapes.
 *
 * Earlier the mock's `onDidChangeWorkspaceFolders`
 * was a stub that didn't deliver events, so tests couldn't verify the
 * `onDidRemoveRepository` event fires on the COMMON folder-removal path
 * (only the EXOTIC `.git/HEAD`-deletion path was reachable).
 *
 * @param event Object with optional `removed` + `added` workspace-folder lists.
 */
export function fireWorkspaceFoldersChange(event: {
  removed?: { uri: Uri; name: string; index: number }[];
  added?: { uri: Uri; name: string; index: number }[];
}): void {
  const payload = {
    removed: event.removed ?? [],
    added: event.added ?? [],
  };
  for (const listener of [...workspaceFoldersListeners]) {
    listener(payload);
  }
}

/**
 * Set a mock configuration value at a specific scope.
 *
 * Writes default to `ConfigurationTarget.Global`
 * But tests that need to assert
 * the user-set vs schema-default distinction can pass an explicit
 * target. Setting `value === undefined` clears the user value at
 * that scope (mirrors `vscode.workspace.getConfiguration().update(key, undefined, target)`).
 *
 * For schema-default writes use `setMockSchemaDefault` below.
 *
 * @param section - configuration section (e.g. 'intellig').
 * @param key - configuration key within the section.
 * @param value - the new value, or undefined to clear at the target scope.
 * @param target - which scope to write to; defaults to Global.
 */
export function setMockConfigValue(
  section: string,
  key: string,
  value: unknown,
  target: ConfigurationTarget = ConfigurationTarget.Global
): void {
  const sectionStore = ensureSection(section);
  const map =
    target === ConfigurationTarget.Workspace ? sectionStore.workspace : sectionStore.global;
  if (value === undefined) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

/**
 * Set a schema-default value for a key. Tests
 * rarely need this — `initializeDefaultConfig` populates the
 * standard set — but a few schema-evolution tests want to drive
 * the default directly.
 */
export function setMockSchemaDefault(section: string, key: string, value: unknown): void {
  const sectionStore = ensureSection(section);
  if (value === undefined) {
    sectionStore.schemaDefaults.delete(key);
  } else {
    sectionStore.schemaDefaults.set(key, value);
  }
}
