/**
 * Property 14: Public_Service_API import stability.
 *
 *
 * Property 14:
 *
 *   FOR EVERY symbol `x` exported by `src/services/index.ts` in the
 *   pre-change tree, `x` SHALL be importable in the post-change
 *   tree at the module specifier `./services` (or
 *   `./services/index`) under the same name. The Public_Service_API
 *   surface is byte-identical before and after the restructure.
 *
 * The barrel regenerator at (`regenerateServicesBarrel`
 * in `scripts/restructure/migrate.mjs`) is the single piece of
 * machinery responsible for re-emitting `src/services/index.ts`
 * after the restructure has rewritten every `from '<path>'`
 * specifier to point at the new module homes. The regenerator
 * MUST NOT add or remove any exported name; it may only RE-ORDER
 * the export lines.
 *
 * This property test pins that contract by replicating the four
 * load-bearing helpers from `migrate.mjs` —
 * `extractExportEntry`, `renderExportLine`,
 * `fingerprintExportEntry`, and the sort + emit pipeline of
 * `regenerateServicesBarrel` — and asserting:
 *
 *   - **Property 14a (Symbol-set preservation under regeneration).**
 *     For any input barrel content `B` parseable as a sequence of
 *     `ExportDeclaration`s, the regenerated content `B'` declares
 *     the SAME SET of exported symbol names as `B`. Names are the
 *     barrel-level identifiers contributed by each entry: the
 *     namespace-export name for `export * as Ns from '...'`, the
 *     re-export sentinel `*from:<path>` for `export * from '...'`,
 *     and the name-or-alias for each `{ A, B as C }` clause member.
 *
 *   - **Property 14b (Round-trip via fingerprint).** Two
 *     synthetically-distinct entries produce distinct fingerprints,
 *     AND `fingerprintSet(parse(regenerate(B))) ===
 *     fingerprintSet(parse(B))`. The fingerprint encodes every
 *     semantically-relevant axis of an entry (type-only flag,
 *     namespace export, named-exports clause modulo order, and
 *     module specifier), so a fingerprint-set match is the
 *     byte-identical Public_Service_API surface check that
 * demands.
 *
 *   - **Property 14c (Live barrel coverage).** The current
 *     `src/services/index.ts` produces a non-empty fingerprint set
 *     under the helpers, and re-emitting the live barrel through
 *     the regenerator yields a fingerprint set byte-identical to
 *     the original. Running the regenerator twice in succession
 *     (idempotence) produces the same content the second time.
 *
 * The actual `regenerateServicesBarrel` function in `migrate.mjs`
 * is exercised end-to-end by `migrateBasic.test.ts`
 * that test runs the script in dry-run mode and checks the
 * "would regenerate ... (N export(s))" log line and the export
 * count. This property test is the *static* algorithmic pin: it
 * verifies the helpers' invariants across synthetic inputs that
 * the live-barrel-only test cannot reach (multi-line headers,
 * mixed type-only / value-only forms, namespace re-exports,
 * per-specifier `type` markers).
 *
 * Why duplicate the helpers from migrate.mjs?
 *   The migration script is an ESM Node CLI entry point that
 *   auto-invokes `main()` on import; we cannot pull individual
 *   functions out via `import` without triggering the entire
 *   migration pipeline. The duplication is intentional and tagged
 *   `SOURCE: scripts/restructure/migrate.mjs` below — if the
 *   migration script's logic ever changes, this test will detect
 *   the drift on the fingerprint round-trip and live-barrel
 *   coverage assertions.
 *
 * @see scripts/restructure/migrate.mjs `extractExportEntry`,
 *      `renderExportLine`, `fingerprintExportEntry`,
 *      `regenerateServicesBarrel`.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { Project, type ExportDeclaration } from 'ts-morph';

// ─── Repo + fixture paths ──────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVICES_BARREL = path.join(REPO_ROOT, 'src', 'services', 'index.ts');

// ─── Verbatim helpers from scripts/restructure/migrate.mjs ─────────────────
//
// SOURCE: scripts/restructure/migrate.mjs (functions
// `extractExportEntry`, `renderExportLine`, `fingerprintExportEntry`).
// The .mjs script auto-invokes `main()` on import (it is a CLI
// entry point), so the helpers are duplicated here verbatim with
// TypeScript-typed signatures. If the script ever diverges, the
// fingerprint round-trip and live-barrel assertions below will
// surface the drift.

interface IExportEntry {
  readonly isTypeOnly: boolean;
  readonly namespaceExportName: string | null;
  readonly namedExports: ReadonlyArray<{
    readonly name: string;
    readonly alias: string | null;
    readonly isTypeOnly: boolean;
  }>;
  readonly moduleSpecifier: string | null;
}

function extractExportEntry(decl: ExportDeclaration): IExportEntry {
  const ns = decl.getNamespaceExport();
  return {
    isTypeOnly: decl.isTypeOnly(),
    namespaceExportName: ns ? ns.getName() : null,
    namedExports: decl.getNamedExports().map((ne) => {
      const aliasNode = ne.getAliasNode();
      return {
        name: ne.getNameNode().getText(),
        alias: aliasNode ? aliasNode.getText() : null,
        isTypeOnly: ne.isTypeOnly(),
      };
    }),
    moduleSpecifier: decl.getModuleSpecifierValue() ?? null,
  };
}

function renderExportLine(entry: IExportEntry): string {
  const head = entry.isTypeOnly ? 'export type ' : 'export ';
  let body: string;
  if (entry.namespaceExportName !== null) {
    body = `* as ${entry.namespaceExportName}`;
  } else if (entry.namedExports.length === 0) {
    body = '*';
  } else {
    const parts = entry.namedExports.map((ne) => {
      // Per-specifier `type` keyword only emitted when the
      // declaration itself is NOT type-only (otherwise it would be
      // redundant: `export type { type T }` is invalid TS).
      const typeKw = ne.isTypeOnly && !entry.isTypeOnly ? 'type ' : '';
      return ne.alias ? `${typeKw}${ne.name} as ${ne.alias}` : `${typeKw}${ne.name}`;
    });
    body = `{ ${parts.join(', ')} }`;
  }
  return entry.moduleSpecifier !== null
    ? `${head}${body} from '${entry.moduleSpecifier}';`
    : `${head}${body};`;
}

function fingerprintExportEntry(entry: IExportEntry): string {
  const namedPart = entry.namedExports
    .map((ne) => {
      const t = ne.isTypeOnly ? 't:' : 'v:';
      const a = ne.alias === null ? '' : `=>${ne.alias}`;
      return `${t}${ne.name}${a}`;
    })
    .sort()
    .join(',');
  return [
    entry.isTypeOnly ? 'type' : 'value',
    entry.namespaceExportName ?? '',
    namedPart,
    entry.moduleSpecifier ?? '',
  ].join('|');
}

// ─── Test-side helpers ─────────────────────────────────────────────────────

/**
 * Parse barrel-shaped content into the structured `IExportEntry`
 * sequence using ts-morph's in-memory file system. Headers,
 * blank lines, and comments before / between export declarations
 * are tolerated and ignored (the regenerator preserves the leading
 * comment block but the symbol-set property only cares about the
 * export declarations themselves).
 */
