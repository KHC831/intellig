/**
 * Git's C-style quoting of paths and similar values in porcelain output.
 */

/**
 * Decode a git C-style-quoted path token back to its real UTF-8 string.
 *
 * The inverse of `StagingOps.escapePatchPath` / git's `quote_c_style`: a token
 * wrapped in double quotes is unescaped byte-wise (`\a \b \t \n \v \f \r \" \\`
 * and octal `\NNN`), then the assembled bytes are decoded as UTF-8. Under the
 * default core.quotePath git escapes each non-ASCII byte as octal, so `é`
 * arrives as `\303\251`; with core.quotePath=false it stays literal inside the
 * quotes, and both decode to the same string. A token without surrounding
 * quotes is returned unchanged.
 */
export function unquoteCStylePath(token: string): string {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') {
    return token;
  }
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  };

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      // A literal character is ASCII under the default core.quotePath, but
      // with core.quotePath=false git leaves non-ASCII as literal UTF-8 inside
      // the quotes, so take the whole code point and re-encode it.
      const codePoint = body.codePointAt(i) ?? 0;
      const char = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(char, 'utf8'));
      i += char.length - 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      break;
    }
    if (next >= '0' && next <= '7') {
      // Octal byte escape \NNN (1–3 digits).
      let oct = '';
      let k = i + 1;
      while (k < body.length && oct.length < 3 && body[k] >= '0' && body[k] <= '7') {
        oct += body[k];
        k += 1;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = k - 1;
      continue;
    }
    bytes.push(next in simple ? simple[next] : next.charCodeAt(0) & 0xff);
    i += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}
