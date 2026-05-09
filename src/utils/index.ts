/**
 * Utility modules for the IntelliG VS Code extension.
 */

// Git CLI wrapper
export * from './gitCli';

// Git output parsing utilities
export * from './gitParser';

// Commit graph generation utilities
export * from './commitGraph';

// Optimized commit graph generation for large repositories
export * from './optimizedCommitGraph';

// Error handling utilities
export * from './errorHandler';

// Caching utilities for performance optimization
export * from './cache';

// Lazy loading utilities for large data sets
export * from './lazyLoader';

// T3-09: remote URL parser + hosting-link builders
export * from './remoteUrl';
export * from './hostingLinks';

// FU-1: commit-message HTML rendering with clickable issue links
export * from './commitMessageHtml';