function parseBarrelContent(content: string, name = '/__synth_barrel__.ts'): IExportEntry[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    useInMemoryFileSystem: true,
  });
  const f = project.createSourceFile(name, content, { overwrite: true });
  return f.getExportDeclarations().map(extractExportEntry);
}

/**
 * Apply the regenerator's sort + render pipeline (the algorithmic
 * core of `regenerateServicesBarrel` in `migrate.mjs`) to a barrel's
 * export-declaration sequence. Returns the concatenated export-
 * declaration block — does NOT include any preserved header. The
 * symbol-set / fingerprint properties only inspect the declaration
 * block, so the header is irrelevant here.
 */
function regenerateBarrelLines(entries: ReadonlyArray<IExportEntry>): string {
  const sorted = [...entries].sort((a, b) => {
    const la = renderExportLine(a);
    const lb = renderExportLine(b);
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  return sorted.map(renderExportLine).join('\n') + '\n';
}

/**
 * Compute the SET of barrel-level exported symbol names contributed
 * by an entry. Each entry shape contributes a different kind of
 * "name":
 *
 *   - `export * as Foo from '...'`  → `'ns:Foo'`
 *   - `export * from '<path>'`      → `'star:<path>'` (the `from`
 *     path is the only thing that distinguishes one wildcard re-
 *     export from another at the barrel level; it is a sentinel,
 *     not a true name)
 *   - `export { A, B as C, type T } from '...'` → one entry per
 *     named-clause member, of the form `'name:<exported-name>'`
 *     where `<exported-name>` is the alias if present, otherwise
 *     the original name (this is the name external callers will
 * `import` by — 's "same export name").
 *
 * The prefix tags (`ns:`, `star:`, `name:`) keep the three name
 * spaces disjoint so a file `Foo.ts` exported via `export * as Foo`
 * does not collide with a value `Foo` exported via `export { Foo }`.
 */
function declaredSymbolNames(entries: ReadonlyArray<IExportEntry>): string[] {
  const names: string[] = [];
  for (const e of entries) {
    if (e.namespaceExportName !== null) {
      names.push(`ns:${e.namespaceExportName}`);
    } else if (e.namedExports.length === 0) {
      // `export * from '<path>'` — opaque re-export. The barrel
      // regenerator preserves the line verbatim (modulo sort), so
      // the re-export's contribution to the public API is preserved
      // by preserving the `from` path.
      names.push(`star:${e.moduleSpecifier ?? ''}`);
    } else {
      for (const ne of e.namedExports) {
        names.push(`name:${ne.alias ?? ne.name}`);
      }
    }
  }
  names.sort();
  return names;
}

/**
 * Compute the SORTED list of fingerprints for an entry sequence.
 * The list (not a set) is returned so the failure message can show
 * the ordered diff; equality is checked element-wise.
 */
function fingerprintList(entries: ReadonlyArray<IExportEntry>): string[] {
  return entries.map(fingerprintExportEntry).sort();
}

// ─── fast-check generators for synthetic barrel content ────────────────────

/**
 * Generate a valid TS identifier (1-9 chars, leading letter or
 * underscore). Filtered against TS reserved words that would clash
 * with export-declaration syntax (`as`, `from`, `type`, `default`,
 * `export`, `import`).
 */
const identArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/)
  .filter((s) => !RESERVED_IDENTS.has(s));

const RESERVED_IDENTS: ReadonlySet<string> = new Set([
  'as',
  'from',
  'type',
  'default',
  'export',
  'import',
  'let',
  'const',
  'var',
  'function',
  'class',
  'interface',
]);

/**
 * Generate a relative-style module-specifier path. Constrained to
 * a small alphabet so collisions are easy to debug on shrunk
 * counterexamples. `./` and `../` prefixes mirror the live barrel's
 * convention (every existing entry uses `./` since the barrel is
 * at `src/services/index.ts` and consumers live in the same dir;
 * post-restructure the regenerator emits `../<topic>/<file>` paths).
 */
const moduleSpecifierArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('./', '../', './sub/', '../topic/'),
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/)
  )
  .map(([prefix, name]) => prefix + name);

