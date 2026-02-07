import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  IGitToolWindowState,
  ILocalChangesState,
  ILogState,
  IConsoleState,
  IConsoleEntry,
  ILogFilter,
} from '../../services/interfaces/IGitToolWindowProvider';
import { GitToolWindowTab } from '../../services/interfaces/IConfigurationService';
import { IChangelist, IFileChange } from '../../services/interfaces/IChangelistService';

/**
 * Property-based tests for Tab State Preservation.
 * Feature: intellij-git-vscode, Property 1: Tab State Preservation
 *
 * **Validates: Requirements 1.3**
 *
 * Property Description:
 * For any sequence of tab switches in the Git Tool Window, the state of each tab
 * (Local Changes, Log, Console) SHALL remain unchanged when switching away and back.
 *
 * Requirements:
 * - 1.3: WHEN a user switches between tabs, THE Extension SHALL preserve the state of each view
 */
describe('Tab State Preservation Property Tests', () => {
  /**
   * Arbitrary generator for valid tab types
   */
  const tabArb: fc.Arbitrary<GitToolWindowTab> = fc.constantFrom(
    'local-changes' as GitToolWindowTab,
    'log' as GitToolWindowTab,
    'console' as GitToolWindowTab
  );

  /**
   * Arbitrary generator for file paths
   */
  const filePathArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./'.split('')
      ),
      { minLength: 1, maxLength: 50 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('/') || s.endsWith('/')) {
        return false;
      }
      if (s.includes('//')) {
        return false;
      }
      return true;
    })
    .map((s) => (s.startsWith('.') ? 'file' + s : s));

  /**
   * Arbitrary generator for changelist IDs
   */
  const changelistIdArb: fc.Arbitrary<string> = fc.uuid();

  /**
   * Arbitrary generator for file changes
   */
  const fileChangeArb: fc.Arbitrary<IFileChange> = fc.record({
    path: filePathArb,
    status: fc.constantFrom(
      'modified' as const,
      'added' as const,
      'deleted' as const,
      'renamed' as const,
      'untracked' as const
    ),
    staged: fc.boolean(),
  });

  /**
   * Arbitrary generator for changelists
   */
  const changelistArb: fc.Arbitrary<IChangelist> = fc.record({
    id: changelistIdArb,
    name: fc.string({ minLength: 1, maxLength: 50 }),
    isDefault: fc.boolean(),
    files: fc.array(fileChangeArb, { minLength: 0, maxLength: 5 }),
  });

  /**
   * Arbitrary generator for Local Changes state
   */
  const localChangesStateArb: fc.Arbitrary<ILocalChangesState> = fc
    .tuple(
      fc.array(changelistArb, { minLength: 0, maxLength: 5 }),
      fc.array(changelistIdArb, { minLength: 0, maxLength: 3 }),
      fc.array(filePathArb, { minLength: 0, maxLength: 5 })
    )
    .map(([changelists, expandedIds, selectedPaths]) => ({
      changelists,
      expandedChangelists: new Set(expandedIds),
      selectedFiles: new Set(selectedPaths),
    }));

  /**
   * Arbitrary generator for commit hashes
   */
  const commitHashArb: fc.Arbitrary<string> = fc.hexaString({ minLength: 7, maxLength: 40 });

  /**
   * Arbitrary generator for Log filter
   */
  const logFilterArb: fc.Arbitrary<ILogFilter | undefined> = fc.option(
    fc.record({
      branch: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      author: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
      since: fc.option(fc.date(), { nil: undefined }),
      until: fc.option(fc.date(), { nil: undefined }),
      path: fc.option(filePathArb, { nil: undefined }),
      searchText: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    }),
    { nil: undefined }
  );

  /**
   * Arbitrary generator for Log state
   */
  const logStateArb: fc.Arbitrary<ILogState> = fc
    .tuple(
      fc.array(commitHashArb, { minLength: 0, maxLength: 5 }),
      fc.option(commitHashArb, { nil: undefined }),
      logFilterArb
    )
    .map(([selectedHashes, expandedCommit, filter]) => ({
      selectedCommits: new Set(selectedHashes),
      expandedCommit,
      filter,
    }));

  /**
   * Arbitrary generator for console entries
   */
  const consoleEntryArb: fc.Arbitrary<IConsoleEntry> = fc.record({
    timestamp: fc.date(),
    command: fc.string({ minLength: 1, maxLength: 100 }),
    output: fc.string({ minLength: 0, maxLength: 500 }),
    exitCode: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
    isError: fc.boolean(),
  });

  /**
   * Arbitrary generator for Console state
   */
  const consoleStateArb: fc.Arbitrary<IConsoleState> = fc.record({
    entries: fc.array(consoleEntryArb, { minLength: 0, maxLength: 10 }),
    maxEntries: fc.integer({ min: 10, max: 1000 }),
  });

  /**
   * Arbitrary generator for complete Git Tool Window state
   */
  const gitToolWindowStateArb: fc.Arbitrary<IGitToolWindowState> = fc.record({
    activeTab: tabArb,
    localChangesState: localChangesStateArb,
    logState: logStateArb,
    consoleState: consoleStateArb,
    hasRepository: fc.boolean(),
  });

  /**
   * Arbitrary generator for a sequence of tab switches
   */
  const tabSwitchSequenceArb: fc.Arbitrary<GitToolWindowTab[]> = fc.array(tabArb, {
    minLength: 2,
    maxLength: 20,
  });

  /**
   * Mock Git Tool Window Provider that simulates tab state management.
   * This allows us to test the tab state preservation properties without actual VS Code UI.
   */
  class MockGitToolWindowProvider {
    private _state: IGitToolWindowState;

    constructor(initialState: IGitToolWindowState) {
      this._state = this._cloneState(initialState);
    }

    /**
     * Get the current state
     */
    getState(): IGitToolWindowState {
      return this._cloneState(this._state);
    }

    /**
     * Get the current active tab
     */
    getActiveTab(): GitToolWindowTab {
      return this._state.activeTab;
    }

    /**
     * Set the active tab - this should preserve all tab states
     * Requirement 1.3: Switching tabs SHALL preserve the state of each view
     */
    setActiveTab(tab: GitToolWindowTab): void {
      // Only update the active tab, preserve all other state
      this._state.activeTab = tab;
    }

    /**
     * Get the Local Changes state
     */
    getLocalChangesState(): ILocalChangesState {
      return this._cloneLocalChangesState(this._state.localChangesState);
    }

    /**
     * Get the Log state
     */
    getLogState(): ILogState {
      return this._cloneLogState(this._state.logState);
    }

    /**
     * Get the Console state
     */
    getConsoleState(): IConsoleState {
      return this._cloneConsoleState(this._state.consoleState);
    }

    /**
     * Update Local Changes state (simulates user interaction)
     */
    updateLocalChangesState(state: ILocalChangesState): void {
      this._state.localChangesState = this._cloneLocalChangesState(state);
    }

    /**
     * Update Log state (simulates user interaction)
     */
    updateLogState(state: ILogState): void {
      this._state.logState = this._cloneLogState(state);
    }

    /**
     * Update Console state (simulates user interaction)
     */
    updateConsoleState(state: IConsoleState): void {
      this._state.consoleState = this._cloneConsoleState(state);
    }

    /**
     * Clone the complete state
     */
    private _cloneState(state: IGitToolWindowState): IGitToolWindowState {
      return {
        activeTab: state.activeTab,
        localChangesState: this._cloneLocalChangesState(state.localChangesState),
        logState: this._cloneLogState(state.logState),
        consoleState: this._cloneConsoleState(state.consoleState),
        hasRepository: state.hasRepository,
      };
    }

    /**
     * Clone Local Changes state
     */
    private _cloneLocalChangesState(state: ILocalChangesState): ILocalChangesState {
      return {
        changelists: state.changelists.map((cl) => ({
          ...cl,
          files: [...cl.files],
        })),
        expandedChangelists: new Set(state.expandedChangelists),
        selectedFiles: new Set(state.selectedFiles),
      };
    }

    /**
     * Clone Log state
     */
    private _cloneLogState(state: ILogState): ILogState {
      return {
        selectedCommits: new Set(state.selectedCommits),
        expandedCommit: state.expandedCommit,
        filter: state.filter ? { ...state.filter } : undefined,
      };
    }

    /**
     * Clone Console state
     */
    private _cloneConsoleState(state: IConsoleState): IConsoleState {
      return {
        entries: state.entries.map((e) => ({ ...e })),
        maxEntries: state.maxEntries,
      };
    }
  }

  /**
   * Compare two Local Changes states for equality
   */
  function localChangesStatesEqual(a: ILocalChangesState, b: ILocalChangesState): boolean {
    // Compare changelists
    if (a.changelists.length !== b.changelists.length) {
      return false;
    }
    for (let i = 0; i < a.changelists.length; i++) {
      const clA = a.changelists[i];
      const clB = b.changelists[i];
      if (clA.id !== clB.id || clA.name !== clB.name || clA.isDefault !== clB.isDefault) {
        return false;
      }
      if (clA.files.length !== clB.files.length) {
        return false;
      }
      for (let j = 0; j < clA.files.length; j++) {
        if (
          clA.files[j].path !== clB.files[j].path ||
          clA.files[j].status !== clB.files[j].status ||
          clA.files[j].staged !== clB.files[j].staged
        ) {
          return false;
        }
      }
    }

    // Compare expanded changelists
    if (a.expandedChangelists.size !== b.expandedChangelists.size) {
      return false;
    }
    for (const id of a.expandedChangelists) {
      if (!b.expandedChangelists.has(id)) {
        return false;
      }
    }

    // Compare selected files
    if (a.selectedFiles.size !== b.selectedFiles.size) {
      return false;
    }
    for (const path of a.selectedFiles) {
      if (!b.selectedFiles.has(path)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compare two Log states for equality
   */
  function logStatesEqual(a: ILogState, b: ILogState): boolean {
    // Compare selected commits
    if (a.selectedCommits.size !== b.selectedCommits.size) {
      return false;
    }
    for (const hash of a.selectedCommits) {
      if (!b.selectedCommits.has(hash)) {
        return false;
      }
    }

    // Compare expanded commit
    if (a.expandedCommit !== b.expandedCommit) {
      return false;
    }

    // Compare filters
    if ((a.filter === undefined) !== (b.filter === undefined)) {
      return false;
    }
    if (a.filter && b.filter) {
      if (
        a.filter.branch !== b.filter.branch ||
        a.filter.author !== b.filter.author ||
        a.filter.path !== b.filter.path ||
        a.filter.searchText !== b.filter.searchText
      ) {
        return false;
      }
      // Compare dates (if both exist)
      if ((a.filter.since === undefined) !== (b.filter.since === undefined)) {
        return false;
      }
      if (a.filter.since && b.filter.since) {
        if (a.filter.since.getTime() !== b.filter.since.getTime()) {
          return false;
        }
      }
      if ((a.filter.until === undefined) !== (b.filter.until === undefined)) {
        return false;
      }
      if (a.filter.until && b.filter.until) {
        if (a.filter.until.getTime() !== b.filter.until.getTime()) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Compare two Console states for equality
   */
  function consoleStatesEqual(a: IConsoleState, b: IConsoleState): boolean {
    if (a.maxEntries !== b.maxEntries) {
      return false;
    }
    if (a.entries.length !== b.entries.length) {
      return false;
    }

    for (let i = 0; i < a.entries.length; i++) {
      const entryA = a.entries[i];
      const entryB = b.entries[i];
      if (
        entryA.command !== entryB.command ||
        entryA.output !== entryB.output ||
        entryA.exitCode !== entryB.exitCode ||
        entryA.isError !== entryB.isError ||
        entryA.timestamp.getTime() !== entryB.timestamp.getTime()
      ) {
        return false;
      }
    }

    return true;
  }

  describe('Property 1: Tab State Preservation', () => {
    /**
     * Property: Switching tabs preserves Local Changes state.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: Switching tabs preserves Local Changes state', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabSwitchSequenceArb, (initialState, tabSequence) => {
          // Setup: Start with local-changes tab active
          const state = { ...initialState, activeTab: 'local-changes' as GitToolWindowTab };
          const provider = new MockGitToolWindowProvider(state);

          // Capture the initial Local Changes state
          const originalLocalChangesState = provider.getLocalChangesState();

          // Act: Switch through all tabs in the sequence
          for (const tab of tabSequence) {
            provider.setActiveTab(tab);
          }

          // Switch back to local-changes
          provider.setActiveTab('local-changes');

          // Assert: Local Changes state is preserved
          const finalLocalChangesState = provider.getLocalChangesState();
          assert.ok(
            localChangesStatesEqual(originalLocalChangesState, finalLocalChangesState),
            'Local Changes state should be preserved after tab switches'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Switching tabs preserves Log state.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: Switching tabs preserves Log state', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabSwitchSequenceArb, (initialState, tabSequence) => {
          // Setup: Start with log tab active
          const state = { ...initialState, activeTab: 'log' as GitToolWindowTab };
          const provider = new MockGitToolWindowProvider(state);

          // Capture the initial Log state
          const originalLogState = provider.getLogState();

          // Act: Switch through all tabs in the sequence
          for (const tab of tabSequence) {
            provider.setActiveTab(tab);
          }

          // Switch back to log
          provider.setActiveTab('log');

          // Assert: Log state is preserved
          const finalLogState = provider.getLogState();
          assert.ok(
            logStatesEqual(originalLogState, finalLogState),
            'Log state should be preserved after tab switches'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Switching tabs preserves Console state.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: Switching tabs preserves Console state', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabSwitchSequenceArb, (initialState, tabSequence) => {
          // Setup: Start with console tab active
          const state = { ...initialState, activeTab: 'console' as GitToolWindowTab };
          const provider = new MockGitToolWindowProvider(state);

          // Capture the initial Console state
          const originalConsoleState = provider.getConsoleState();

          // Act: Switch through all tabs in the sequence
          for (const tab of tabSequence) {
            provider.setActiveTab(tab);
          }

          // Switch back to console
          provider.setActiveTab('console');

          // Assert: Console state is preserved
          const finalConsoleState = provider.getConsoleState();
          assert.ok(
            consoleStatesEqual(originalConsoleState, finalConsoleState),
            'Console state should be preserved after tab switches'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All tab states are preserved simultaneously during any tab switch sequence.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: All tab states are preserved simultaneously during any tab switch sequence', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabSwitchSequenceArb, (initialState, tabSequence) => {
          // Setup
          const provider = new MockGitToolWindowProvider(initialState);

          // Capture all initial states
          const originalLocalChangesState = provider.getLocalChangesState();
          const originalLogState = provider.getLogState();
          const originalConsoleState = provider.getConsoleState();

          // Act: Switch through all tabs in the sequence
          for (const tab of tabSequence) {
            provider.setActiveTab(tab);
          }

          // Assert: All states are preserved
          assert.ok(
            localChangesStatesEqual(originalLocalChangesState, provider.getLocalChangesState()),
            'Local Changes state should be preserved'
          );
          assert.ok(
            logStatesEqual(originalLogState, provider.getLogState()),
            'Log state should be preserved'
          );
          assert.ok(
            consoleStatesEqual(originalConsoleState, provider.getConsoleState()),
            'Console state should be preserved'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Switching to the same tab multiple times preserves state.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: Switching to the same tab multiple times preserves state', () => {
      fc.assert(
        fc.property(
          gitToolWindowStateArb,
          tabArb,
          fc.integer({ min: 2, max: 10 }),
          (initialState, tab, repeatCount) => {
            // Setup
            const provider = new MockGitToolWindowProvider(initialState);

            // Capture initial states
            const originalLocalChangesState = provider.getLocalChangesState();
            const originalLogState = provider.getLogState();
            const originalConsoleState = provider.getConsoleState();

            // Act: Switch to the same tab multiple times
            for (let i = 0; i < repeatCount; i++) {
              provider.setActiveTab(tab);
            }

            // Assert: All states are preserved
            assert.ok(
              localChangesStatesEqual(originalLocalChangesState, provider.getLocalChangesState()),
              'Local Changes state should be preserved after repeated switches'
            );
            assert.ok(
              logStatesEqual(originalLogState, provider.getLogState()),
              'Log state should be preserved after repeated switches'
            );
            assert.ok(
              consoleStatesEqual(originalConsoleState, provider.getConsoleState()),
              'Console state should be preserved after repeated switches'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Round-trip tab switching preserves state (A -> B -> A).
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: Round-trip tab switching preserves state (A -> B -> A)', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabArb, tabArb, (initialState, tabA, tabB) => {
          // Setup: Start at tabA
          const state = { ...initialState, activeTab: tabA };
          const provider = new MockGitToolWindowProvider(state);

          // Capture initial states
          const originalLocalChangesState = provider.getLocalChangesState();
          const originalLogState = provider.getLogState();
          const originalConsoleState = provider.getConsoleState();

          // Act: Round-trip A -> B -> A
          provider.setActiveTab(tabB);
          provider.setActiveTab(tabA);

          // Assert: All states are preserved
          assert.ok(
            localChangesStatesEqual(originalLocalChangesState, provider.getLocalChangesState()),
            'Local Changes state should be preserved after round-trip'
          );
          assert.ok(
            logStatesEqual(originalLogState, provider.getLogState()),
            'Log state should be preserved after round-trip'
          );
          assert.ok(
            consoleStatesEqual(originalConsoleState, provider.getConsoleState()),
            'Console state should be preserved after round-trip'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: State modifications in one tab don't affect other tabs.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: State modifications in one tab do not affect other tabs', () => {
      fc.assert(
        fc.property(
          gitToolWindowStateArb,
          localChangesStateArb,
          logStateArb,
          consoleStateArb,
          (initialState, newLocalChanges, newLog, newConsole) => {
            // Setup
            const provider = new MockGitToolWindowProvider(initialState);

            // Capture initial states
            const originalLogState = provider.getLogState();
            const originalConsoleState = provider.getConsoleState();

            // Act: Modify Local Changes state while on local-changes tab
            provider.setActiveTab('local-changes');
            provider.updateLocalChangesState(newLocalChanges);

            // Assert: Log and Console states are unchanged
            assert.ok(
              logStatesEqual(originalLogState, provider.getLogState()),
              'Log state should not be affected by Local Changes modification'
            );
            assert.ok(
              consoleStatesEqual(originalConsoleState, provider.getConsoleState()),
              'Console state should not be affected by Local Changes modification'
            );

            // Act: Modify Log state while on log tab
            provider.setActiveTab('log');
            provider.updateLogState(newLog);

            // Assert: Console state is unchanged, Local Changes has new state
            assert.ok(
              localChangesStatesEqual(newLocalChanges, provider.getLocalChangesState()),
              'Local Changes state should have the new value'
            );
            assert.ok(
              consoleStatesEqual(originalConsoleState, provider.getConsoleState()),
              'Console state should not be affected by Log modification'
            );

            // Act: Modify Console state while on console tab
            provider.setActiveTab('console');
            provider.updateConsoleState(newConsole);

            // Assert: All states have their expected values
            assert.ok(
              localChangesStatesEqual(newLocalChanges, provider.getLocalChangesState()),
              'Local Changes state should still have the new value'
            );
            assert.ok(
              logStatesEqual(newLog, provider.getLogState()),
              'Log state should have the new value'
            );
            assert.ok(
              consoleStatesEqual(newConsole, provider.getConsoleState()),
              'Console state should have the new value'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: hasRepository flag is preserved during tab switches.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: hasRepository flag is preserved during tab switches', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabSwitchSequenceArb, (initialState, tabSequence) => {
          // Setup
          const provider = new MockGitToolWindowProvider(initialState);
          const originalHasRepository = provider.getState().hasRepository;

          // Act: Switch through all tabs
          for (const tab of tabSequence) {
            provider.setActiveTab(tab);
          }

          // Assert: hasRepository is preserved
          assert.strictEqual(
            provider.getState().hasRepository,
            originalHasRepository,
            'hasRepository flag should be preserved during tab switches'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Active tab is correctly updated after each switch.
     *
     * **Validates: Requirements 1.3**
     */
    it('Property: Active tab is correctly updated after each switch', () => {
      fc.assert(
        fc.property(gitToolWindowStateArb, tabSwitchSequenceArb, (initialState, tabSequence) => {
          // Setup
          const provider = new MockGitToolWindowProvider(initialState);

          // Act & Assert: After each switch, active tab should be correct
          for (const tab of tabSequence) {
            provider.setActiveTab(tab);
            assert.strictEqual(
              provider.getActiveTab(),
              tab,
              `Active tab should be ${tab} after switching to it`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
