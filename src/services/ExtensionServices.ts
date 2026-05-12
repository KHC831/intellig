import * as vscode from 'vscode';
import {
  IGitService,
  IChangelistService,
  IShelfService,
  IRebaseService,
  IBlameService,
  IConfigurationService,
  IConsoleService,
  IConflictResolutionService,
  IAutoFetchService,
  IPatchService,
} from './interfaces';
import { IGitServiceCli } from './interfaces/IGitService';
import { ConfigurationService } from './ConfigurationService';
import { GitService } from './GitService';
import { RebaseService } from './RebaseService';
import { ShelfService } from './ShelfService';
import { ChangelistService } from './ChangelistService';
import { BlameService } from './BlameService';
import { ConsoleService } from './ConsoleService';
import { ConflictResolutionService } from './ConflictResolutionService';
import { AutoFetchService } from './AutoFetchService';
import { PatchService } from './PatchService';
import { BlameOptionsSource } from './BlameOptionsSource';

/**
 * Extension services container interface.
 * Holds references to all core services used by the extension.
 */
export interface IExtensionServices {
  readonly gitService: IGitService;
  readonly changelistService: IChangelistService;
  readonly shelfService: IShelfService;
  readonly rebaseService: IRebaseService;
  readonly blameService: IBlameService;
  readonly configurationService: IConfigurationService;
  readonly consoleService: IConsoleService;
  readonly conflictResolutionService: IConflictResolutionService;
  readonly autoFetchService: IAutoFetchService;
  readonly patchService: IPatchService;
  /**
   * Persistent source of T2-08 blame options (ignoreWhitespace, detect
   * movements, hidden revisions). Shared by both blame providers and the
   * menu-command handlers so flag changes trigger a single re-blame.
   */
  readonly blameOptionsSource: BlameOptionsSource;

  /**
   * Initialize all services
   */
  initialize(context: vscode.ExtensionContext): Promise<void>;

  /**
   * Dispose of all services
   */
  dispose(): void;
}

/**
 * Extension services container implementation.
 * Manages the lifecycle of all extension services.
 */
export class ExtensionServices implements IExtensionServices {
  private _gitService: IGitService | undefined;
  private _changelistService: IChangelistService | undefined;
  private _shelfService: IShelfService | undefined;
  private _rebaseService: IRebaseService | undefined;
  private _blameService: IBlameService | undefined;
  private _configurationService: IConfigurationService | undefined;
  private _consoleService: ConsoleService | undefined;
  private _conflictResolutionService: IConflictResolutionService | undefined;
  private _autoFetchService: IAutoFetchService | undefined;
  private _patchService: IPatchService | undefined;
  private _blameOptionsSource: BlameOptionsSource | undefined;

  private _initialized = false;
  private _disposed = false;

  /**
   * Get the Git service instance
   * @throws Error if services not initialized
   */
  get gitService(): IGitService {
    this.ensureInitialized();
    return this._gitService!;
  }

  /**
   * Get the Changelist service instance
   * @throws Error if services not initialized
   */
  get changelistService(): IChangelistService {
    this.ensureInitialized();
    return this._changelistService!;
  }

  /**
   * Get the Shelf service instance
   * @throws Error if services not initialized
   */
  get shelfService(): IShelfService {
    this.ensureInitialized();
    return this._shelfService!;
  }

  /**
   * Get the Rebase service instance
   * @throws Error if services not initialized
   */
  get rebaseService(): IRebaseService {
    this.ensureInitialized();
    return this._rebaseService!;
  }

  /**
   * Get the Blame service instance
   * @throws Error if services not initialized
   */
  get blameService(): IBlameService {
    this.ensureInitialized();
    return this._blameService!;
  }

  /**
   * Get the Configuration service instance
   * @throws Error if services not initialized
   */
  get configurationService(): IConfigurationService {
    this.ensureInitialized();
    return this._configurationService!;
  }

  /**
   * Get the Console service instance
   * @throws Error if services not initialized
   */
  get consoleService(): IConsoleService {
    this.ensureInitialized();
    return this._consoleService!;
  }

  /**
   * Get the Conflict Resolution service instance
   * @throws Error if services not initialized
   */
  get conflictResolutionService(): IConflictResolutionService {
    this.ensureInitialized();
    return this._conflictResolutionService!;
  }