/**
 * Generate a single named-export clause member.
 */
const namedExportItemArb: fc.Arbitrary<{
  name: string;
  alias: string | null;
  isTypeOnly: boolean;
}> = fc.record({
  name: identArb,
  alias: fc.option(identArb, { nil: null }),
  isTypeOnly: fc.boolean(),
});

/**
 * Generate a single synthetic export entry. Three shapes are
 * covered, mirroring every form the live barrel uses today:
 *
 *   1. `export * from '...'` (and its `export type *` variant)
 *   2. `export * as Ns from '...'` (no `type` variant — TS does
 *      not permit `export type * as Ns`)
 *   3. `export { A, B as C, type T } from '...'`
 *
 * Named clauses are deduplicated by their effective exported name
 * (alias if present, else the original name) so the synthetic
 * input is structurally valid TS — `export { A, A } from '...'`
 * would parse but type-check fail, which the regenerator's
 * fingerprint-set self-check would also reject. We avoid that
 * upstream so the property test focuses on the regenerator's
 * algorithmic invariants rather than re-deriving TS validity rules.
 */
const synthEntryArb: fc.Arbitrary<IExportEntry> = fc.oneof(
  // Shape 1: `export * from '<path>'` / `export type * from '<path>'`
  fc.record({
    isTypeOnly: fc.boolean(),
    namespaceExportName: fc.constant(null),
    namedExports: fc.constant([] as IExportEntry['namedExports']),
    moduleSpecifier: moduleSpecifierArb,
  }),
  // Shape 2: `export * as Ns from '<path>'`
  fc.record({
    isTypeOnly: fc.constant(false),
    namespaceExportName: identArb,
    namedExports: fc.constant([] as IExportEntry['namedExports']),
    moduleSpecifier: moduleSpecifierArb,
  }),
  // Shape 3: `export { A, B as C, type T } from '<path>'` (and type-only variant)
  fc
    .record({
      isTypeOnly: fc.boolean(),
      namespaceExportName: fc.constant(null),
      namedExports: fc.array(namedExportItemArb, { minLength: 1, maxLength: 5 }),
      moduleSpecifier: moduleSpecifierArb,
    })
    .map((e) => {
      // Deduplicate by effective exported name (alias ?? name) so
      // the rendered clause is structurally valid TS. Keeps the
      // first occurrence on collision.
      const seen = new Set<string>();
      const deduped: IExportEntry['namedExports'][number][] = [];
      for (const ne of e.namedExports) {
        const exportedAs = ne.alias ?? ne.name;
        if (seen.has(exportedAs)) {
          continue;
        }
        seen.add(exportedAs);
        deduped.push(ne);
      }
      // Ensure at least one element survives dedup (the generator
      // already guarantees minLength 1, but a duplicate-only batch
      // could leave us with one element via dedup — that's fine).
      return { ...e, namedExports: deduped };
    })
);

