/** Opt-in directives layered onto the shared base CSP. */
interface IWebviewCspOptions {
  /** Allow `img-src ${cspSource} data:` — status icons, inlined images. */
  images?: boolean;
  /** Allow `font-src ${cspSource}` — the codicon glyph font. */
  fonts?: boolean;
}

/**
 * The single Content-Security-Policy directive set shared by every IntelliG
 * webview — the panel base ({@link import('./BaseWebviewPanel').BaseWebviewPanel}),
 * the view base ({@link import('./BaseWebviewView').BaseWebviewView}), and the
 * git tool window documents. One definition so a policy change cannot drift
 * between them: `default-src 'none'`; nonce-bound `script-src`; whitelisted
 * `style-src` against the webview's `cspSource`.
 *
 * `img-src` / `font-src` are opt-in (default on): the graph document needs them
 * for status icons and the codicon font, while the static pre-graph documents
 * (loading / no-repository / placeholder) and the plain dialog frames don't and
 * pass the minimal `{ images: false, fonts: false }` to narrow their surface.
 */
export function buildWebviewCsp(
  cspSource: string,
  nonce: string,
  options: IWebviewCspOptions = {}
): string {
  const { images = true, fonts = true } = options;
  let csp =
    `default-src 'none'; ` +
    `style-src ${cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}';`;
  if (images) {
    csp += ` img-src ${cspSource} data:;`;
  }
  if (fonts) {
    csp += ` font-src ${cspSource};`;
  }
  return csp;
}
