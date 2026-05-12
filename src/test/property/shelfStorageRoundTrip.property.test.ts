/**
 * TL-34 — property tests for ShelfService storage round-trip.
 *
 * Invariant under test: `load → save` preserves every key in the on-disk
 * JSON that belongs to a newer version of the extension. If an older
 * version reads a file emitted by a newer version, persists it back out,
 * and the newer version reads it again, no forward-compat fields should
 * have been silently dropped.
 *
 * Mirrors the TL-10 property suite for ChangelistService
 * (changelistStorageRoundTrip.property.test.ts) — same structure, same
 * invariants, adapted for the shelf storage shape.
 *
 * Pinned seed (below) captures a realistic counter-example: both a
 * top-level forward-compat marker and a per-item metadata field should
 * round-trip unchanged.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { migrateShelfStorageForTest, serializeShelfForDisk } from '../../services/ShelfService';

describe('ShelfService storage round-trip — TL-34', () => {
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
            // top-level known keys
            'version',
            'items',
            // per-item known keys
            'id',
            'name',
            'timestamp',
            'files',
            'unshelvedAt',
          ].includes(k)
      ),
    unknownScalarArb,
    { minKeys: 0, maxKeys: 4 }
  );

  /** A known shelf file entry. Per-file nesting is intentionally opaque. */
  const fileArb = fc.record({
    path: fc.string({ minLength: 1, maxLength: 24 }),
    originalContent: fc.string({ minLength: 0, maxLength: 64 }),
    patchContent: fc.string({ minLength: 0, maxLength: 128 }),
  });

  /** A known shelf item merged with arbitrary unknown fields. */
  const itemArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    timestamp: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    files: fc.array(fileArb, { maxLength: 3 }),
    unshelvedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    unknown: unknownRecordArb,
  });

  interface IFile {
    path: string;
    originalContent: string;
    patchContent: string;
  }

  interface IItem {
    id: string;
    name: string;
    timestamp: number;
    files: IFile[];
    unshelvedAt: number | undefined;
    unknown: Record<string, unknown>;
  }

  interface IPayload {
    version: number;
    items: IItem[];
    topLevelUnknown: Record<string, unknown>;
  }

  /** Full on-disk payload: known keys + extras at top level and per item. */
  const payloadArb: fc.Arbitrary<IPayload> = fc.record({
    version: fc.integer({ min: 1, max: 9 }),
    items: fc.array(itemArb, { maxLength: 5 }),
    topLevelUnknown: unknownRecordArb,
  });

  function mkPayload(raw: IPayload): Record<string, unknown> {
    const items = raw.items.map((it) => ({
      id: it.id,
      name: it.name,
      timestamp: it.timestamp,
      files: it.files.map((f) => ({ ...f })),
      ...(it.unshelvedAt !== undefined ? { unshelvedAt: it.unshelvedAt } : {}),
      ...it.unknown,
    }));
    return {
      version: raw.version,
      items,
      ...raw.topLevelUnknown,
    };
  }

  // ── Properties ─────────────────────────────────────────────────────────

  it('round-trips unknown top-level keys unchanged', () => {
    fc.assert(
      fc.property(payloadArb, (raw) => {
        const onDisk = mkPayload(raw);
        const loaded = migrateShelfStorageForTest(onDisk);
        const emitted = serializeShelfForDisk(loaded);

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
        const loaded = migrateShelfStorageForTest(onDisk);
        const emitted = serializeShelfForDisk(loaded);

        const outItems = emitted.items as Array<Record<string, unknown>>;
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
        const loaded = migrateShelfStorageForTest(onDisk);
        const emitted = serializeShelfForDisk(loaded);

        assert.ok(
          !Object.prototype.hasOwnProperty.call(emitted, '_unknownTopLevel'),
          '_unknownTopLevel leaked to emitted JSON'
        );
        const outItems = emitted.items as Array<Record<string, unknown>>;
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
        const loaded = migrateShelfStorageForTest(onDisk);
        const emitted = serializeShelfForDisk(loaded);

        // Version is always re-stamped to the current schema version.
        assert.strictEqual(emitted.version, 2);
        const outItems = emitted.items as Array<Record<string, unknown>>;
        assert.strictEqual(outItems.length, raw.items.length);
        for (let i = 0; i < raw.items.length; i++) {
          assert.strictEqual(outItems[i].id, raw.items[i].id);
          assert.strictEqual(outItems[i].name, raw.items[i].name);
          assert.strictEqual(outItems[i].timestamp, raw.items[i].timestamp);
          assert.deepStrictEqual(outItems[i].files, raw.items[i].files);
          if (raw.items[i].unshelvedAt !== undefined) {
            assert.strictEqual(outItems[i].unshelvedAt, raw.items[i].unshelvedAt);
          } else {
            assert.ok(
              !Object.prototype.hasOwnProperty.call(outItems[i], 'unshelvedAt'),
              'unshelvedAt should be absent when undefined'
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  // ── Pinned regression ──────────────────────────────────────────────────

  it('pinned regression: top-level "schemaExtension" + per-item "labels"/"priority" survive', () => {
    // Hand-crafted payload mirroring the TL-10 ChangelistService regression
    // seed — locks in the round-trip guarantee for shelf storage so a
    // forward-compat field introduced by a newer version isn't silently
    // dropped by an older version that happens to open the file.
    const onDisk: Record<string, unknown> = {
      version: 3,
      items: [
        {
          id: 'shelf-1',
          name: 'Feature WIP',
          timestamp: 1_700_000_000_000,
          files: [
            {
              path: 'src/a.ts',
              originalContent: 'old',
              patchContent: 'diff --git ...',
            },
          ],
          labels: ['release', 'wip'],
        },
        {
          id: 'shelf-2',
          name: 'Reviewer Fixes',
          timestamp: 1_700_000_100_000,
          files: [],
          unshelvedAt: 1_700_000_200_000,
          labels: [],
          priority: 7,
        },
      ],
      schemaExtension: { name: 'intellij-export', rev: 2 },
    };

    const loaded = migrateShelfStorageForTest(onDisk);
    const emitted = serializeShelfForDisk(loaded);

    assert.deepStrictEqual(
      emitted.schemaExtension,
      { name: 'intellij-export', rev: 2 },
      'top-level unknown dropped'
    );
    const outItems = emitted.items as Array<Record<string, unknown>>;
    assert.deepStrictEqual(outItems[0].labels, ['release', 'wip']);
    assert.deepStrictEqual(outItems[1].labels, []);
    assert.strictEqual(outItems[1].priority, 7);
    // Known optional field round-trips too.
    assert.strictEqual(outItems[1].unshelvedAt, 1_700_000_200_000);
  });
});