  /**
   * Get the Auto-Fetch service instance
   * @throws Error if services not initialized
   */
  get autoFetchService(): IAutoFetchService {
    this.ensureInitialized();
    return this._autoFetchService!;
  }

  /**
   * Get the Patch service instance (T1-12).
   * @throws Error if services not initialized
   */
  get patchService(): IPatchService {
    this.ensureInitialized();
    return this._patchService!;
  }

  /**
   * Get the Blame options source (T2-08).
   * @throws Error if services not initialized
   */
  get blameOptionsSource(): BlameOptionsSource {
    this.ensureInitialized();
    return this._blameOptionsSource!;
  }

  /**
   * Check if services have been initialized
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Check if services have been disposed
   */
  get isDisposed(): boolean {
    return this._disposed;
  }

  /**
   * Initialize all services.
   * This method should be called during extension activation.
   *
   * @param context - The VS Code extension context
   */
  initialize(context: vscode.ExtensionContext): Promise<void> {
    if (this._initialized) {
      console.warn('ExtensionServices already initialized');
      return Promise.resolve();
    }

    if (this._disposed) {
      return Promise.reject(new Error('Cannot initialize disposed ExtensionServices'));
    }

    console.log('Initializing IntelliG extension services...');

    try {
      // Initialize ConfigurationService first as other services may depend on it
      this._configurationService = new ConfigurationService();

      // Initialize GitService (Task 2.1)
      this._gitService = new GitService();

      // Initialize RebaseService (Task 6.1)
      this._rebaseService = new RebaseService();

      // Initialize ShelfService (Task 9.1)
      this._shelfService = new ShelfService();

      // Initialize ChangelistService (Task 10.1)
      //
      // Must be constructed with `this._gitService` so
      // `reconcileWithGitStatus()` can read git state and the
      // `onDidChangeRepository` subscription fires debounced reconciles.
      // Without the wire, every call into `reconcileWithGitStatus` is a
      // no-op — the symptom for the user is `intellig.shelve.silent`
      // reporting "No files in active changelist" against any dirty repo.
      this._changelistService = new ChangelistService(this._gitService);

      // Initialize BlameService (Task 17.1)
      this._blameService = new BlameService();

      // Initialize ConsoleService (Task 19.4)
      // Connects to GitService to capture command output
      this._consoleService = new ConsoleService();
      // Reach through the @internal IGitServiceCli escape hatch instead
      // of `instanceof GitService`. The composite IGitService
      // deliberately doesn't expose raw GitCli; any impl that wants to
      // opt into console-capture wires can implement IGitServiceCli.
      const cliEscape = this._gitService as unknown as Partial<IGitServiceCli>;
      if (cliEscape.gitCli) {
        this._consoleService.connectToGitCli(cliEscape.gitCli);
      }

      // Initialize ConflictResolutionService (Task 24.3)
      // Provides conflict detection, resolution, and merge/rebase completion
      this._conflictResolutionService = new ConflictResolutionService(this._gitService);

      // Initialize AutoFetchService (T1-03).
      // Schedules periodic fetches across all open repositories.
      this._autoFetchService = new AutoFetchService(this._gitService);

      // Initialize PatchService (T1-12).
      // Wraps git apply / git am / git diff for the Apply Patch + Create
      // Patch from Local Changes dialogs.
      this._patchService = new PatchService(this._gitService);

      // T2-08: blame options source backed by workspaceState for persistent
      // hidden-revision set + config for flag toggles.
      this._blameOptionsSource = new BlameOptionsSource(context.workspaceState);

      // Register the services container with the extension context
      // so it can be accessed by other components
      context.subscriptions.push({
        dispose: () => this.dispose(),
      });

      this._initialized = true;
      console.log('IntelliG extension services initialized successfully');
      return Promise.resolve();
    } catch (error) {
      console.error('Failed to initialize extension services:', error);
      return Promise.reject(error);
    }
  }

