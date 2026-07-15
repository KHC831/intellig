import * as vscode from 'vscode';
import { getLogger } from './logger';

/**
 * VS Code context keys this extension publishes via setContext, consumed by
 * package.json when-clauses. check:context-keys enforces that this map and the
 * when-clauses stay in sync, and that setContext is called nowhere else.
 */
export const CONTEXT_KEYS = {
  toolWindowActiveTab: 'intellig.toolWindow.activeTab',
  branchSearchActive: 'intellig.branchSearchActive',
  conflictsActive: 'intellig.conflicts.active',
} as const;

export type ContextKey = (typeof CONTEXT_KEYS)[keyof typeof CONTEXT_KEYS];

/** Value type per key. activeTab is a string tab id; the rest are booleans. */
export type ContextKeyValue = {
  'intellig.toolWindow.activeTab': string;
  'intellig.branchSearchActive': boolean;
  'intellig.conflicts.active': boolean;
};

/**
 * Publish a context key. setContext is unavailable in non-extension-host (unit)
 * runs and a failed UI context is non-fatal, so a rejection is logged at debug
 * and dropped — this centralizes the guard every call site used to repeat.
 */
export async function setContextKey<K extends ContextKey>(
  key: K,
  value: ContextKeyValue[K]
): Promise<void> {
  try {
    await vscode.commands.executeCommand('setContext', key, value);
  } catch (err) {
    getLogger().debug('setContextKey failed', {
      key,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
