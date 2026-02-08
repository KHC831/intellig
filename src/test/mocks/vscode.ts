/**
 * Mock implementation of the VS Code API for unit testing.
 * This allows tests to run outside of the VS Code extension host.
 */

/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/require-await */
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

// Mock configuration storage
const configurationStore: Map<string, Map<string, unknown>> = new Map();

// Initialize default configuration values
function initializeDefaultConfig(): void {
  const intellijGitConfig = new Map<string, unknown>();
  intellijGitConfig.set('defaultCommitSignOff', false);
  intellijGitConfig.set('commitMessageTemplate', '');
  intellijGitConfig.set('pullRebase', false);
  intellijGitConfig.set('autoFetchEnabled', true);
  intellijGitConfig.set('autoFetchInterval', 180);
  intellijGitConfig.set('defaultToolWindowTab', 'local-changes');
  intellijGitConfig.set('blameAnnotationStyle', 'inline');
  intellijGitConfig.set('showStatusBarBranch', true);
  intellijGitConfig.set('useIntelliJKeymap', false);
  intellijGitConfig.set('modifiedFileColor', '#6897BB');
  intellijGitConfig.set('addedFileColor', '#629755');
  intellijGitConfig.set('deletedFileColor', '#6C6C6C');
  intellijGitConfig.set('ignoredFileColor', '#848504');
  intellijGitConfig.set('conflictFileColor', '#FF0000');
  configurationStore.set('intellig', intellijGitConfig);
}

// Initialize on module load
initializeDefaultConfig();

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

// Mock ConfigurationChangeEvent
export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean;
}

// Mock workspace namespace
export const workspace = {
  getConfiguration(section?: string): WorkspaceConfiguration {
    const sectionConfig = section ? configurationStore.get(section) : new Map();

    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const value = sectionConfig?.get(key);
        if (value !== undefined) {
          return value as T;
        }
        return defaultValue;
      },
      has(key: string): boolean {
        return sectionConfig?.has(key) ?? false;
      },
      inspect<T>(key: string) {
        const value = sectionConfig?.get(key);
        return {
          key: section ? `${section}.${key}` : key,
          defaultValue: value as T,
          globalValue: value as T,
        };
      },
      async update(
        key: string,
        value: unknown,
        _target?: ConfigurationTarget | boolean
      ): Promise<void> {
        if (section) {
          let sectionMap = configurationStore.get(section);
          if (!sectionMap) {
            sectionMap = new Map();
            configurationStore.set(section, sectionMap);
          }
          sectionMap.set(key, value);

          // Fire configuration change event
          const event: ConfigurationChangeEvent = {
            affectsConfiguration(s: string): boolean {
              return s === section || s.startsWith(`${section}.`);
            },
          };
          configChangeListeners.forEach((listener) => listener(event));
        }
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

  onDidChangeWorkspaceFolders(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },

  createFileSystemWatcher(
    _globPattern: string,
    _ignoreCreateEvents?: boolean,
    _ignoreChangeEvents?: boolean,
    _ignoreDeleteEvents?: boolean
  ): FileSystemWatcher {
    const createEmitter = new EventEmitter<Uri>();
    const changeEmitter = new EventEmitter<Uri>();
    const deleteEmitter = new EventEmitter<Uri>();

    return {
      onDidCreate: createEmitter.event,
      onDidChange: changeEmitter.event,
      onDidDelete: deleteEmitter.event,
      dispose: () => {
        createEmitter.dispose();
        changeEmitter.dispose();
        deleteEmitter.dispose();
      },
    };
  },

  onDidChangeTextDocument(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },

  onDidSaveTextDocument(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },

  workspaceFolders: undefined as unknown[] | undefined,
};

// Mock FileSystemWatcher
export interface FileSystemWatcher {
  onDidCreate: Event<Uri>;
  onDidChange: Event<Uri>;
  onDidDelete: Event<Uri>;
  dispose(): void;
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
  onDidChangeActiveTextEditor(_listener: (e: unknown) => void): { dispose: () => void } {
    return { dispose: () => {} };
  },
  onDidChangeTextEditorSelection(_listener: (e: unknown) => void): { dispose: () => void } {
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
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
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
  isTrusted: boolean = false;
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

  constructor(
    labelOrUri: string | Uri,
    collapsibleState?: TreeItemCollapsibleState
  ) {
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
 * Set a mock configuration value.
 * Useful for testing specific configuration scenarios.
 */
export function setMockConfigValue(section: string, key: string, value: unknown): void {
  let sectionMap = configurationStore.get(section);
  if (!sectionMap) {
    sectionMap = new Map();
    configurationStore.set(section, sectionMap);
  }
  sectionMap.set(key, value);
}
