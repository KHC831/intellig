/**
 * ADR-003 forward-compat round trip against hostile field names.
 *
 * The unknown-field preservation exists so a file written by a NEWER IntelliG
 * survives a read/write cycle by an older one. It accumulates those fields by
 * copying `Object.keys(parsed)` into a fresh object — and `JSON.parse` makes
 * `__proto__` a real own key, so copying it into a plain `{}` invokes the
 * Object.prototype setter instead of creating a property. The key is then
 * silently dropped and the round-trip invariant fails on exactly the kind of
 * key it exists to preserve.
 */

import '../../setup';
import * as assert from 'assert';
import {
  migrateStorageForTest,
  serializeStorageForDisk,
} from '../../../src/changelists/ChangelistService';

/** Names that are Object.prototype keys, i.e. the ones a plain `{}` swallows. */
const HOSTILE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

describe('ADR-003 unknown-field preservation — hostile key names', () => {
  for (const key of HOSTILE_KEYS) {
    it(`round-trips a top-level "${key}" field written by a newer version`, () => {
      const onDisk = JSON.parse(
        JSON.stringify({
          version: 3,
          activeChangelistId: 'default',
          changelists: [],
          [key]: { some: 'future field' },
        })
      ) as Record<string, unknown>;

      const written = serializeStorageForDisk(migrateStorageForTest(onDisk));
      assert.ok(
        Object.keys(written).includes(key),
        `"${key}" must survive the round trip; written keys: ${JSON.stringify(Object.keys(written))}`
      );
    });

    it(`round-trips a per-changelist "${key}" field written by a newer version`, () => {
      const onDisk = JSON.parse(
        JSON.stringify({
          version: 3,
          activeChangelistId: 'default',
          changelists: [{ id: 'default', name: 'Changes', files: [], [key]: 'future value' }],
        })
      ) as Record<string, unknown>;

      const written = serializeStorageForDisk(migrateStorageForTest(onDisk));
      const item = (written.changelists as Array<Record<string, unknown>>)[0];
      assert.ok(
        Object.keys(item).includes(key),
        `"${key}" must survive on the item; written keys: ${JSON.stringify(Object.keys(item))}`
      );
    });
  }
});
