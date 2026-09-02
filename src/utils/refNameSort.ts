/**
 * ONE comparator for every git ref name this extension orders: branches,
 * remotes and tags in the Branches tree, and the same names again in the Git
 * tool window's branch filter (host-side grouping and the webview's rendered
 * tree). Deliberately free of DOM types so both a host module and a webview
 * module can import it without pulling `document`/`window` into a
 * compilation unit that doesn't otherwise need them.
 *
 * A bare `.sort()` orders by code unit and puts every capitalised name ahead
 * of every lowercase one, so a surface that mixes it with a locale-aware sort
 * (or with another surface that already uses this comparator) orders halves
 * of the same tree, or two related surfaces, by different rules.
 */
export function compareRefNames(a: string, b: string): number {
  return a.localeCompare(b);
}
