// Text-level helpers for the merge window: the engine and the webview work on
// LF-only text; the file's own separator is detected on load and restored on
// write-back.

const LF = '\n';
const CRLF = '\r\n';

/** The majority line separator of the text; LF when empty or tied toward LF. */
export function detectEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let bareLf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) {
        crlf++;
      } else {
        bareLf++;
      }
    }
  }
  return crlf > bareLf ? CRLF : LF;
}

/** Normalizes CRLF and lone CR separators to LF. */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, LF);
}

/** Converts LF-only text back to the detected separator. */
export function restoreEol(lfText: string, eol: '\n' | '\r\n'): string {
  if (eol === LF) {
    return lfText;
  }
  return lfText.replace(/\n/g, CRLF);
}
