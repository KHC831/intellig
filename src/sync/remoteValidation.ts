/**
 * Remote name/URL validation, shared by the Configure Remotes flow (host) and
 * the Define Remote dialog's webview entry. Deliberately vscode-free so the
 * entry can import the same rules the host enforces.
 */

/**
 * Remote-name validation. Mirrors GitRefNameValidator's rules (remotes share
 * the ref-name charset) plus uniqueness against the repo's existing remotes;
 * `originalName` exempts an unchanged edit.
 */
export function validateRemoteName(
  name: string,
  existingNames: string[],
  originalName?: string
): string | undefined {
  if (!name || name.trim().length === 0) {
    return 'Remote name cannot be empty';
  }
  if (/\s/.test(name)) {
    return 'Remote name cannot contain whitespace';
  }
  if (/[~^:?*[\\]/.test(name)) {
    return 'Remote name cannot contain any of ~ ^ : ? * [ \\';
  }
  if (name.includes('..')) {
    return 'Remote name cannot contain consecutive dots';
  }
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) {
    return 'Remote name cannot start with -, ., or /';
  }
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) {
    return 'Remote name cannot end with ., /, or .lock';
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return 'Remote name cannot contain control characters';
    }
  }
  if (name !== originalName && existingNames.includes(name)) {
    return `Remote '${name}' already exists`;
  }
  return undefined;
}

/** Remote-URL validation: non-blank and not option-shaped. */
export function validateRemoteUrl(url: string): string | undefined {
  if (!url || url.trim().length === 0) {
    return 'Remote URL cannot be empty';
  }
  if (url.startsWith('-')) {
    return 'Remote URL cannot start with -';
  }
  return undefined;
}
