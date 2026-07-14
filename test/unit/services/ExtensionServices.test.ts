import * as assert from 'assert';
import {
  ExtensionServices,
  getExtensionServices,
  resetExtensionServices,
} from '../../../src/services/ExtensionServices';
import { GitService } from '../../../src/git-core/GitService';

describe('ExtensionServices', () => {
  // Reset the singleton before each test
  beforeEach(() => {
    resetExtensionServices();
  });

  // Clean up after all tests
  afterEach(() => {
    resetExtensionServices();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      const services = new ExtensionServices();
      assert.ok(services);
      assert.strictEqual(services.isInitialized, false);
      assert.strictEqual(services.isDisposed, false);
    });
  });

  describe('initialize', () => {
    it('should initialize services with a mock context', async () => {
      const services = new ExtensionServices();
      const mockSubscriptions: { dispose: () => void }[] = [];
      const mockContext = {
        subscriptions: mockSubscriptions,
      } as unknown as import('vscode').ExtensionContext;

      await services.initialize(mockContext);

      assert.strictEqual(services.isInitialized, true);
      assert.strictEqual(services.isDisposed, false);
      // Should have registered a disposable
      assert.strictEqual(mockSubscriptions.length, 1);
    });

    it('should not reinitialize if already initialized', async () => {
      const services = new ExtensionServices();
      const mockSubscriptions: { dispose: () => void }[] = [];
      const mockContext = {
        subscriptions: mockSubscriptions,
      } as unknown as import('vscode').ExtensionContext;

      await services.initialize(mockContext);
      await services.initialize(mockContext);

      // Should only have one subscription
      assert.strictEqual(mockSubscriptions.length, 1);
    });

    it('disposes already-constructed services when initialization fails partway', async () => {
      // A constructor between GitService (which starts watchers + workspace
      // listeners) and the end of init can throw; the catch must dispose what
      // was already built, or the GitService leaks its watchers/listeners with
      // no owner. `workspaceState` is read late (BlameOptionsSource), after the
      // GitService is constructed — a throwing getter injects a realistic
      // mid-init failure.
      const services = new ExtensionServices();
      const throwingContext = {
        subscriptions: [],
        get workspaceState(): never {
          throw new Error('injected init failure');
        },
      } as unknown as import('vscode').ExtensionContext;

      let gitDisposeCalls = 0;
      const originalDispose = GitService.prototype.dispose;
      (GitService.prototype as unknown as { dispose: () => void }).dispose = function (
        this: GitService
      ): void {
        gitDisposeCalls += 1;
        originalDispose.call(this);
      };

      try {
        await assert.rejects(() => services.initialize(throwingContext), /injected init failure/);
      } finally {
        (GitService.prototype as unknown as { dispose: () => void }).dispose = originalDispose;
      }

      assert.strictEqual(
        gitDisposeCalls,
        1,
        'the partially-built GitService must be disposed on init failure'
      );
      assert.strictEqual(
        services.isDisposed,
        true,
        'a failed initialize must leave the container disposed (no leaked listeners)'
      );
    });

    it('should reject if disposed', async () => {
      const services = new ExtensionServices();
      services.dispose();

      const mockContext = {
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;

      await assert.rejects(
        () => services.initialize(mockContext),
        /Cannot initialize disposed ExtensionServices/
      );
    });
  });

  describe('dispose', () => {
    it('should dispose services', async () => {
      const services = new ExtensionServices();
      const mockContext = {
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;

      await services.initialize(mockContext);
      services.dispose();

      assert.strictEqual(services.isDisposed, true);
      assert.strictEqual(services.isInitialized, false);
    });

    it('should be idempotent', () => {
      const services = new ExtensionServices();
      services.dispose();
      services.dispose(); // Should not throw
      assert.strictEqual(services.isDisposed, true);
    });

    it('disposes later services even when an earlier service dispose throws', () => {
      // If dispose() wraps all services in ONE try/catch, a throw from an
      // earlier service skips the rest — including GitService, whose .git/
      // file-watchers and workspace listeners then leak. Each service must be
      // disposed in its own try/catch so a single failure cannot skip the rest.
      const services = new ExtensionServices();

      let changelistDisposeCalls = 0;
      let configDisposeCalls = 0;

      // changelistService is disposed before configurationService in the chain.
      // Making it throw exercises the "one failure must not skip the rest" path.
      services.registerService('changelistService', {
        dispose: () => {
          changelistDisposeCalls++;
          throw new Error('injected changelistService dispose failure');
        },
      } as unknown as import('../../../src/services/interfaces').IChangelistService);

      services.registerService('configurationService', {
        dispose: () => {
          configDisposeCalls++;
        },
      } as unknown as import('../../../src/services/interfaces').IConfigurationService);

      // Must not throw (error is swallowed per-service)
      assert.doesNotThrow(() => services.dispose());

      assert.strictEqual(changelistDisposeCalls, 1, 'changelistService must be attempted');
      assert.strictEqual(
        configDisposeCalls,
        1,
        'configurationService must be disposed even when changelistService threw'
      );
      assert.strictEqual(services.isDisposed, true);
    });
  });

  describe('hasService', () => {
    it('should return false for unregistered services', () => {
      const services = new ExtensionServices();
      assert.strictEqual(services.hasService('gitService'), false);
      assert.strictEqual(services.hasService('changelistService'), false);
      assert.strictEqual(services.hasService('shelfService'), false);
      assert.strictEqual(services.hasService('rebaseService'), false);
      assert.strictEqual(services.hasService('blameService'), false);
      assert.strictEqual(services.hasService('configurationService'), false);
    });
  });

  describe('service getters', () => {
    it('should throw if not initialized', () => {
      const services = new ExtensionServices();

      assert.throws(() => services.gitService, /ExtensionServices not initialized/);
      assert.throws(() => services.changelistService, /ExtensionServices not initialized/);
      assert.throws(() => services.shelfService, /ExtensionServices not initialized/);
      assert.throws(() => services.rebaseService, /ExtensionServices not initialized/);
      assert.throws(() => services.blameService, /ExtensionServices not initialized/);
      assert.throws(() => services.configurationService, /ExtensionServices not initialized/);
    });

    it('should throw if disposed', async () => {
      const services = new ExtensionServices();
      const mockContext = {
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;

      await services.initialize(mockContext);
      services.dispose();

      assert.throws(() => services.gitService, /ExtensionServices has been disposed/);
    });
  });

  describe('registerService', () => {
    it('should throw if disposed', () => {
      const services = new ExtensionServices();
      services.dispose();

      assert.throws(
        () =>
          services.registerService(
            'gitService',
            {} as import('../../../src/services/interfaces').IGitService &
              import('../../../src/services/interfaces').IGitWorkingTreeEvents
          ),
        /Cannot register service on disposed ExtensionServices/
      );
    });
  });

  describe('getExtensionServices', () => {
    it('should return a singleton instance', () => {
      const instance1 = getExtensionServices();
      const instance2 = getExtensionServices();
      assert.strictEqual(instance1, instance2);
    });
  });

  describe('resetExtensionServices', () => {
    it('should dispose and clear the singleton', async () => {
      const instance1 = getExtensionServices();
      const mockContext = {
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;

      await instance1.initialize(mockContext);
      resetExtensionServices();

      const instance2 = getExtensionServices();
      assert.notStrictEqual(instance1, instance2);
      assert.strictEqual(instance2.isInitialized, false);
    });
  });
});
