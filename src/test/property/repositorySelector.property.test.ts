/**
 * Property-based tests for the repository selector in GitToolWindowProvider.
 *
 * Feature: git-graph-visual-improvements
 *
 * Uses fast-check to verify universal correctness properties of the
 * repository selector across randomly generated inputs.
 *
 * Properties tested:
 * - Property 1: Repository selector visibility matches repository count
 * - Property 2: Repository selection updates provider state
 * - Property 3: Repository selector displays folder names
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { Uri } from '../mocks/vscode';
import { IRepository } from '../../services/interfaces/IGitService';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid folder name using safe characters (no HTML special chars).
 * Folder names are non-empty strings of alphanumeric characters, hyphens, and underscores.
 */
function arbitraryFolderName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
    ),
    { minLength: 1, maxLength: 30 }
  );
}

/**
 * Generate a valid Unix-style path with 1-4 segments ending in a folder name.
 */
function arbitraryPath(): fc.Arbitrary<string> {
  return fc.tuple(
    fc.array(arbitraryFolderName(), { minLength: 1, maxLength: 3 }),
    arbitraryFolderName()
  ).map(([segments, folderName]) => '/' + [...segments, folderName].join('/'));
}

/**
 * Generate a mock IRepository with a rootUri containing a given path.
 */
function createMockRepository(fsPath: string): IRepository {
  return {
    rootUri: Uri.file(fsPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as IRepository;
}

/**
 * Generate an arbitrary list of mock repositories with unique paths.
 * Length is between min and max (inclusive).
 */
function arbitraryRepositoryList(min: number, max: number): fc.Arbitrary<IRepository[]> {
  return fc.array(arbitraryPath(), { minLength: min, maxLength: max })
    .map(paths => {
      // Ensure unique paths
      const uniquePaths = [...new Set(paths)];
      return uniquePaths.map(p => createMockRepository(p));
    });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

/**
 * Extract the last path segment (folder name) from a Unix-style path.
 */
function getFolderName(fsPath: string): string {
  return fsPath.split('/').pop() || fsPath;
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-visual-improvements - Repository Selector Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 1: Repository selector visibility matches repository count', () => {
    /**
     * **Validates: Requirements 1.1, 1.2**
     *
     * For any list of repositories, the repository selector HTML should be present
     * if and only if the list contains more than one repository. When exactly one
     * repository exists, the selector should be absent.
     */
    it('Feature: git-graph-visual-improvements, Property 1: Repository selector visibility matches repository count', () => {
      fc.assert(
        fc.property(
          arbitraryRepositoryList(0, 10),
          (repos) => {
            provider.setAvailableRepositories(repos);
            const html = provider._getRepositorySelectorHtml();

            if (repos.length > 1) {
              // Selector should be present (contains a <select> element)
              assert.ok(
                html.includes('<select'),
                `Repository selector should be present when ${repos.length} repositories exist. Got: "${html}"`
              );
              assert.ok(
                html.includes('</select>'),
                `Repository selector should have a closing </select> tag when ${repos.length} repositories exist.`
              );
            } else {
              // Selector should be absent (empty string)
              assert.strictEqual(
                html,
                '',
                `Repository selector should be absent when ${repos.length} repository exists. Got: "${html}"`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 2: Repository selection updates provider state', () => {
    /**
     * **Validates: Requirements 1.3**
     *
     * For any valid repository index within the available repositories list,
     * calling the repository selection handler should update the provider's
     * selected repository index to match the requested index.
     */
    it('Feature: git-graph-visual-improvements, Property 2: Repository selection updates provider state', () => {
      fc.assert(
        fc.property(
          arbitraryRepositoryList(2, 10).chain(repos =>
            fc.tuple(
              fc.constant(repos),
              fc.integer({ min: 0, max: repos.length - 1 })
            )
          ),
          ([repos, selectedIndex]) => {
            provider.setAvailableRepositories(repos);

            // Call the private _handleRepositorySelection method via cast
            (provider as unknown as { _handleRepositorySelection: (index: number) => void })
              ._handleRepositorySelection(selectedIndex);

            // Verify the selected repository matches the requested index
            const selectedRepo = provider.getSelectedRepository();
            assert.ok(
              selectedRepo !== undefined,
              `Selected repository should not be undefined after selecting index ${selectedIndex}`
            );
            assert.strictEqual(
              selectedRepo!.rootUri.fsPath,
              repos[selectedIndex].rootUri.fsPath,
              `Selected repository fsPath should match repos[${selectedIndex}].rootUri.fsPath. ` +
              `Expected: "${repos[selectedIndex].rootUri.fsPath}", Got: "${selectedRepo!.rootUri.fsPath}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 3: Repository selector displays folder names', () => {
    /**
     * **Validates: Requirements 1.4**
     *
     * For any list of repositories with root URIs, the rendered repository
     * selector HTML should contain the folder name (last path segment) of
     * each repository's root URI.
     */
    it('Feature: git-graph-visual-improvements, Property 3: Repository selector displays folder names', () => {
      fc.assert(
        fc.property(
          arbitraryRepositoryList(2, 10),
          (repos) => {
            provider.setAvailableRepositories(repos);
            const html = provider._getRepositorySelectorHtml();

            // Selector should be present since repos.length > 1
            assert.ok(
              html.includes('<select'),
              `Repository selector should be present when ${repos.length} repositories exist.`
            );

            // Each repository's folder name should appear in the HTML
            for (const repo of repos) {
              const folderName = getFolderName(repo.rootUri.fsPath);
              assert.ok(
                html.includes(folderName),
                `Repository selector HTML should contain folder name "${folderName}" ` +
                `from path "${repo.rootUri.fsPath}". HTML: "${html}"`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