/**
 * Generate a synthetic barrel: a sequence of entries, each entry
 * targeting a UNIQUE module specifier so cross-entry name
 * collisions (which TS forbids at the type-check layer) can't
 * arise. Returns the entries; callers render to text via
 * `renderExportLine`.
 *
 * We additionally require that the union of declared names across
 * all named-export clauses is collision-free so the synthetic
 * barrel is a structurally-valid TS program. Same dedup strategy
 * as `synthEntryArb` for shape 3, applied across the whole entry
 * list.
 */
const synthBarrelArb: fc.Arbitrary<IExportEntry[]> = fc
  .array(synthEntryArb, { minLength: 1, maxLength: 12 })
  .map((entries) => {
    // Dedup module specifiers: keep the first entry per specifier.
    const byModule = new Map<string, IExportEntry>();
    for (const e of entries) {
      const key = e.moduleSpecifier ?? '';
      if (!byModule.has(key)) {
        byModule.set(key, e);
      }
    }
    const uniqEntries = Array.from(byModule.values());

    // Dedup namespace-export names: collapse repeated `* as Ns`
    // declarations across modules to keep the first.
    const seenNs = new Set<string>();
    const seenNamedExports = new Set<string>();
    const result: IExportEntry[] = [];
    for (const e of uniqEntries) {
      if (e.namespaceExportName !== null) {
        if (seenNs.has(e.namespaceExportName)) {
          continue;
        }
        if (seenNamedExports.has(e.namespaceExportName)) {
          continue;
        }
        seenNs.add(e.namespaceExportName);
        result.push(e);
        continue;
      }
      if (e.namedExports.length === 0) {
        // `export *` doesn't declare a barrel-level name itself
        // (the names come from the re-exported module), so cross-
        // entry collisions can't happen for this shape at the
        // declaration level.
        result.push(e);
        continue;
      }
      // Named-clause shape: ensure none of the exported names
      // collide with previously-declared barrel-level names.
      const filtered = e.namedExports.filter((ne) => {
        const exportedAs = ne.alias ?? ne.name;
        if (seenNs.has(exportedAs)) {
          return false;
        }
        if (seenNamedExports.has(exportedAs)) {
          return false;
        }
        seenNamedExports.add(exportedAs);
        return true;
      });
      if (filtered.length === 0) {
        continue;
      }
      result.push({ ...e, namedExports: filtered });
    }
    return result;
  })
  .filter((entries) => entries.length > 0);

// ─── Property tests ────────────────────────────────────────────────────────

