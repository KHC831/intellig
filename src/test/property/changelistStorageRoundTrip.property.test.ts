/**
 * TL-10 — property tests for ChangelistService storage round-trip.
 *
 * Invariant under test: `load → save` preserves every key in the on-disk
 * JSON that belongs to a newer version of the extension. If an older
 * version reads a file emitted by a newer version, persists it back out,
 * and the newer version reads it again, no forward-compat fields should
 * have been silently dropped.
 *
 * Pinned seed (below) captures the counter-example that motivated this
 * test: before TL-10, an unknown top-level key or unknown per-item key
 * was stripped by the migration step, so the subsequent save wrote back
 * a strictly narrower shape.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  migrateStorageForTest,
  serializeStorageForDisk,
} from '../../changelists/ChangelistService';

describe('ChangelistService storage round-trip — TL-10', () => {
  // ── Arbitraries ────────────────────────────────────────────────────────

  /** A short safe JSON-scalar for unknown-value fuzzing. */
  const unknownScalarArb: fc.Arbitrary<unknown> = fc.oneof(
    fc.string({ minLength: 0, maxLength: 12 }),
    fc.integer({ min: -100, max: 100 }),
    fc.boolean(),
    fc.constant(null)
  );

  /** A shallow Record<string, unknown> of arbitrary forward-compat fields. */
  const unknownRecordArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
    fc
      .string({ minLength: 1, maxLength: 8 })
      // Don't collide with our known keys — the whole point is to generate
      // fields the current schema doesn't recognise.
      .filter(
        (k) =>
          ![
            'version',
            'activeChangelistId',
            'changelists',
            'id',
            'name',
            'isDefault',
            'description',
            'files',
          ].includes(k)
      ),
    unknownScalarArb,
    { minKeys: 0, maxKeys: 4 }
  );

  /** A known changelist item merged with arbitrary unknown fields. */
  const itemArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    isDefault: fc.boolean(),
    description: fc.string({ minLength: 0, maxLength: 40 }),
    files: fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 6 }),
    unknown: unknownRecordArb,
  });

  interface IItem {
    id: string;
    name: string;
    isDefault: boolean;
    description: string;
    files: string[];
    unknown: Record<string, unknown>;
  }

  interface IPayload {
    version: number;
    activeChangelistId: string;
    items: IItem[];
    topLevelUnknown: Record<string, unknown>;
  }

  /** Full on-disk payload: known keys + extras at top level and per item. */
  const payloadArb: fc.Arbitrary<IPayload> = fc.record({
    version: fc.integer({ min: 1, max: 9 }),
    activeChangelistId: fc.string({ minLength: 1, maxLength: 12 }),
    items: fc.array(itemArb, { maxLength: 5 }),
    topLevelUnknown: unknownRecordArb,
  });

  function mkPayload(raw: IPayload): Record<string, unknown> {
    const items = raw.items.map((it) => ({
      id: it.id,
      name: it.name,
      isDefault: it.isDefault,
      description: it.description,
      files: it.files.slice(),
      ...it.unknown,
    }));
    return {
      version: raw.version,
      activeChangelistId: raw.activeChangelistId,
      changelists: items,
      ...raw.topLevelUnknown,
    };
  }

  // ── Properties ─────────────────────────────────────────────────────────

  it('round-trips unknown top-level keys unchanged', () => {
    fc.assert(
      fc.property(payloadArb, (raw) => {
        const onDisk = mkPayload(raw);
        const loaded = migrateStorageForTest(onDisk);
        const emitted = serializeStorageForDisk(loaded);

        // Every unknown top-level key must be preserved with identical value.
        for (const k of Object.keys(raw.topLevelUnknown)) {
          assert.deepStrictEqual(
            emitted[k],
            raw.topLevelUnknown[k],
            `top-level key "${k}" was dropped or mutated`
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it('round-trips unknown per-item keys unchanged', () => {
    fc.assert(
      fc.property(payloadArb, (raw) => {
        const onDisk = mkPayload(raw);
        const loaded = migrateStorageForTest(onDisk);
        const emitted = serializeStorageForDisk(loaded);

        const outItems = emitted.changelists as Array<Record<string, unknown>>;
        assert.strictEqual(outItems.length, raw.items.length);
        for (let i = 0; i < raw.items.length; i++) {
          const expected = raw.items[i].unknown;
          for (const k of Object.keys(expected)) {
            assert.deepStrictEqual(
              outItems[i][k],
              expected[k],
              `item[${i}] key "${k}" was dropped or mutated`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('does not emit the internal bookkeeping fields on disk', () => {
    fc.assert(
      fc.property(payloadArb, (raw) => {
        const onDisk = mkPayload(raw);
        const loaded = migrateStorageForTest(onDisk);
        const emitted = serializeStorageForDisk(loaded);

        // Bookkeeping fields exist in-memory but MUST NOT land in the JSON.
        assert.ok(
          !Object.prototype.hasOwnProperty.call(emitted, '_unknownTopLevel'),
          '_unknownTopLevel leaked to emitted JSON'
        );
        const outItems = emitted.changelists as Array<Record<string, unknown>>;
        for (const item of outItems) {
          assert.ok(
            !Object.prototype.hasOwnProperty.call(item, '_unknownItem'),
            '_unknownItem leaked to emitted JSON'
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  it('preserves every known field exactly across the round trip', () => {
    fc.assert(
      fc.property(payloadArb, (raw) => {
        const onDisk = mkPayload(raw);
        const loaded = migrateStorageForTest(onDisk);
        const emitted = serializeStorageForDisk(loaded);

        // Version is always re-stamped to the current schema version (v2).
        assert.strictEqual(emitted.version, 2);
        assert.strictEqual(emitted.activeChangelistId, raw.activeChangelistId);
        const outItems = emitted.changelists as Array<Record<string, unknown>>;
        assert.strictEqual(outItems.length, raw.items.length);
        for (let i = 0; i < raw.items.length; i++) {
          assert.strictEqual(outItems[i].id, raw.items[i].id);
          assert.strictEqual(outItems[i].name, raw.items[i].name);
          assert.strictEqual(outItems[i].isDefault, raw.items[i].isDefault);
          assert.strictEqual(outItems[i].description, raw.items[i].description);
          assert.deepStrictEqual(outItems[i].files, raw.items[i].files);
        }
      }),
      { numRuns: 100 }
    );
  });

  // ── Pinned regression ──────────────────────────────────────────────────

  it('pinned regression: top-level "schemaExtension" + per-item "labels" survive', () => {
    // This hand-crafted payload is the minimal counter-example to the
    // pre-TL-10 bug: both the top-level forward-compat marker and the
    // per-item metadata array should round-trip unchanged.
    const onDisk: Record<string, unknown> = {
      version: 3,
      activeChangelistId: 'default',
      changelists: [
        {
          id: 'default',
          name: 'Default Changelist',
          isDefault: true,
          description: '',
          files: ['src/a.ts', 'src/b.ts'],
          labels: ['release', 'wip'],
        },
        {
          id: 'feat-x',
          name: 'Feature X',
          isDefault: false,
          description: 'WIP',
          files: ['src/x.ts'],
          labels: [],
          priority: 7,
        },
      ],
      schemaExtension: { name: 'intellij-export', rev: 2 },
    };

    const loaded = migrateStorageForTest(onDisk);
    const emitted = serializeStorageForDisk(loaded);

    assert.deepStrictEqual(
      emitted.schemaExtension,
      { name: 'intellij-export', rev: 2 },
      'top-level unknown dropped'
    );
    const outItems = emitted.changelists as Array<Record<string, unknown>>;
    assert.deepStrictEqual(outItems[0].labels, ['release', 'wip']);
    assert.deepStrictEqual(outItems[1].labels, []);
    assert.strictEqual(outItems[1].priority, 7);
  });
});
