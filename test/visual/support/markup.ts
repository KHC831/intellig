/**
 * Fixture surgery on production markup, with every edit proven to have landed.
 *
 * Specs render the markup the host emits, which ships context menus `hidden`
 * and positions them from script at show time. Reaching the shown state means
 * editing that string, and a `.replace()` whose pattern silently stops matching
 * is the quietest possible failure: the spec keeps running, measures a
 * `display: none` subtree, and stays green. Reordering a class list or moving
 * the `hidden` attribute is enough to trigger it.
 *
 * Every helper here throws when its edit does not apply, so a markup refactor
 * fails loudly instead of hollowing out the suite.
 */

/** Replaces exactly once, or throws naming what no longer matches. */
function replaceOrThrow(source: string, pattern: RegExp, replacement: string): string {
  const matches = source.match(new RegExp(pattern.source, pattern.flags + 'g'));
  if (matches === null) {
    throw new Error(
      `Fixture surgery did not apply: /${pattern.source}/ matched nothing in the production markup. ` +
        `The builder's output changed; update test/visual/support/markup.ts rather than letting ` +
        `the spec measure a hidden element.`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Fixture surgery is ambiguous: /${pattern.source}/ matched ${matches.length} times. ` +
        `Tighten the pattern so the edit is unambiguous.`
    );
  }
  return source.replace(pattern, replacement);
}

/**
 * A context menu in its shown state, anchored in the viewport.
 *
 * `elementId` is the menu's `id`, used to scope the positioning edit so it
 * cannot silently hit a different element.
 */
export function shownMenuMarkup(markup: string, elementId: string): string {
  // `hidden` serializes bare from an HTML string and as `hidden=""` from a
  // DOM the widget built, so the edit has to accept both spellings.
  const unhidden = replaceOrThrow(markup, /\s+hidden(="")?(?=[\s>])/, '');
  return replaceOrThrow(
    unhidden,
    new RegExp(`(<div id="${elementId}")`),
    '$1 style="position:fixed;top:40px;left:40px;"'
  );
}

/**
 * One menu item carrying an extra runtime class (`disabled`,
 * `menu-multi-hidden`), reproducing what the webview script toggles at show
 * time. Scoped to the item's `data-action` so the edit cannot silently land
 * on a different row, and throwing like every other edit here when the
 * production markup stops matching.
 */
export function withMenuItemClass(markup: string, action: string, extraClass: string): string {
  return replaceOrThrow(
    markup,
    new RegExp(`class="(context-menu-item[^"]*)"([^>]*? data-action="${action}")`),
    `class="$1 ${extraClass}"$2`
  );
}