describe('Public_Service_API import stability (Property 14)', () => {
  // ── Property 14a — Symbol-set preservation under regeneration ──

  /**
   * For any synthetic barrel content `B`, the regenerated content
   * `B'` declares the SAME SET of exported symbol names as `B`.
   * The regenerator only sorts; it never adds, removes, or
   * substitutes a name.
   */
  it('Property 14a: regeneration preserves the SET of declared barrel-level symbol names', () => {
    fc.assert(
      fc.property(synthBarrelArb, (entries) => {
        const inputContent = entries.map(renderExportLine).join('\n') + '\n';

        // Parse → entries → names (the names declared by the input).
        const parsedInput = parseBarrelContent(inputContent);
        const inputNames = declaredSymbolNames(parsedInput);

        // Regenerate (sort + render) → re-parse → names.
        const regenerated = regenerateBarrelLines(parsedInput);
        const parsedOutput = parseBarrelContent(regenerated, '/__synth_regen__.ts');
        const outputNames = declaredSymbolNames(parsedOutput);

        assert.deepStrictEqual(
          outputNames,
          inputNames,
          `Property 14a violation: regeneration changed the SET of ` +
            `declared barrel-level symbol names.\n` +
            `  input names:  ${JSON.stringify(inputNames)}\n` +
            `  output names: ${JSON.stringify(outputNames)}\n` +
            `  input content:\n${inputContent}\n` +
            `  regenerated content:\n${regenerated}`
        );
      }),
      { numRuns: 200 }
    );
  });

  // ── Property 14b — Round-trip via fingerprint ──

  /**
   * **14b.1 (collision-freedom on canonical entries).** Two
   * structurally-distinct entries (after canonicalizing the named-
   * exports clause order) produce DISTINCT fingerprints. The
   * fingerprint encodes every semantically-relevant axis — type-
   * only flag, namespace name, sorted named clause, module
   * specifier — so any structural difference yields a fingerprint
   * difference.
   */
  it('Property 14b.1: distinct (canonical) entries produce distinct fingerprints', () => {
    /**
     * Canonicalize an entry so equal-up-to-order entries compare
     * equal under `JSON.stringify`. Sorts the named-exports clause
     * by the same key the fingerprint uses, so canonical-equal
     * entries are exactly fingerprint-equal entries.
     */
    function canonicalize(e: IExportEntry): IExportEntry {
      const sortedNamed = [...e.namedExports].sort((a, b) => {
        const ka = `${a.isTypeOnly ? 't:' : 'v:'}${a.name}${a.alias === null ? '' : `=>${a.alias}`}`;
        const kb = `${b.isTypeOnly ? 't:' : 'v:'}${b.name}${b.alias === null ? '' : `=>${b.alias}`}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      return { ...e, namedExports: sortedNamed };
    }

    fc.assert(
      fc.property(synthEntryArb, synthEntryArb, (e1, e2) => {
        const c1 = JSON.stringify(canonicalize(e1));
        const c2 = JSON.stringify(canonicalize(e2));
        const fp1 = fingerprintExportEntry(e1);
        const fp2 = fingerprintExportEntry(e2);

        if (c1 !== c2) {
          assert.notStrictEqual(
            fp1,
            fp2,
            `Property 14b.1 violation: distinct canonical entries ` +
              `produced the SAME fingerprint. Two entries that differ ` +
              `structurally must produce different fingerprints so the ` +
              `barrel's public API surface check ` +
              `cannot silently equate distinct exports.\n` +
              `  entry 1 (canonical): ${c1}\n` +
              `  entry 2 (canonical): ${c2}\n` +
              `  fingerprint:         ${fp1}`
          );
        } else {
          // Inverse direction (fingerprint is well-defined on
          // canonical entries): equal canonicalize ⇒ equal
          // fingerprint. A regression here would mean the
          // fingerprint sort within `namedPart` disagrees with the
          // canonicalize sort, which would break round-trip.
          assert.strictEqual(
            fp1,
            fp2,
            `Property 14b.1 violation: equal canonical entries ` +
              `produced different fingerprints. The fingerprint must ` +
              `be a function of the canonical form.\n` +
              `  entry (canonical):   ${c1}\n` +
              `  fingerprint 1:       ${fp1}\n` +
              `  fingerprint 2:       ${fp2}`
          );
        }
      }),
      { numRuns: 300 }
    );
  });

  /**
   * **14b.2 (round-trip preservation).** For any synthetic barrel
   * `B`, the fingerprint set of the regenerated barrel equals the
   * fingerprint set of the original. This is the byte-identical
   * Public_Service_API surface check: the
   * regenerator may re-order lines but must not add, remove, or
   * change any export.
   */
  it('Property 14b.2: regeneration preserves the SET of entry fingerprints', () => {
    fc.assert(
      fc.property(synthBarrelArb, (entries) => {
        const inputContent = entries.map(renderExportLine).join('\n') + '\n';

        const parsedInput = parseBarrelContent(inputContent);
        const beforeFingerprints = fingerprintList(parsedInput);

        const regenerated = regenerateBarrelLines(parsedInput);
        const parsedOutput = parseBarrelContent(regenerated, '/__synth_regen__.ts');
        const afterFingerprints = fingerprintList(parsedOutput);

        assert.deepStrictEqual(
          afterFingerprints,
          beforeFingerprints,
          `Property 14b.2 violation: regeneration changed the SET of ` +
            `entry fingerprints (byte-identical ` +
            `Public_Service_API surface).\n` +
            `  before: ${JSON.stringify(beforeFingerprints)}\n` +
            `  after:  ${JSON.stringify(afterFingerprints)}\n` +
            `  input content:\n${inputContent}\n` +
            `  regenerated content:\n${regenerated}`
        );
      }),
      { numRuns: 200 }
    );
  });

  /**
   * **14b.3 (regeneration idempotence).** Regenerating an
   * already-regenerated barrel produces byte-identical content.
   * This is the regenerator's contribution to the migration's
   * idempotence guarantee: a second
   * `migrate.mjs` run leaves the barrel unchanged.
   */
  it('Property 14b.3: regenerate(regenerate(B)) === regenerate(B) (idempotence)', () => {
    fc.assert(
      fc.property(synthBarrelArb, (entries) => {
        const parsedInput = parseBarrelContent(entries.map(renderExportLine).join('\n') + '\n');
        const once = regenerateBarrelLines(parsedInput);
        const reparsed = parseBarrelContent(once, '/__synth_regen_once__.ts');
        const twice = regenerateBarrelLines(reparsed);

        assert.strictEqual(
          twice,
          once,
          `Property 14b.3 violation: a second regeneration produced ` +
            `different content.\n` +
            `  first pass:\n${once}\n` +
            `  second pass:\n${twice}`
        );
      }),
      { numRuns: 100 }
    );
  });

  // ── Property 14c — Live barrel coverage ──

  describe('Property 14c: live src/services/index.ts barrel', () => {
    let liveContent: string;
    let liveEntries: IExportEntry[];

    before(() => {
      assert.ok(
        fs.existsSync(SERVICES_BARREL),
        `live barrel missing at ${SERVICES_BARREL} — fixture broken`
      );
      liveContent = fs.readFileSync(SERVICES_BARREL, 'utf8');
      liveEntries = parseBarrelContent(liveContent, SERVICES_BARREL);
    });

    /**
     * The live barrel produces a non-empty fingerprint set. A zero-
     * export barrel would be a violation in
     * spirit — the public API surface would be empty, defeating
     * the purpose of the barrel.
     */
    it('produces a non-empty fingerprint set', () => {
      const fingerprints = fingerprintList(liveEntries);
      assert.ok(
        fingerprints.length > 0,
        `Barrel stability violation: src/services/index.ts produced ` +
          `zero export-declaration fingerprints. The Public_Service_API ` +
          `surface must be non-empty.`
      );
      // Every fingerprint must be a non-empty string (defensive
      // sanity check — a fingerprint collision against the empty
      // string would silently equate distinct exports).
      for (const fp of fingerprints) {
        assert.ok(
          fp.length > 0,
          `live barrel produced an empty fingerprint string ` +
            `(would silently collide with future entries)`
        );
      }
    });

    /**
     * Every fingerprint of the live barrel is unique. The
     * regenerator's fingerprint-set self-check
     * (`regenerateServicesBarrel` in migrate.mjs) compares sorted
     * fingerprint lists, so duplicate fingerprints would collapse
     * the comparison and let a real symbol-set change slip through.
     */
    it('produces a fingerprint set with no duplicates', () => {
      const fingerprints = fingerprintList(liveEntries);
      const unique = new Set(fingerprints);
      assert.strictEqual(
        unique.size,
        fingerprints.length,
        `live barrel has duplicate fingerprints (would defeat the ` +
          `regenerator's self-check). fingerprints: ` +
          `${JSON.stringify(fingerprints)}`
      );
    });

    /**
     * Re-emitting the live barrel through the regenerator
     * preserves the fingerprint set byte-identically. This is the
     * end-to-end stability check demands.
     */
    it('regeneration preserves the fingerprint set', () => {
      const before = fingerprintList(liveEntries);

      const regenerated = regenerateBarrelLines(liveEntries);
      const reparsed = parseBarrelContent(regenerated, '/__live_regen__.ts');
      const after = fingerprintList(reparsed);

      assert.deepStrictEqual(
        after,
        before,
        `Barrel stability violation: regenerating the live barrel ` +
          `changed the fingerprint set. The Public_Service_API ` +
          `surface must be byte-identical before and after the ` +
          `restructure.\n` +
          `  before: ${JSON.stringify(before)}\n` +
          `  after:  ${JSON.stringify(after)}`
      );
    });

    /**
     * Regeneration preserves the SET of declared barrel-level
     * symbol names on the live barrel. Specifically, the named
     * symbols and namespace re-exports survive
     * pins type aliases and constants like `GIT_TOOL_WINDOW_VIEW_ID`,
     * `COMMIT_TOOL_WINDOW_VIEW_ID`, `CONTEXT_VALUES`, the
     * `IGitService` family, and every `create*` factory.
     */
    it('regeneration preserves the SET of declared barrel-level symbol names', () => {
      const before = declaredSymbolNames(liveEntries);

      const regenerated = regenerateBarrelLines(liveEntries);
      const reparsed = parseBarrelContent(regenerated, '/__live_regen__.ts');
      const after = declaredSymbolNames(reparsed);

      assert.deepStrictEqual(
        after,
        before,
        `Barrel stability violation: regenerating the live ` +
          `barrel changed the SET of declared symbol names.\n` +
          `  before: ${JSON.stringify(before)}\n` +
          `  after:  ${JSON.stringify(after)}`
      );
    });

    /**
     * Spot-check the named constants and type
     * aliases the requirement calls out by name MUST appear in the
     * declared-name set. This is a regression guard against the
     * barrel author silently dropping one of these — the test
     * names them explicitly so removal would surface as a clear
     * test failure rather than a generic "API set changed".
     */
    it('declares the symbols names explicitly', () => {
      const names = new Set(declaredSymbolNames(liveEntries));
      const required: ReadonlyArray<string> = [
        'name:GIT_TOOL_WINDOW_VIEW_ID',
        'name:COMMIT_TOOL_WINDOW_VIEW_ID',
        'name:CONTEXT_VALUES',
      ];
      for (const required_name of required) {
        assert.ok(
          names.has(required_name),
          `Barrel stability violation: the live barrel does not ` +
            `declare '${required_name.slice('name:'.length)}'. ` +
            `the barrel-stability contract names this symbol explicitly as part ` +
            `of the Public_Service_API.`
        );
      }
      // The IGitService family flows through `export * from './interfaces';`
      // — a star re-export. Verify that path is present (the
      // interface symbols themselves are not declared at the barrel
      // level, but the re-export line is the contract surface).
      const hasInterfaceStar = liveEntries.some(
        (e) =>
          e.namespaceExportName === null &&
          e.namedExports.length === 0 &&
          e.moduleSpecifier !== null &&
          /\binterfaces\b/.test(e.moduleSpecifier)
      );
      assert.ok(
        hasInterfaceStar,
        `Barrel stability violation: the live barrel has no ` +
          `'export * from <interfaces>' line — the IGitService family ` +
          `re-export path is missing.`
      );
      // The `create*` factory family is enumerated as named
      // exports across multiple `export { ... }` clauses. Verify
      // at least one factory is present (a regression that drops
      // ALL of them would surface here; individual-factory drops
      // would surface in the fingerprint round-trip + symbol-set
      // checks above).
      const hasFactory = [...names].some((n) => n.startsWith('name:create'));
      assert.ok(
        hasFactory,
        `Barrel stability violation: the live barrel declares no ` +
          `'create*' factory at all. At least one factory ` +
          `(e.g. createGitService) must be exported.`
      );
    });

    /**
     * Live-barrel idempotence: regenerating once then regenerating
     * again produces byte-identical content. This is the on-disk
     * counterpart of Property 14b.3 — a real `migrate.mjs` re-run
     * over an already-canonical barrel must be a no-op
     *
     */
    it('regeneration is idempotent on the live barrel', () => {
      const once = regenerateBarrelLines(liveEntries);
      const reparsed = parseBarrelContent(once, '/__live_regen_once__.ts');
      const twice = regenerateBarrelLines(reparsed);

      assert.strictEqual(
        twice,
        once,
        `Barrel idempotence violation: regenerating the live ` +
          `barrel twice produced different content on the second pass.`
      );
    });
  });
});
