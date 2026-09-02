import { LITERAL_PATHSPEC_PREFIX as LITERAL_PREFIX } from '../../src/git-core/gitCli';

/**
 * The path a git pathspec targets, for fixtures that emulate a git path filter.
 *
 * Conflict paths reach git wrapped in the `:(literal)` magic signature so a
 * name holding `*`, `?` or `[` is matched as a filename rather than a pattern.
 * A fixture that compares the raw argument against its own file list sees only
 * the signature and matches nothing, which reads as "no conflict here" — the
 * shape that turns a resolve into a silent refusal.
 *
 * Only correct where the fixture FILTERS by pathspec (git honours the magic).
 * Where a fixture ECHOES the argument back as if it were git's own output
 * (e.g. emulating `check-attr`, which takes pathnames and never strips the
 * signature), stripping it here launders the wire format under test — use
 * the raw argv element instead.
 */
export function pathspecTarget(spec: string): string {
  return spec.startsWith(LITERAL_PREFIX) ? spec.slice(LITERAL_PREFIX.length) : spec;
}