  /**
   * Register a service implementation.
   * This method is used to inject service implementations.
   *
   * @param serviceName - The name of the service to register
   * @param service - The service implementation
   */
  registerService<T extends keyof IServiceMap>(serviceName: T, service: IServiceMap[T]): void {
    if (this._disposed) {
      throw new Error('Cannot register service on disposed ExtensionServices');
    }

    switch (serviceName) {
      case 'gitService':
        this._gitService = service as IGitService;
        break;
      case 'changelistService':
        this._changelistService = service as IChangelistService;
        break;
      case 'shelfService':
        this._shelfService = service as IShelfService;
        break;
      case 'rebaseService':
        this._rebaseService = service as IRebaseService;
        break;
      case 'blameService':
        this._blameService = service as IBlameService;
        break;
      case 'configurationService':
        this._configurationService = service as IConfigurationService;
        break;
      case 'consoleService':
        this._consoleService = service as ConsoleService;
        break;
      case 'conflictResolutionService':
        this._conflictResolutionService = service as IConflictResolutionService;
        break;
      case 'autoFetchService':
        this._autoFetchService = service as IAutoFetchService;
        break;
      case 'patchService':
        this._patchService = service as IPatchService;
        break;
      default:
        throw new Error(`Unknown service: ${serviceName}`);
    }
  }

  /**
   * Check if a specific service is registered
   */
  hasService(serviceName: keyof IServiceMap): boolean {
    switch (serviceName) {
      case 'gitService':
        return this._gitService !== undefined;
      case 'changelistService':
        return this._changelistService !== undefined;
      case 'shelfService':
        return this._shelfService !== undefined;
      case 'rebaseService':
        return this._rebaseService !== undefined;
      case 'blameService':
        return this._blameService !== undefined;
      case 'configurationService':
        return this._configurationService !== undefined;
      case 'consoleService':
        return this._consoleService !== undefined;
      case 'conflictResolutionService':
        return this._conflictResolutionService !== undefined;
      case 'autoFetchService':
        return this._autoFetchService !== undefined;
      case 'patchService':
        return this._patchService !== undefined;
      default:
        return false;
    }
  }

  /**
   * Dispose of all services and clean up resources.
   * This method should be called during extension deactivation.
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    console.log('Disposing IntelliG extension services...');

    // Dispose services in reverse order of dependency
    try {
      this._blameOptionsSource?.dispose();
      this._patchService?.dispose();
      this._autoFetchService?.dispose();
      this._conflictResolutionService?.dispose();
      this._consoleService?.dispose();
      this._blameService?.dispose();
      this._rebaseService?.dispose();
      this._shelfService?.dispose();
      this._changelistService?.dispose();
      this._gitService?.dispose();
      this._configurationService?.dispose();
    } catch (error) {
      console.error('Error disposing services:', error);
    }

    // Clear references
    this._gitService = undefined;
    this._changelistService = undefined;
    this._shelfService = undefined;
    this._rebaseService = undefined;
    this._blameService = undefined;
    this._configurationService = undefined;
    this._consoleService = undefined;
    this._conflictResolutionService = undefined;
    this._autoFetchService = undefined;
    this._patchService = undefined;
    this._blameOptionsSource = undefined;

    this._disposed = true;
    this._initialized = false;

    console.log('IntelliG extension services disposed');
  }

  /**
   * Ensure services are initialized before access
   */
  private ensureInitialized(): void {
    if (this._disposed) {
      throw new Error('ExtensionServices has been disposed');
    }
    if (!this._initialized) {
      throw new Error('ExtensionServices not initialized. Call initialize() first.');
    }
  }
}

/**
 * Service name to type mapping
 */
interface IServiceMap {
  gitService: IGitService;
  changelistService: IChangelistService;
  shelfService: IShelfService;
  rebaseService: IRebaseService;
  blameService: IBlameService;
  configurationService: IConfigurationService;
  consoleService: IConsoleService;
  conflictResolutionService: IConflictResolutionService;
  autoFetchService: IAutoFetchService;
  patchService: IPatchService;
}

/**
 * Singleton instance of the extension services container.
 * This is the global access point for all extension services.
 */
let servicesInstance: ExtensionServices | undefined;

/**
 * Get the global extension services instance.
 * Creates a new instance if one doesn't exist.
 */
export function getExtensionServices(): ExtensionServices {
  if (!servicesInstance) {
    servicesInstance = new ExtensionServices();
  }
  return servicesInstance;
}

/**
 * Reset the global extension services instance.
 * This is primarily used for testing.
 */
export function resetExtensionServices(): void {
  if (servicesInstance) {
    servicesInstance.dispose();
    servicesInstance = undefined;
  }
}
