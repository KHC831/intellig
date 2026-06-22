/**
 * Split a full webview HTML document into its runnable client script(s) and the
 * script-stripped body, so a test can feed both to {@link runWebviewScript}.
 *
 * Webview dialogs emit a complete `<!DOCTYPE html>…</html>` document with the
 * browser-side logic in one or more nonce'd `<script>` blocks (plus, for
 * `BaseWebviewPanel` subclasses, an empty sentinel `<script>` that exists only
 * to keep the CSP parser quiet). This helper concatenates the NON-empty inline
 * scripts and returns the `<body>` inner HTML with every `<script>` removed, so
 * the harness runs the real renderer code against the real host markup.
 */
export interface IExtractedWebview {
  /** Concatenated source of every non-empty inline `<script>`. */
  script: string;
  /** `<body>` inner HTML with all `<script>` blocks removed. */
  bodyHtml: string;
}

const SCRIPT_BLOCK = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const BODY_BLOCK = /<body\b[^>]*>([\s\S]*?)<\/body>/i;

export function extractWebviewScript(html: string): IExtractedWebview {
  const scripts: string[] = [];
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const inner = match[1];
    if (inner.trim().length > 0) {
      scripts.push(inner);
    }
  }

  const bodyMatch = BODY_BLOCK.exec(html);
  const body = bodyMatch ? bodyMatch[1] : html;
  const bodyHtml = body.replace(SCRIPT_BLOCK, '');

  return { script: scripts.join('\n;\n'), bodyHtml };
}
