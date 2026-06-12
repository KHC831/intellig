/**
 * Utility modules for the IntelliG VS Code extension.
 */

// Git CLI wrapper
export * from '../git-core/gitCli';

// Git output parsing utilities
export * from '../git-core/gitParser';

// Commit graph generation utilities
export * from '../git-core/commitGraph';

// Optimized commit graph generation for large repositories
export * from '../git-core/optimizedCommitGraph';

// Error handling utilities
export * from './errorHandler';

// Caching utilities for performance optimization
export * from './cache';

// Lazy loading utilities for large data sets
export * from './lazyLoader';

// Remote URL parser + hosting-link builders
export * from './remoteUrl';
export * from './hostingLinks';

// Commit-message HTML rendering with clickable issue links
export * from './commitMessageHtml';
